import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { BROWSER_TUNNEL_PROTOCOL } from "@opencode-ai/protocol/groups/browser"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { once } from "node:events"
import { createServer } from "node:http"
import WebSocket, { WebSocketServer } from "ws"
import { BrowserTunnelError, openBrowserTunnel } from "../../src/node/browser/tunnel"

const sessionID = Session.ID.make("ses_client_tunnel")
const leaseID = Browser.LeaseID.make("brl_clienttunnel")

describe("browser tunnel", () => {
  test("enforces byte and frame windows and preserves both half-closes", async () => {
    const server = await tunnelServer()
    try {
      const opening = openBrowserTunnel({
        endpoint: server.endpoint,
        sessionID,
        leaseID,
        target: { host: BrowserTunnel.Host.make("target.example"), port: BrowserTunnel.Port.make(443) },
      })
      const socket = await server.connected
      const next = frameReader(socket)
      socket.send(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.ready" }), { binary: true })
      const open = await next()
      expect(open).toMatchObject({
        type: "control",
        message: {
          type: "browser.tunnel.open",
          sessionID,
          leaseID,
          target: { host: "target.example", port: 443 },
        },
      })
      socket.send(
        BrowserTunnelProtocol.encodeFromServer({
          type: "browser.tunnel.opened",
          receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
          receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
        }),
        { binary: true },
      )
      const tunnel = await opening

      let writeSettled = false
      const writing = new Promise<void>((resolve, reject) => {
        tunnel.write(Buffer.alloc(BrowserTunnelProtocol.InitialWindowBytes + 1, 7), (error) => {
          writeSettled = true
          if (error) reject(error)
          else resolve()
        })
      })
      const sent = []
      for (let index = 0; index < 4; index++) sent.push(await next())
      expect(sent.every((frame) => frame.type === "data" && frame.data.byteLength === 64 * 1_024)).toBe(true)
      await Bun.sleep(25)
      expect(writeSettled).toBe(false)

      socket.send(
        BrowserTunnelProtocol.encodeFromServer({
          type: "browser.tunnel.window",
          bytes: BrowserTunnel.WindowBytes.make(64 * 1_024),
          frames: BrowserTunnel.FrameWindow.make(1),
        }),
        { binary: true },
      )
      const final = await next()
      expect(final.type === "data" && final.data.byteLength).toBe(1)
      await writing

      const received = once(tunnel, "data")
      socket.send(BrowserTunnelProtocol.data(Buffer.from("from server")), { binary: true })
      expect(Buffer.from((await received)[0]).toString()).toBe("from server")
      expect(await next()).toEqual({
        type: "control",
        message: {
          type: "browser.tunnel.window",
          bytes: Buffer.byteLength("from server"),
          frames: 1,
        },
      })

      const localEnd = next()
      tunnel.end()
      expect(await localEnd).toEqual({ type: "control", message: { type: "browser.tunnel.end" } })
      const remoteEnd = once(tunnel, "end")
      socket.send(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.end" }), { binary: true })
      await remoteEnd
    } finally {
      await server.close()
    }
  })

  test("rejects window credit that does not exactly match complete frames", async () => {
    const server = await tunnelServer()
    try {
      const opening = openBrowserTunnel({
        endpoint: server.endpoint,
        sessionID,
        leaseID,
        target: { host: BrowserTunnel.Host.make("target.example"), port: BrowserTunnel.Port.make(80) },
      })
      const socket = await server.connected
      const next = frameReader(socket)
      socket.send(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.ready" }), { binary: true })
      await next()
      socket.send(
        BrowserTunnelProtocol.encodeFromServer({
          type: "browser.tunnel.opened",
          receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
          receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
        }),
        { binary: true },
      )
      const tunnel = await opening
      await new Promise<void>((resolve, reject) =>
        tunnel.write(Buffer.from("frame"), (error) => (error ? reject(error) : resolve())),
      )
      await next()
      const failed = once(tunnel, "error")
      socket.send(
        BrowserTunnelProtocol.encodeFromServer({
          type: "browser.tunnel.window",
          bytes: BrowserTunnel.WindowBytes.make(4),
          frames: BrowserTunnel.FrameWindow.make(1),
        }),
        { binary: true },
      )
      const error = (await failed)[0]
      if (!(error instanceof BrowserTunnelError)) throw new Error("expected browser tunnel error")
      expect(error.code).toBe("protocol_error")
      expect(await next()).toEqual({
        type: "control",
        message: { type: "browser.tunnel.reset", code: "protocol_error" },
      })
    } finally {
      await server.close()
    }
  })
})

async function tunnelServer() {
  const authorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`
  const http = createServer()
  const webSockets = new WebSocketServer({ noServer: true })
  let resolveConnected!: (socket: WebSocket) => void
  const connected = new Promise<WebSocket>((resolve) => {
    resolveConnected = resolve
  })
  webSockets.once("connection", resolveConnected)
  http.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/api/browser/tunnel" ||
      request.headers.authorization !== authorization ||
      request.headers["sec-websocket-protocol"] !== BROWSER_TUNNEL_PROTOCOL
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (address === null || typeof address === "string") throw new Error("browser tunnel server did not bind TCP")
  return {
    connected,
    endpoint: {
      url: `http://127.0.0.1:${address.port}`,
      authorization,
    },
    async close() {
      webSockets.clients.forEach((socket) => socket.terminate())
      webSockets.close()
      http.closeAllConnections()
      http.close()
      await Bun.sleep(10)
    },
  }
}

function frameReader(socket: WebSocket) {
  const queued: Array<{ readonly data: WebSocket.RawData; readonly binary: boolean }> = []
  const waiting: Array<(message: { readonly data: WebSocket.RawData; readonly binary: boolean }) => void> = []
  socket.on("message", (data, binary) => {
    const resolve = waiting.shift()
    if (resolve) resolve({ data, binary })
    else queued.push({ data, binary })
  })
  return async () => {
    const message =
      queued.shift() ??
      (await new Promise<{ readonly data: WebSocket.RawData; readonly binary: boolean }>((resolve) =>
        waiting.push(resolve),
      ))
    if (!message.binary) throw new Error("Expected a binary browser tunnel frame")
    return Effect.runPromise(BrowserTunnelProtocol.decodeFromDesktop(rawData(message.data)))
  }
}

function rawData(data: WebSocket.RawData) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
