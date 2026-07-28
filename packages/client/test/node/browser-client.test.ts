import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { BROWSER_CONTROL_PROTOCOL, BROWSER_TUNNEL_PROTOCOL } from "@opencode-ai/protocol/groups/browser"
import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { once } from "node:events"
import { createServer } from "node:http"
import { connect, type TLSSocket } from "node:tls"
import WebSocket, { WebSocketServer } from "ws"
import {
  Browser,
  BrowserDriver,
  BrowserDriverError,
  OpenCode,
  type BrowserDriverContext,
  type BrowserDriverInstance,
  type BrowserProxy,
} from "@opencode-ai/client/node"

const initialState: Browser.State = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}

describe("Node browser client", () => {
  test("rejects authentication failures on Bun without unsupported ws response events", async () => {
    const server = await controlServer("Basic expected")
    const adapter = driver("unauthorized")
    const client = OpenCode.make({ baseUrl: server.url })

    try {
      const result = await Promise.race([
        rejected(client.browser.attach({ sessionID: "ses_node_unauthorized", driver: adapter.descriptor })),
        Bun.sleep(1_000).then(() => new Error("Authentication rejection timed out")),
      ])
      expect(result.message).toContain("HTTP 401")
      expect(server.authorizations).toEqual([undefined])
      expect(adapter.disposeCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  test("cancels a pending Bun authentication probe when attachment setup is aborted", async () => {
    const abort = new AbortController()
    const adapter = driver("preflight")
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cancelled = false
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        resolveStarted()
        const signal = init?.signal
        if (!signal) return reject(new Error("Missing preflight signal"))
        const stop = () => {
          cancelled = true
          reject(signal.reason)
        }
        signal.addEventListener("abort", stop, { once: true })
        if (signal.aborted) stop()
      })
    const client = OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch })
    const attaching = client.browser.attach({
      sessionID: "ses_node_preflight_abort",
      driver: adapter.descriptor,
      signal: abort.signal,
    })

    await started
    const reason = new Error("stop preflight")
    abort.abort(reason)
    expect(await rejected(attaching)).toBe(reason)
    expect(cancelled).toBe(true)
    expect(adapter.disposeCount).toBe(1)
  })

  test("keeps constructor authentication immutable and waits for the lease sync acknowledgement", async () => {
    const authorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`
    const server = await controlServer(authorization)
    const headers = new Headers({ authorization })
    const adapter = driver("first")
    const client = OpenCode.make({ baseUrl: server.url, headers })
    headers.set("authorization", "Basic changed")

    try {
      expect(client.session).toBeDefined()
      expect(client.browser.attach).toBeFunction()
      let settled = false
      expect(adapter.descriptor).toBe(adapter.factory)
      const attaching = client.browser.attach({ sessionID: "ses_node_barrier", driver: adapter.factory })
      void attaching.then(() => {
        settled = true
      })
      const socket = await server.nextConnection()
      const next = controlReader(socket)

      expect(server.authorizations).toEqual([authorization])
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      const sync = await next()
      if (sync.type !== "browser.control.sync") throw new Error("Expected browser control sync")
      expect(sync.attachments).toHaveLength(1)
      expect(sync.attachments[0]?.sessionID).toBe("ses_node_barrier")
      expect(sync.attachments[0]?.leaseID.startsWith("brl_")).toBe(true)
      expect(adapter.proxy?.url.startsWith("https://")).toBe(true)
      expect(adapter.proxy?.credentials.username).toBeTruthy()
      await Bun.sleep(10)
      expect(settled).toBe(false)

      if (!adapter.proxy) throw new Error("Browser proxy is unavailable")
      const proxyConnection = connectProxy(adapter.proxy, "target.example:443")
      await Bun.sleep(10)
      expect(server.tunnelConnections).toBe(0)

      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: sync.revision }))
      const attachment = await attaching
      expect(attachment.resource).toEqual({ name: "first" })

      const tunnel = await server.nextTunnelConnection()
      const nextTunnel = tunnelReader(tunnel)
      tunnel.send(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.ready" }), { binary: true })
      const open = await nextTunnel()
      expect(open).toMatchObject({
        type: "control",
        message: {
          type: "browser.tunnel.open",
          sessionID: "ses_node_barrier",
          leaseID: sync.attachments[0]?.leaseID,
          target: { host: "target.example", port: 443 },
        },
      })
      tunnel.send(
        BrowserTunnelProtocol.encodeFromServer({
          type: "browser.tunnel.opened",
          receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
          receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
        }),
        { binary: true },
      )
      const connected = await proxyConnection
      expect(connected.response.startsWith("HTTP/1.1 200 Connection Established")).toBe(true)
      connected.socket.destroy()

      const closed = once(socket, "close")
      await attachment.close()
      await closed
      expect(adapter.disposeCount).toBe(1)
      expect(adapter.unsubscribeCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  test("multiplexes Sessions, coalesces state, routes requests and cancellation, and preserves siblings", async () => {
    const server = await controlServer()
    const client = OpenCode.make({ baseUrl: server.url })
    const first = driver("first")
    const second = driver("second")

    try {
      const attachingFirst = client.browser.attach({ sessionID: "ses_node_first", driver: first.descriptor })
      const socket = await server.nextConnection()
      const next = controlReader(socket)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      const firstSync = await nextSync(next)
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: firstSync.revision }),
      )
      const firstAttachment = await attachingFirst

      const attachingSecond = client.browser.attach({ sessionID: "ses_node_second", driver: second.descriptor })
      const secondSync = await nextSync(next)
      expect(secondSync.attachments.map((attachment) => attachment.sessionID)).toEqual([
        "ses_node_first",
        "ses_node_second",
      ])
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: secondSync.revision }),
      )
      const secondAttachment = await attachingSecond
      expect(server.connections).toBe(1)

      second.setState({ ...initialState, title: "Intermediate" })
      const pendingState = await nextSync(next)
      second.setState({ ...initialState, title: "Latest" })
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: pendingState.revision }),
      )
      const latestState = await nextSync(next)
      expect(
        latestState.attachments.find((attachment) => attachment.sessionID === "ses_node_second")?.state.title,
      ).toBe("Latest")
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: latestState.revision }),
      )

      const secondLease = secondSync.attachments.find(
        (attachment) => attachment.sessionID === "ses_node_second",
      )?.leaseID
      if (!secondLease) throw new Error("Second browser lease is unavailable")
      const requestID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID,
          sessionID: Session.ID.make("ses_node_second"),
          leaseID: secondLease,
          command: { type: "snapshot", generation: 1 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID,
        outcome: { type: "success", result: { type: "snapshot", content: "second" } },
      })

      const commandState = { ...initialState, title: "Updated by command", generation: 2 }
      second.setExecute(async () => ({ type: "navigate", state: commandState }))
      const stateRequestID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID: stateRequestID,
          sessionID: Session.ID.make("ses_node_second"),
          leaseID: secondLease,
          command: { type: "navigate", url: "https://updated.example/", generation: 1 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID: stateRequestID,
        outcome: { type: "success", result: { state: { title: "Updated by command" } } },
      })
      const commandStateSync = await nextSync(next)
      expect(
        commandStateSync.attachments.find((attachment) => attachment.sessionID === "ses_node_second")?.state,
      ).toEqual(commandState)
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.synced",
          revision: commandStateSync.revision,
        }),
      )

      second.setExecute(async () => ({ type: "click", state: initialState }))
      const invalidID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID: invalidID,
          sessionID: Session.ID.make("ses_node_second"),
          leaseID: secondLease,
          command: { type: "snapshot", generation: 1 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID: invalidID,
        outcome: { type: "failure", code: "protocol" },
      })

      second.setExecute(async () => {
        throw new BrowserDriverError("stale_ref", "The reference is stale")
      })
      const errorID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID: errorID,
          sessionID: Session.ID.make("ses_node_second"),
          leaseID: secondLease,
          command: { type: "click", ref: Browser.Ref.make("e1"), generation: 1 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID: errorID,
        outcome: { type: "failure", code: "stale_ref", message: "The reference is stale" },
      })

      second.setExecute(async () => {
        throw Object.assign(new Error("Invalid adapter code"), { code: "not_a_browser_error" })
      })
      const unsafeErrorID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID: unsafeErrorID,
          sessionID: Session.ID.make("ses_node_second"),
          leaseID: secondLease,
          command: { type: "snapshot", generation: 2 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID: unsafeErrorID,
        outcome: { type: "failure", code: "internal", message: "Invalid adapter code" },
      })

      let resolveStarted!: () => void
      let resolveCancelled!: () => void
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const cancelled = new Promise<void>((resolve) => {
        resolveCancelled = resolve
      })
      second.setExecute(
        (_command, options) =>
          new Promise<Browser.Result>((_, reject) => {
            resolveStarted()
            options.signal.addEventListener(
              "abort",
              () => {
                resolveCancelled()
                reject(Object.assign(new Error("cancelled"), { code: "aborted" }))
              },
              { once: true },
            )
          }),
      )
      const cancelID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID: cancelID,
          sessionID: Session.ID.make("ses_node_second"),
          leaseID: secondLease,
          command: { type: "click", ref: Browser.Ref.make("e1"), generation: 1 },
        }),
      )
      await started
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.cancel",
          requestID: cancelID,
          leaseID: secondLease,
        }),
      )
      await cancelled

      await firstAttachment.close()
      const detached = await nextSync(next)
      expect(detached.attachments).toHaveLength(1)
      expect(detached.attachments[0]?.sessionID).toBe("ses_node_second")
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: detached.revision }),
      )
      expect(server.connections).toBe(1)
      expect(second.disposeCount).toBe(0)

      const closed = once(socket, "close")
      await secondAttachment.close()
      await closed
      expect(first.disposeCount).toBe(1)
      expect(second.disposeCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  test("reconnects and republishes the complete attachment snapshot", async () => {
    const server = await controlServer()
    const client = OpenCode.make({ baseUrl: server.url })
    const adapter = driver("reconnect")

    try {
      const attaching = client.browser.attach({ sessionID: "ses_node_reconnect", driver: adapter.descriptor })
      const original = await server.nextConnection()
      const nextOriginal = controlReader(original)
      original.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      const initial = await nextSync(nextOriginal)
      original.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: initial.revision }),
      )
      const attachment = await attaching
      original.terminate()

      const replacement = await server.nextConnection()
      const nextReplacement = controlReader(replacement)
      replacement.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      const republished = await nextSync(nextReplacement)
      expect(republished.attachments).toEqual(initial.attachments)
      replacement.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: republished.revision }),
      )
      expect(server.connections).toBe(2)

      const closed = once(replacement, "close")
      await attachment.close()
      await closed
    } finally {
      await server.close()
    }
  })

  test("rejects duplicate Sessions and aborts setup while close remains idempotent", async () => {
    const server = await controlServer()
    const client = OpenCode.make({ baseUrl: server.url })
    const adapter = driver("owner")

    try {
      const invalid = driver("invalid")
      expect(
        (await rejected(client.browser.attach({ sessionID: "invalid", driver: invalid.descriptor }))).message,
      ).toContain("valid Session ID")
      expect(invalid.createCount).toBe(0)

      const attaching = client.browser.attach({ sessionID: "ses_node_owner", driver: adapter.descriptor })
      const socket = await server.nextConnection()
      const next = controlReader(socket)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      const sync = await nextSync(next)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: sync.revision }))
      const attachment = await attaching

      const duplicate = driver("duplicate")
      expect(
        (await rejected(client.browser.attach({ sessionID: "ses_node_owner", driver: duplicate.descriptor }))).message,
      ).toContain("already attached")
      expect(duplicate.createCount).toBe(0)

      const closed = once(socket, "close")
      await Promise.all([attachment.close(), attachment.close(), attachment[Symbol.asyncDispose]()])
      await closed
      expect(adapter.disposeCount).toBe(1)
      expect(adapter.unsubscribeCount).toBe(1)

      const abort = new AbortController()
      const abortedAdapter = driver("aborted")
      const aborted = client.browser.attach({
        sessionID: "ses_node_aborted",
        driver: abortedAdapter.descriptor,
        signal: abort.signal,
      })
      const abortSocket = await server.nextConnection()
      const nextAbort = controlReader(abortSocket)
      abortSocket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      await nextSync(nextAbort)
      const reason = new Error("stop attaching")
      const abortClosed = once(abortSocket, "close")
      abort.abort(reason)
      expect(await rejected(aborted)).toBe(reason)
      await abortClosed
      expect(abortedAdapter.disposeCount).toBe(1)
      expect(abortedAdapter.signal?.aborted).toBe(true)

      const alreadyAborted = new AbortController()
      alreadyAborted.abort(reason)
      const unused = driver("unused")
      expect(
        await rejected(
          client.browser.attach({
            sessionID: "ses_node_unused",
            driver: unused.descriptor,
            signal: alreadyAborted.signal,
          }),
        ),
      ).toBe(reason)
      expect(unused.createCount).toBe(0)
    } finally {
      await server.close()
    }
  })

  test("fails pending attachments on fatal control closes without reconnecting", async () => {
    const server = await controlServer()
    const client = OpenCode.make({ baseUrl: server.url })
    const adapter = driver("fatal")

    try {
      const attaching = client.browser.attach({ sessionID: "ses_node_fatal", driver: adapter.descriptor })
      const socket = await server.nextConnection()
      const next = controlReader(socket)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      await nextSync(next)
      const closed = once(socket, "close")
      socket.close(1002, "invalid control state")

      expect((await rejected(attaching)).message).toContain("fatal code 1002")
      await closed
      await Bun.sleep(250)
      expect(server.connections).toBe(1)
      expect(adapter.disposeCount).toBe(1)
      expect(adapter.signal?.aborted).toBe(true)
    } finally {
      await server.close()
    }
  })

  test("aborts non-cooperative driver creation and disposes a late instance", async () => {
    const server = await controlServer()
    const client = OpenCode.make({ baseUrl: server.url })
    const abort = new AbortController()
    let resolveStarted!: () => void
    let resolveFactory!: (instance: BrowserDriverInstance<{ readonly name: string }>) => void
    let resolveDisposed!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const disposed = new Promise<void>((resolve) => {
      resolveDisposed = resolve
    })
    const factory = () => {
      resolveStarted()
      return new Promise<BrowserDriverInstance<{ readonly name: string }>>((resolve) => {
        resolveFactory = resolve
      })
    }

    try {
      const attaching = client.browser.attach({
        sessionID: "ses_node_blocked_factory",
        driver: factory,
        signal: abort.signal,
      })
      await started
      const reason = new Error("abort blocked factory")
      abort.abort(reason)
      expect(
        await rejected(
          Promise.race([
            attaching,
            Bun.sleep(250).then(() => {
              throw new Error("Browser attachment did not abort promptly")
            }),
          ]),
        ),
      ).toBe(reason)

      resolveFactory({
        resource: { name: "late" },
        state: () => initialState,
        subscribe: () => () => undefined,
        execute: async () => ({
          type: "snapshot",
          state: initialState,
          format: "opencode.semantic.v1",
          content: "late",
        }),
        dispose: () => resolveDisposed(),
      })
      await disposed
      expect(server.authorizations).toEqual([])
    } finally {
      await server.close()
    }
  })

  test("cleans up in reverse acquisition order and surfaces the first error", async () => {
    const server = await controlServer()
    const client = OpenCode.make({ baseUrl: server.url })
    const first = new Error("unsubscribe failed")
    const second = new Error("dispose failed")
    const order: string[] = []
    let proxy: BrowserProxy | undefined
    let proxyOpenDuringDispose = false
    const descriptor = BrowserDriver.define((context) => {
      proxy = context.proxy
      return {
        resource: context.proxy,
        state: () => initialState,
        subscribe: () => () => {
          order.push("unsubscribe")
          throw first
        },
        execute: async () => ({
          type: "snapshot",
          state: initialState,
          format: "opencode.semantic.v1",
          content: "cleanup",
        }),
        dispose: async () => {
          order.push("dispose")
          proxyOpenDuringDispose = await proxyAvailable(context.proxy)
          throw second
        },
      }
    })

    try {
      const attaching = client.browser.attach({ sessionID: "ses_node_cleanup", driver: descriptor })
      const socket = await server.nextConnection()
      const next = controlReader(socket)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))
      const sync = await nextSync(next)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.synced", revision: sync.revision }))
      const attachment = await attaching

      expect(await rejected(attachment.close())).toBe(first)
      expect(await rejected(attachment.close())).toBe(first)
      expect(order).toEqual(["unsubscribe", "dispose"])
      expect(proxyOpenDuringDispose).toBe(true)
      if (!proxy) throw new Error("Browser proxy is unavailable")
      expect(await proxyAvailable(proxy)).toBe(false)
    } finally {
      await server.close()
    }
  })
})

type Execute = BrowserDriverInstance<unknown>["execute"]

function driver(name: string) {
  let current = initialState
  let execute: Execute = async () => ({
    type: "snapshot",
    state: current,
    format: "opencode.semantic.v1",
    content: name,
  })
  let proxy: BrowserProxy | undefined
  let signal: AbortSignal | undefined
  let createCount = 0
  let disposeCount = 0
  let unsubscribeCount = 0
  const listeners = new Set<(state: Browser.State) => void>()
  const factory = ({ proxy: nextProxy, signal: nextSignal }: BrowserDriverContext) => {
    createCount++
    proxy = nextProxy
    signal = nextSignal
    return {
      resource: { name },
      state: () => current,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          if (listeners.delete(listener)) unsubscribeCount++
        }
      },
      execute: (command, options) => execute(command, options),
      dispose() {
        disposeCount++
      },
    }
  }
  const descriptor = BrowserDriver.define(factory)
  return {
    factory,
    descriptor,
    get proxy() {
      return proxy
    },
    get signal() {
      return signal
    },
    get createCount() {
      return createCount
    },
    get disposeCount() {
      return disposeCount
    },
    get unsubscribeCount() {
      return unsubscribeCount
    },
    setState(state: Browser.State) {
      current = state
      listeners.forEach((listener) => listener(state))
    },
    setExecute(next: Execute) {
      execute = next
    },
  }
}

async function rejected(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("Expected operation to reject"),
    (error) => (error instanceof Error ? error : new Error(String(error))),
  )
}

async function nextSync(next: () => Promise<BrowserControl.FromDesktop>) {
  const message = await next()
  if (message.type !== "browser.control.sync") throw new Error("Expected browser control sync")
  return message
}

async function controlServer(authorization?: string) {
  const http = createServer((request, response) => {
    response.statusCode = request.headers.authorization === authorization ? 200 : 401
    response.end()
  })
  const webSockets = new WebSocketServer({ noServer: true })
  const tunnels = new WebSocketServer({ noServer: true })
  const waiting: Array<(socket: WebSocket) => void> = []
  const queued: WebSocket[] = []
  const tunnelWaiting: Array<(socket: WebSocket) => void> = []
  const tunnelQueued: WebSocket[] = []
  const authorizations: Array<string | undefined> = []
  let connections = 0
  let tunnelConnections = 0
  webSockets.on("connection", (socket) => {
    connections++
    const resolve = waiting.shift()
    if (resolve) resolve(socket)
    else queued.push(socket)
  })
  tunnels.on("connection", (socket) => {
    tunnelConnections++
    const resolve = tunnelWaiting.shift()
    if (resolve) resolve(socket)
    else tunnelQueued.push(socket)
  })
  http.on("upgrade", (request, socket, head) => {
    authorizations.push(request.headers.authorization)
    if (request.headers.authorization !== authorization) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    if (
      request.url === "/api/browser/control" &&
      request.headers["sec-websocket-protocol"] === BROWSER_CONTROL_PROTOCOL
    ) {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request))
      return
    }
    if (
      request.url === "/api/browser/tunnel" &&
      request.headers["sec-websocket-protocol"] === BROWSER_TUNNEL_PROTOCOL
    ) {
      tunnels.handleUpgrade(request, socket, head, (webSocket) => tunnels.emit("connection", webSocket, request))
      return
    }
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (address === null || typeof address === "string") throw new Error("Browser control server did not bind TCP")
  return {
    authorizations,
    get connections() {
      return connections
    },
    get tunnelConnections() {
      return tunnelConnections
    },
    url: `http://127.0.0.1:${address.port}`,
    nextConnection() {
      const socket = queued.shift()
      if (socket) return Promise.resolve(socket)
      return new Promise<WebSocket>((resolve) => waiting.push(resolve))
    },
    nextTunnelConnection() {
      const socket = tunnelQueued.shift()
      if (socket) return Promise.resolve(socket)
      return new Promise<WebSocket>((resolve) => tunnelWaiting.push(resolve))
    },
    async close() {
      webSockets.clients.forEach((socket) => socket.terminate())
      tunnels.clients.forEach((socket) => socket.terminate())
      webSockets.close()
      tunnels.close()
      http.closeAllConnections()
      http.close()
      await Bun.sleep(10)
    },
  }
}

function proxyAvailable(proxy: BrowserProxy) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({
      host: "127.0.0.1",
      port: proxy.port,
      servername: proxy.host,
      rejectUnauthorized: false,
    })
    let settled = false
    const finish = (available: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolve(available)
    }
    const timeout = setTimeout(() => finish(false), 250)
    timeout.unref()
    socket.once("secureConnect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function connectProxy(proxy: BrowserProxy, authority: string) {
  return new Promise<{ readonly socket: TLSSocket; readonly response: string }>((resolve, reject) => {
    const socket = connect(
      {
        host: "127.0.0.1",
        port: proxy.port,
        servername: proxy.host,
        rejectUnauthorized: false,
      },
      () => {
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}\r\n\r\n`,
        )
      },
    )
    let response = ""
    socket.on("error", () => undefined)
    socket.once("error", reject)
    socket.on("data", (data) => {
      response += data.toString()
      if (!response.includes("\r\n\r\n")) return
      resolve({ socket, response })
    })
  })
}

function tunnelReader(socket: WebSocket) {
  const queued: WebSocket.RawData[] = []
  const waiting: Array<(data: WebSocket.RawData) => void> = []
  socket.on("message", (data, binary) => {
    if (!binary) throw new Error("Expected a binary browser tunnel frame")
    const resolve = waiting.shift()
    if (resolve) resolve(data)
    else queued.push(data)
  })
  return async () => {
    const data = queued.shift() ?? (await new Promise<WebSocket.RawData>((resolve) => waiting.push(resolve)))
    return Effect.runPromise(BrowserTunnelProtocol.decodeFromDesktop(rawData(data)))
  }
}

function controlReader(socket: WebSocket) {
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
    if (message.binary) throw new Error("Expected a text browser control message")
    return Effect.runPromise(BrowserControlProtocol.decodeFromDesktop(rawData(message.data)))
  }
}

function rawData(data: WebSocket.RawData) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
