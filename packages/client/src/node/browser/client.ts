import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { BROWSER_CONTROL_PROTOCOL } from "@opencode-ai/protocol/groups/browser"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Schema } from "effect"
import WebSocket from "ws"
import type { ClientOptions } from "../../promise/generated/client.js"
import {
  browserDriverFactory,
  type BrowserDriver,
  type BrowserDriverContext,
  type BrowserDriverInstance,
  type BrowserProxy,
} from "./driver.js"
import { createBrowserProxy } from "./proxy.js"
import { openBrowserTunnel, type BrowserTunnelEndpoint } from "./tunnel.js"

export interface BrowserAttachOptions<Resource> {
  readonly sessionID: string
  readonly driver: BrowserDriver<Resource>
  readonly signal?: AbortSignal
}

export interface BrowserAttachment<Resource> extends AsyncDisposable {
  readonly resource: Resource
  readonly close: () => Promise<void>
}

export interface BrowserClient {
  readonly attach: <Resource>(options: BrowserAttachOptions<Resource>) => Promise<BrowserAttachment<Resource>>
}

type ProxyServer = Awaited<ReturnType<typeof createBrowserProxy>>

type AttachmentRecord = {
  readonly sessionID: Session.ID
  readonly leaseID: Browser.LeaseID
  readonly abort: AbortController
  readonly setup: Promise<void>
  readonly finishSetup: () => void
  readonly externalSignal?: AbortSignal
  externalAbort?: () => void
  active: boolean
  closed: boolean
  state?: Browser.State
  execute?: BrowserDriverInstance<unknown>["execute"]
  dispose?: BrowserDriverInstance<unknown>["dispose"]
  unsubscribe?: () => void
  proxy?: ProxyServer
  closing?: Promise<void>
}

type ActiveAttachment = AttachmentRecord & {
  readonly active: true
  readonly state: Browser.State
  readonly execute: BrowserDriverInstance<unknown>["execute"]
}

type Waiter = {
  readonly key: string
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly abort: () => void
}

/** Creates the Node-only browser host attached to one immutable server endpoint. */
export function createBrowserClient(options: ClientOptions): BrowserClient {
  const control = new BrowserClientControl(endpoint(options))
  return { attach: (input) => control.attach(input) }
}

class BrowserClientControl {
  private readonly records = new Map<Session.ID, AttachmentRecord>()
  private readonly requests = new Map<
    BrowserControl.RequestID,
    { readonly leaseID: Browser.LeaseID; readonly abort: AbortController }
  >()
  private readonly waiters = new Set<Waiter>()
  private socket?: WebSocket
  private retry?: ReturnType<typeof setTimeout>
  private retryAttempt = 0
  private revision = 0
  private ready = false
  private opening?: Promise<void>
  private openingAbort?: AbortController
  private synced?: string
  private syncing?: { readonly revision: number; readonly snapshot: string; readonly leases: Set<string> }
  private syncedLeases = new Set<string>()
  private inbound = Promise.resolve()
  private failing = false

  constructor(private readonly server: BrowserTunnelEndpoint) {}

  async attach<Resource>(input: BrowserAttachOptions<Resource>): Promise<BrowserAttachment<Resource>> {
    if (!Schema.is(Session.ID)(input.sessionID)) throw new TypeError("Browser attachment requires a valid Session ID")
    if (input.signal?.aborted) throw abortError(input.signal, "Browser attachment was aborted")
    const sessionID = Session.ID.make(input.sessionID)
    if (this.records.has(sessionID)) throw new Error(`Browser is already attached to Session ${sessionID}`)
    if (this.records.size >= 16) throw new Error("A Node client cannot attach more than 16 browser Sessions")

    let finishSetup!: () => void
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve
    })
    const record: AttachmentRecord = {
      sessionID,
      leaseID: Browser.LeaseID.create(),
      abort: new AbortController(),
      setup,
      finishSetup,
      externalSignal: input.signal,
      active: false,
      closed: false,
    }
    this.records.set(sessionID, record)
    record.externalAbort = () => {
      void this.close(record, abortError(input.signal, "Browser attachment was aborted")).catch(() => undefined)
    }
    input.signal?.addEventListener("abort", record.externalAbort, { once: true })

    try {
      record.proxy = await createBrowserProxy({
        connect: async (target, signal) => {
          await this.waitForAttachment(record, signal)
          const tunnelSignal = AbortSignal.any([signal, record.abort.signal])
          if (tunnelSignal.aborted) throw abortError(tunnelSignal, "Browser tunnel was aborted")
          return openBrowserTunnel({
            endpoint: this.server,
            sessionID: record.sessionID,
            leaseID: record.leaseID,
            target,
            signal: tunnelSignal,
          })
        },
      })
      this.requireOpen(record)

      const instance = await createDriver(
        input.driver,
        { proxy: exposedProxy(record.proxy), signal: record.abort.signal },
        record.abort.signal,
      )
      if (instance !== null && typeof instance === "object" && typeof instance.dispose === "function") {
        record.dispose = () => instance.dispose()
      }
      if (
        instance === null ||
        typeof instance !== "object" ||
        typeof instance.state !== "function" ||
        typeof instance.subscribe !== "function" ||
        typeof instance.execute !== "function" ||
        typeof instance.dispose !== "function"
      ) {
        throw new TypeError("Browser driver factory returned an invalid driver instance")
      }
      record.execute = (command, options) => instance.execute(command, options)

      let receivedState = false
      record.unsubscribe = instance.subscribe((state) => {
        if (record.closed) return
        const next = contractState(state)
        if (!next) {
          void this.close(record, new TypeError("Browser driver published an invalid state")).catch(() => undefined)
          return
        }
        receivedState = true
        record.state = next
        if (record.active) this.changed()
      })
      if (typeof record.unsubscribe !== "function") {
        throw new TypeError("Browser driver subscribe must return an unsubscribe function")
      }
      const initial = contractState(instance.state())
      if (!initial) throw new TypeError("Browser driver returned an invalid initial state")
      if (!receivedState) record.state = initial
      this.requireOpen(record)

      record.active = true
      this.changed()
      record.finishSetup()
      await this.waitForAttachment(record, record.abort.signal)
      this.requireOpen(record)

      const close = () => this.close(record)
      return Object.freeze({
        resource: instance.resource,
        close,
        [Symbol.asyncDispose]: close,
      })
    } catch (error) {
      record.finishSetup()
      await this.close(record).catch(() => undefined)
      throw error
    }
  }

  private close(record: AttachmentRecord, reason = new Error("Browser attachment was closed")) {
    if (!record.closed) {
      record.closed = true
      record.active = false
      if (this.records.get(record.sessionID) === record) this.records.delete(record.sessionID)
      record.abort.abort(reason)
      this.syncedLeases.delete(attachmentKey(record.sessionID, record.leaseID))
      this.rejectAttachmentWaiters(record, reason)
      this.abortRequests(record.leaseID)
      this.changed()
    }
    if (record.closing) return record.closing
    record.closing = record.setup.then(async () => {
      if (record.externalAbort) record.externalSignal?.removeEventListener("abort", record.externalAbort)
      const unsubscribe = await cleanup(() => record.unsubscribe?.())
      const dispose = await cleanup(() => record.dispose?.())
      const proxy = await cleanup(() => record.proxy?.close())
      const failure = [unsubscribe, dispose, proxy].find(
        (result): result is { readonly ok: false; readonly error: unknown } => !result.ok,
      )
      if (failure) throw failure.error
    })
    return record.closing
  }

  private requireOpen(record: AttachmentRecord) {
    if (!record.closed && !record.abort.signal.aborted) return
    throw abortError(record.abort.signal, "Browser attachment was closed")
  }

  private changed() {
    if (this.failing) return
    if (this.attachments().length === 0) {
      this.stopControl()
      return
    }
    this.connect()
    this.publish()
  }

  private attachments() {
    return [...this.records.values()].filter(
      (record): record is ActiveAttachment =>
        record.active && record.state !== undefined && record.execute !== undefined && !record.closed,
    )
  }

  private connect() {
    if (this.socket || this.retry || this.opening || this.attachments().length === 0) return
    const abort = new AbortController()
    this.openingAbort = abort
    this.opening = this.open(abort.signal)
      .catch((error) => this.failControl(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        if (this.openingAbort !== abort) return
        this.openingAbort = undefined
        this.opening = undefined
      })
  }

  private async open(lifetime: AbortSignal) {
    if (process.versions.bun) {
      // TODO: Remove the HTTP auth probe once Bun exposes ws upgrade responses.
      // https://github.com/oven-sh/bun/issues/5951
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)])
      const response = await (this.server.fetch ?? globalThis.fetch)(new URL("/api/health", this.server.url), {
        headers: this.server.authorization ? { Authorization: this.server.authorization } : undefined,
        signal,
      }).catch(() => undefined)
      if (lifetime.aborted) return
      if (!response) {
        this.scheduleReconnect()
        return
      }
      if (response.status === 401 || response.status === 403) {
        this.failControl(new Error(`Browser control connection was rejected with HTTP ${response.status}`))
        return
      }
    }
    if (this.socket || this.retry || this.attachments().length === 0) return
    const socket = new WebSocket(controlURL(this.server), BROWSER_CONTROL_PROTOCOL, {
      ...(this.server.authorization ? { headers: { Authorization: this.server.authorization } } : {}),
      handshakeTimeout: 10_000,
      maxPayload: BrowserControlProtocol.MaxMessageBytes,
      perMessageDeflate: false,
      followRedirects: false,
    })
    this.socket = socket
    socket.on("message", (data, binary) => {
      if (socket !== this.socket) return
      this.inbound = this.inbound.then(
        () => this.receive(socket, data, binary),
        () => this.receive(socket, data, binary),
      )
    })
    socket.on("error", (error) => {
      if (socket !== this.socket) return
      const status = /^Unexpected server response: (401|403|426)$/.exec(error.message)?.[1]
      if (status) this.failControl(new Error(`Browser control connection was rejected with HTTP ${status}`))
    })
    if (!process.versions.bun) {
      socket.on("unexpected-response", (_request, response) => {
        response.resume()
        if (socket !== this.socket) return
        if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 426) {
          this.failControl(new Error(`Browser control connection was rejected with HTTP ${response.statusCode}`))
          return
        }
        socket.terminate()
      })
    }
    socket.on("close", (code, reason) => {
      if (socket !== this.socket) return
      if (code === 1002 || code === 1007 || code === 1009) {
        this.failControl(controlCloseError(code, reason))
        return
      }
      this.socket = undefined
      this.resetConnection()
      this.scheduleReconnect()
    })
  }

  private async receive(socket: WebSocket, data: WebSocket.RawData, binary: boolean) {
    if (binary) return this.protocolError(socket)
    const decoded = await Effect.runPromise(BrowserControlProtocol.decodeFromServer(rawData(data))).catch(
      () => undefined,
    )
    if (!decoded || socket !== this.socket) return this.protocolError(socket)
    if (decoded.type === "browser.control.ready") {
      if (this.ready) return this.protocolError(socket)
      this.ready = true
      this.publish()
      return
    }
    if (!this.ready) return this.protocolError(socket)
    if (decoded.type === "browser.control.synced") {
      if (!this.syncing || this.syncing.revision !== decoded.revision) return this.protocolError(socket)
      this.synced = this.syncing.snapshot
      this.syncedLeases = this.syncing.leases
      this.syncing = undefined
      this.retryAttempt = 0
      this.resolveWaiters()
      this.publish()
      return
    }
    if (decoded.type === "browser.control.cancel") {
      const request = this.requests.get(decoded.requestID)
      if (!request) return
      if (request.leaseID !== decoded.leaseID) return this.protocolError(socket)
      this.requests.delete(decoded.requestID)
      request.abort.abort(new Error("Browser command was cancelled"))
      return
    }
    void this.request(socket, decoded)
  }

  private publish() {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready || this.syncing) return
    const attachments = this.attachments().map((record) => ({
      sessionID: record.sessionID,
      leaseID: record.leaseID,
      state: record.state,
    }))
    const snapshot = JSON.stringify(attachments)
    if (snapshot === this.synced) return
    const revision = this.revision++
    this.syncing = {
      revision,
      snapshot,
      leases: new Set(attachments.map((attachment) => attachmentKey(attachment.sessionID, attachment.leaseID))),
    }
    this.send(socket, { type: "browser.control.sync", revision, attachments })
  }

  private async request(socket: WebSocket, message: BrowserControl.Request) {
    if (this.requests.has(message.requestID)) return this.protocolError(socket)
    const record = this.records.get(message.sessionID)
    if (!record?.active || record.closed || record.leaseID !== message.leaseID || !record.execute) {
      this.send(socket, {
        type: "browser.control.response",
        requestID: message.requestID,
        leaseID: message.leaseID,
        outcome: { type: "failure", code: "not_attached", message: "The browser attachment is no longer available." },
      })
      return
    }

    const abort = new AbortController()
    this.requests.set(message.requestID, { leaseID: message.leaseID, abort })
    const outcome = await Promise.resolve()
      .then(() => record.execute?.(message.command, { signal: abort.signal }))
      .then(
        (result): Browser.Outcome => {
          if (!Schema.is(Browser.Result)(result) || result.type !== message.command.type) {
            return { type: "failure", code: "protocol", message: "Browser driver returned an invalid command result." }
          }
          return { type: "success", result }
        },
        (error): Browser.Outcome => driverFailure(error),
      )
    if (this.requests.get(message.requestID)?.abort !== abort) return
    this.requests.delete(message.requestID)
    if (socket !== this.socket) return
    this.send(socket, {
      type: "browser.control.response",
      requestID: message.requestID,
      leaseID: message.leaseID,
      outcome,
    })
    if (outcome.type === "success") {
      const state = contractState(outcome.result.state)
      if (state) {
        record.state = state
        this.changed()
      }
    }
  }

  private send(socket: WebSocket, message: BrowserControl.FromDesktop) {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(BrowserControlProtocol.encodeFromDesktop(message), (error) => {
      if (error && socket === this.socket) socket.terminate()
    })
  }

  private protocolError(socket: WebSocket) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1002, "Invalid browser control message")
    else socket.terminate()
  }

  private waitForAttachment(record: AttachmentRecord, signal: AbortSignal) {
    const key = attachmentKey(record.sessionID, record.leaseID)
    if (record.closed || this.records.get(record.sessionID) !== record) {
      return Promise.reject(new Error("Browser attachment is no longer available"))
    }
    if (record.active && this.syncedLeases.has(key)) return Promise.resolve()
    if (signal.aborted) return Promise.reject(abortError(signal, "Browser attachment wait was aborted"))
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        signal,
        resolve,
        reject,
        abort: () => {
          this.waiters.delete(waiter)
          reject(abortError(signal, "Browser attachment wait was aborted"))
        },
      }
      signal.addEventListener("abort", waiter.abort, { once: true })
      this.waiters.add(waiter)
    })
  }

  private resolveWaiters() {
    for (const waiter of this.waiters) {
      if (!this.syncedLeases.has(waiter.key)) continue
      const record = [...this.records.values()].find(
        (item) => !item.closed && item.active && attachmentKey(item.sessionID, item.leaseID) === waiter.key,
      )
      if (!record) continue
      this.waiters.delete(waiter)
      waiter.signal.removeEventListener("abort", waiter.abort)
      waiter.resolve()
    }
  }

  private rejectAttachmentWaiters(record: AttachmentRecord, error: Error) {
    const key = attachmentKey(record.sessionID, record.leaseID)
    for (const waiter of this.waiters) {
      if (waiter.key !== key) continue
      this.waiters.delete(waiter)
      waiter.signal.removeEventListener("abort", waiter.abort)
      waiter.reject(error)
    }
  }

  private abortRequests(leaseID?: Browser.LeaseID) {
    for (const [requestID, request] of this.requests) {
      if (leaseID && request.leaseID !== leaseID) continue
      this.requests.delete(requestID)
      request.abort.abort(new Error("Browser command was aborted"))
    }
  }

  private stopControl() {
    this.openingAbort?.abort()
    this.openingAbort = undefined
    this.opening = undefined
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    const socket = this.socket
    this.socket = undefined
    this.resetConnection()
    socket?.terminate()
  }

  private failControl(error: Error) {
    this.failing = true
    this.stopControl()
    this.retryAttempt = 0
    const records = [...this.records.values()]
    records.forEach((record) => {
      void this.close(record, error).catch(() => undefined)
    })
    this.failing = false
  }

  private resetConnection() {
    this.ready = false
    this.synced = undefined
    this.syncedLeases.clear()
    this.syncing = undefined
    this.revision = 0
    this.abortRequests()
  }

  private scheduleReconnect() {
    if (this.retry || this.attachments().length === 0) return
    const delay = Math.min(5_000, 100 * 2 ** this.retryAttempt++)
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.connect()
    }, delay)
    this.retry.unref()
  }
}

function createDriver<Resource>(driver: BrowserDriver<Resource>, context: BrowserDriverContext, signal: AbortSignal) {
  const creating = Promise.resolve().then(() => browserDriverFactory(driver)(context))
  return new Promise<BrowserDriverInstance<Resource>>((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      reject(abortError(signal, "Browser driver creation was aborted"))
    }
    signal.addEventListener("abort", abort, { once: true })
    creating.then(
      (instance) => {
        if (settled) {
          void disposeLateDriver(instance)
          return
        }
        settled = true
        signal.removeEventListener("abort", abort)
        resolve(instance)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

async function disposeLateDriver(instance: unknown) {
  if (instance === null || typeof instance !== "object" || !("dispose" in instance)) return
  const dispose = instance.dispose
  if (typeof dispose !== "function") return
  await Promise.resolve()
    .then(() => dispose.call(instance))
    .catch(() => undefined)
}

function cleanup(task: () => unknown) {
  return Promise.resolve()
    .then(task)
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
}

function exposedProxy(proxy: ProxyServer): BrowserProxy {
  return Object.freeze({
    url: proxy.url,
    host: proxy.host,
    port: proxy.port,
    credentials: Object.freeze({ ...proxy.credentials }),
    certificateFingerprint: proxy.certificateFingerprint,
  })
}

function contractState(state: Browser.State) {
  if (!Schema.is(Browser.State)(state)) return undefined
  return Object.freeze({ ...state })
}

function driverFailure(error: unknown): Browser.Failure {
  return {
    type: "failure",
    code:
      error !== null && typeof error === "object" && "code" in error && Schema.is(Browser.ErrorCode)(error.code)
        ? error.code
        : "internal",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_024),
  }
}

function endpoint(options: ClientOptions): BrowserTunnelEndpoint {
  const url = new URL(options.baseUrl)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new TypeError("Browser server endpoint must be an HTTP URL without embedded credentials")
  }
  const authorization = new Headers(options.headers).get("authorization") ?? undefined
  return Object.freeze({ url: url.href, ...(authorization ? { authorization } : {}), fetch: options.fetch })
}

function controlURL(endpoint: BrowserTunnelEndpoint) {
  const url = new URL(endpoint.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/api/browser/control"
  url.search = ""
  url.hash = ""
  return url
}

function attachmentKey(sessionID: string, leaseID: Browser.LeaseID) {
  return `${sessionID}\0${leaseID}`
}

function abortError(signal: AbortSignal | undefined, message: string) {
  return signal?.reason instanceof Error ? signal.reason : new Error(message)
}

function controlCloseError(code: number, reason: Buffer) {
  const detail = reason.toString("utf8").slice(0, 256)
  return new Error(`Browser control connection closed with fatal code ${code}${detail ? `: ${detail}` : ""}`)
}

function rawData(data: WebSocket.RawData) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
