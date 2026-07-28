import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { BROWSER_TUNNEL_PROTOCOL } from "@opencode-ai/protocol/groups/browser"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Schema } from "effect"
import { Duplex } from "node:stream"
import WebSocket from "ws"

export type BrowserTunnelEndpoint = {
  readonly url: string
  readonly authorization?: string
  readonly fetch?: typeof globalThis.fetch
}

export type BrowserTunnelOpen = {
  readonly endpoint: BrowserTunnelEndpoint
  readonly sessionID: Session.ID
  readonly leaseID: Browser.LeaseID
  readonly target: BrowserTunnel.Target
  readonly signal?: AbortSignal
}

export class BrowserTunnelError extends Error {
  constructor(
    readonly code: BrowserTunnel.OpenErrorCode | BrowserTunnel.ResetCode | "transport",
    message: string,
  ) {
    super(message)
    this.name = "BrowserTunnelError"
  }
}

/** Opens one flow-controlled WebSocket tunnel and exposes it as a single TCP-like stream. */
export async function openBrowserTunnel(input: BrowserTunnelOpen): Promise<Duplex> {
  const tunnel = new BrowserTunnelStream(input)
  await tunnel.opened
  return tunnel
}

class BrowserTunnelStream extends Duplex {
  readonly opened: Promise<void>
  readonly connecting = false
  private resolveOpened!: () => void
  private rejectOpened!: (error: Error) => void
  private readonly socket: WebSocket
  private readonly signal?: AbortSignal
  private state: "ready" | "opening" | "open" | "closed" = "ready"
  private inbound = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private sendWindowBytes = 0
  private sendWindowFrames = 0
  private readonly outstanding: number[] = []
  private activeWrite?: { readonly data: Buffer; offset: number; readonly callback: (error?: Error | null) => void }
  private sending = false
  private receiveWindowBytes = BrowserTunnelProtocol.InitialWindowBytes
  private receiveWindowFrames = BrowserTunnelProtocol.InitialFrameWindow
  private heldWindowBytes = 0
  private heldWindowFrames = 0
  private paused = false
  private localEnded = false
  private remoteEnded = false
  private remoteReset = false
  private resetCode: BrowserTunnel.ResetCode = "cancelled"

  constructor(input: BrowserTunnelOpen) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: BrowserTunnelProtocol.InitialWindowBytes,
      writableHighWaterMark: BrowserTunnelProtocol.InitialWindowBytes,
    })
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve
      this.rejectOpened = reject
    })
    this.on("error", () => undefined)
    this.signal = input.signal
    this.socket = new WebSocket(endpointURL(input.endpoint), BROWSER_TUNNEL_PROTOCOL, {
      ...(input.endpoint.authorization ? { headers: { Authorization: input.endpoint.authorization } } : {}),
      handshakeTimeout: 10_000,
      maxPayload: Math.max(BrowserTunnelProtocol.MaxDataBytes, BrowserTunnelProtocol.MaxControlBytes) + 1,
      perMessageDeflate: false,
      followRedirects: false,
    })
    this.timer = setTimeout(
      () => this.fail(new BrowserTunnelError("transport", "Browser tunnel handshake timed out.")),
      15_000,
    )
    this.timer.unref()
    this.socket.on("message", (data, binary) => {
      this.socket.pause()
      const processing = this.inbound.then(
        () => this.receive(input, data, binary),
        () => this.receive(input, data, binary),
      )
      this.inbound = processing
      void processing.then(
        () => {
          if (this.inbound === processing && !this.paused && this.socket.readyState === WebSocket.OPEN) {
            this.socket.resume()
          }
        },
        (error) =>
          this.fail(new BrowserTunnelError("transport", error instanceof Error ? error.message : String(error))),
      )
    })
    this.socket.on("error", (error) => this.fail(new BrowserTunnelError("transport", error.message)))
    this.socket.on("close", (code, reason) => {
      if (this.state === "closed") return
      if (this.localEnded && this.remoteEnded) {
        this.state = "closed"
        this.destroy()
        return
      }
      this.fail(new BrowserTunnelError("transport", `Browser tunnel closed (${code}): ${reason.toString()}`))
    })
    this.signal?.addEventListener("abort", this.onAbort, { once: true })
    if (this.signal?.aborted) this.onAbort()
  }

  override _read() {
    if (!this.paused) return
    this.paused = false
    this.releaseReceiveWindow()
    if (this.socket.readyState === WebSocket.OPEN) this.socket.resume()
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const data = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk
    if (this.state !== "open" || this.localEnded) {
      callback(new BrowserTunnelError("transport", "Browser tunnel is not writable."))
      return
    }
    if (data.byteLength === 0) {
      callback()
      return
    }
    this.activeWrite = { data, offset: 0, callback }
    this.pumpWrite()
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.state !== "open" || this.localEnded) {
      callback(new BrowserTunnelError("transport", "Browser tunnel is not writable."))
      return
    }
    this.send(BrowserTunnelProtocol.encodeFromDesktop({ type: "browser.tunnel.end" }), (error) => {
      if (error) {
        callback(error)
        this.fail(new BrowserTunnelError("transport", error.message))
        return
      }
      this.localEnded = true
      callback()
      this.finish()
    })
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer)
    this.signal?.removeEventListener("abort", this.onAbort)
    if (this.state === "closed") {
      callback(error)
      return
    }
    const opened = this.state === "open"
    this.state = "closed"
    const pending = this.activeWrite
    this.activeWrite = undefined
    pending?.callback(error ?? new BrowserTunnelError("cancelled", "Browser tunnel was closed."))
    if (
      !opened ||
      this.remoteReset ||
      this.socket.readyState !== WebSocket.OPEN ||
      (this.localEnded && this.remoteEnded)
    ) {
      this.socket.terminate()
      callback(error)
      return
    }
    this.socket.send(
      BrowserTunnelProtocol.encodeFromDesktop({ type: "browser.tunnel.reset", code: this.resetCode }),
      { binary: true },
      () => {
        this.socket.close(1000)
      },
    )
    const terminate = setTimeout(() => this.socket.terminate(), 1_000)
    terminate.unref()
    callback(error)
  }

  setKeepAlive() {
    return this
  }

  setNoDelay() {
    return this
  }

  setTimeout(_timeout: number, callback?: () => void) {
    if (callback) this.once("timeout", callback)
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  private async receive(input: BrowserTunnelOpen, data: WebSocket.RawData, binary: boolean) {
    if (!binary) return this.protocolFailure("Browser tunnel frames must be binary.")
    const frame = await Effect.runPromise(BrowserTunnelProtocol.decodeFromServer(rawData(data))).catch(() => undefined)
    if (!frame || this.state === "closed") return this.protocolFailure("Browser tunnel frame is invalid.")
    if (frame.type === "data") {
      if (this.state !== "open" || this.remoteEnded) return this.protocolFailure("Unexpected browser tunnel data.")
      if (frame.data.byteLength > this.receiveWindowBytes || this.receiveWindowFrames === 0) {
        return this.protocolFailure("Browser tunnel receive window was exceeded.")
      }
      this.receiveWindowBytes -= frame.data.byteLength
      this.receiveWindowFrames--
      this.heldWindowBytes += frame.data.byteLength
      this.heldWindowFrames++
      if (!this.push(frame.data)) {
        this.paused = true
        return
      }
      this.releaseReceiveWindow()
      return
    }
    const message = frame.message
    if (message.type === "browser.tunnel.ready") {
      if (this.state !== "ready") return this.protocolFailure("Browser tunnel sent duplicate ready.")
      this.state = "opening"
      this.send(
        BrowserTunnelProtocol.encodeFromDesktop({
          type: "browser.tunnel.open",
          sessionID: input.sessionID,
          leaseID: input.leaseID,
          target: input.target,
          receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
          receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
        }),
        (error) => {
          if (error) this.fail(new BrowserTunnelError("transport", error.message))
        },
      )
      return
    }
    if (message.type === "browser.tunnel.opened") {
      if (this.state !== "opening") return this.protocolFailure("Unexpected browser tunnel opened message.")
      this.state = "open"
      this.sendWindowBytes = message.receiveWindow
      this.sendWindowFrames = message.receiveFrames
      if (this.timer) clearTimeout(this.timer)
      this.resolveOpened()
      this.pumpWrite()
      return
    }
    if (message.type === "browser.tunnel.rejected") {
      if (this.state !== "opening") return this.protocolFailure("Unexpected browser tunnel rejection.")
      this.fail(new BrowserTunnelError(message.code, message.message))
      return
    }
    if (message.type === "browser.tunnel.window") {
      if (this.state !== "open" || message.frames > this.outstanding.length) {
        return this.protocolFailure("Unexpected browser tunnel window update.")
      }
      const bytes = this.outstanding.slice(0, message.frames).reduce((total, size) => total + size, 0)
      if (bytes !== message.bytes)
        return this.protocolFailure("Browser tunnel window update does not match sent frames.")
      this.outstanding.splice(0, message.frames)
      this.sendWindowBytes += message.bytes
      this.sendWindowFrames += message.frames
      this.pumpWrite()
      return
    }
    if (message.type === "browser.tunnel.end") {
      if (this.state !== "open" || this.remoteEnded) return this.protocolFailure("Unexpected browser tunnel end.")
      this.remoteEnded = true
      this.push(null)
      this.finish()
      return
    }
    this.remoteReset = true
    this.fail(new BrowserTunnelError(message.code, `Browser tunnel was reset: ${message.code}`))
  }

  private pumpWrite() {
    const write = this.activeWrite
    if (!write || this.sending || this.state !== "open") return
    if (this.sendWindowBytes === 0 || this.sendWindowFrames === 0) return
    const size = Math.min(
      BrowserTunnelProtocol.MaxDataBytes,
      this.sendWindowBytes,
      write.data.byteLength - write.offset,
    )
    this.sendWindowBytes -= size
    this.sendWindowFrames--
    this.outstanding.push(size)
    this.sending = true
    this.send(BrowserTunnelProtocol.data(write.data.subarray(write.offset, write.offset + size)), (error) => {
      this.sending = false
      if (this.activeWrite !== write) return
      if (error) {
        this.activeWrite = undefined
        write.callback(error)
        this.fail(new BrowserTunnelError("transport", error.message))
        return
      }
      write.offset += size
      if (write.offset === write.data.byteLength) {
        this.activeWrite = undefined
        write.callback()
        return
      }
      this.pumpWrite()
    })
  }

  private releaseReceiveWindow() {
    if (this.heldWindowFrames === 0 || this.state !== "open") return
    const bytes = this.heldWindowBytes
    const frames = this.heldWindowFrames
    this.heldWindowBytes = 0
    this.heldWindowFrames = 0
    this.receiveWindowBytes += bytes
    this.receiveWindowFrames += frames
    this.send(
      BrowserTunnelProtocol.encodeFromDesktop({
        type: "browser.tunnel.window",
        bytes: BrowserTunnel.WindowBytes.make(bytes),
        frames: BrowserTunnel.FrameWindow.make(frames),
      }),
      (error) => {
        if (error) this.fail(new BrowserTunnelError("transport", error.message))
      },
    )
  }

  private send(frame: Uint8Array, callback: (error?: Error) => void) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      callback(new Error("Browser tunnel WebSocket is not open."))
      return
    }
    this.socket.send(frame, { binary: true }, callback)
  }

  private protocolFailure(message: string) {
    this.fail(new BrowserTunnelError("protocol_error", message))
  }

  private fail(error: BrowserTunnelError) {
    if (this.state === "closed") return
    if (Schema.is(BrowserTunnel.ResetCode)(error.code)) this.resetCode = error.code
    if (this.state !== "open") this.rejectOpened(error)
    this.destroy(error)
  }

  private finish() {
    if (!this.localEnded || !this.remoteEnded || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.close(1000)
  }

  private readonly onAbort = () => {
    this.fail(new BrowserTunnelError("cancelled", "Browser tunnel was cancelled."))
  }
}

function endpointURL(endpoint: BrowserTunnelEndpoint) {
  const url = new URL(endpoint.url)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new TypeError("Browser server endpoint must be an HTTP URL without embedded credentials")
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/api/browser/tunnel"
  url.search = ""
  url.hash = ""
  return url
}

function rawData(data: WebSocket.RawData) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
