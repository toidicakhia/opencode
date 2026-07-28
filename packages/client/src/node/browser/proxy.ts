import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import { Agent, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer } from "node:https"
import { Duplex } from "node:stream"
import { createBrowserProxyCertificate } from "./proxy-certificate.js"

export type BrowserProxyConnector = (target: BrowserTunnel.Target, signal: AbortSignal) => Promise<Duplex>

/** Starts an authenticated TLS forward proxy whose target sockets can only come from the tunnel connector. */
export async function createBrowserProxy(input: { readonly connect: BrowserProxyConnector }) {
  const candidate = `opencode-${randomBytes(16).toString("hex")}.localhost`
  const certificate = createBrowserProxyCertificate(candidate)
  const username = randomBytes(16).toString("hex")
  const password = randomBytes(32).toString("hex")
  const expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
  const clients = new Set<Duplex>()
  const tunnels = new Set<Duplex>()
  const pending = new Set<AbortController>()
  const limiter = connectionLimiter(6, 64)
  let closed = false

  const connect = async (target: BrowserTunnel.Target, signal?: AbortSignal) => {
    if (closed) throw new Error("Browser proxy is closed")
    const abort = new AbortController()
    const cancel = () => abort.abort(signal?.reason)
    const done = () => {
      pending.delete(abort)
      signal?.removeEventListener("abort", cancel)
    }
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    pending.add(abort)
    return limiter
      .run(() => input.connect(target, abort.signal), abort.signal)
      .then(
        (tunnel) => {
          done()
          if (closed || abort.signal.aborted) {
            tunnel.destroy()
            throw abort.signal.reason ?? new Error("Browser proxy is closed")
          }
          tunnels.add(tunnel)
          tunnel.once("close", () => tunnels.delete(tunnel))
          tunnel.on("error", () => tunnel.destroy())
          return tunnel
        },
        (error) => {
          done()
          throw error
        },
      )
  }

  const authorized = (header: string | undefined) => {
    if (!header) return false
    const actual = Buffer.from(header)
    return actual.length === expectedAuthorization.length && timingSafeEqual(actual, expectedAuthorization)
  }

  const server = createServer(
    { key: certificate.key, cert: certificate.certificate, allowHalfOpen: true, maxHeaderSize: 64 * 1_024 },
    (incoming, response) => {
      void forward(incoming, response, connect, authorized).catch(() => response.destroy())
    },
  )
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxRequestsPerSocket = 1_000
  server.on("connection", (socket) => {
    clients.add(socket)
    socket.once("close", () => clients.delete(socket))
  })
  server.on("connect", (incoming, socket, head) => {
    clients.add(socket)
    socket.once("close", () => clients.delete(socket))
    let established = false
    void (async () => {
      if (!authorized(singleHeader(incoming.headers["proxy-authorization"]))) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="OpenCode Browser Proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        )
        return
      }
      const parsed = authority(incoming.url ?? "", 443)
      if (!parsed) {
        socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
      }
      const abort = new AbortController()
      let tunnel: Duplex | undefined
      const buffered: Uint8Array[] = head.byteLength ? [head] : []
      let bufferedBytes = head.byteLength
      const cancel = () => {
        abort.abort(new Error("Browser proxy client closed during tunnel setup"))
        tunnel?.destroy()
      }
      const onReadable = () => {
        while (true) {
          const data: unknown = socket.read()
          if (data === null) break
          if (!(data instanceof Uint8Array)) {
            cancel()
            socket.destroy()
            return
          }
          bufferedBytes += data.byteLength
          if (bufferedBytes > 256 * 1_024) {
            cancel()
            socket.destroy()
            return
          }
          buffered.push(data)
        }
        if (socket.readableEnded) cancel()
      }
      incoming.once("aborted", cancel)
      incoming.once("error", cancel)
      socket.once("close", cancel)
      socket.once("end", cancel)
      socket.once("error", cancel)
      socket.on("readable", onReadable)
      socket.pause()
      tunnel = await connect(target(parsed.host, parsed.port), abort.signal)
      onReadable()
      if (socket.destroyed || socket.readableEnded || abort.signal.aborted) {
        socket.off("readable", onReadable)
        tunnel.destroy()
        return
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      established = true
      for (const data of buffered) {
        if (!tunnel.write(data)) await once(tunnel, "drain", { signal: abort.signal })
      }
      socket.off("readable", onReadable)
      bridge(socket, tunnel)
      incoming.off("aborted", cancel)
      incoming.off("error", cancel)
      socket.off("close", cancel)
      socket.off("end", cancel)
      socket.off("error", cancel)
      socket.resume()
    })().catch(() => {
      if (socket.destroyed) return
      if (established) {
        socket.destroy()
        return
      }
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
  })
  server.on("error", () => undefined)
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(0, "127.0.0.1")
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Browser proxy did not bind a TCP address")
  }
  const host = candidate
  let closing: Promise<void> | undefined

  return {
    url: `https://${host}:${address.port}`,
    host,
    port: address.port,
    credentials: { username, password },
    certificateFingerprint: certificate.fingerprint,
    close() {
      if (closing) return closing
      closed = true
      pending.forEach((abort) => abort.abort())
      pending.clear()
      limiter.close()
      tunnels.forEach((tunnel) => tunnel.destroy())
      tunnels.clear()
      clients.forEach((client) => client.destroy())
      clients.clear()
      closing = new Promise<void>((resolve) => server.close(() => resolve()))
      return closing
    },
  }
}

async function forward(
  incoming: IncomingMessage,
  response: ServerResponse,
  connect: (target: BrowserTunnel.Target, signal?: AbortSignal) => Promise<Duplex>,
  authorized: (header: string | undefined) => boolean,
) {
  if (!authorized(singleHeader(incoming.headers["proxy-authorization"]))) {
    response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="OpenCode Browser Proxy"' })
    response.end()
    return
  }
  const url = (() => {
    try {
      return new URL(incoming.url ?? "")
    } catch {
      return undefined
    }
  })()
  if (!url || url.protocol !== "http:" || !url.hostname || url.username || url.password) {
    response.writeHead(400)
    response.end()
    return
  }
  const port = url.port ? Number(url.port) : 80
  const abort = new AbortController()
  let tunnel: Duplex | undefined
  let agent: Agent | undefined
  const cancel = () => {
    abort.abort(new Error("Browser proxy downstream closed"))
    tunnel?.destroy()
  }
  incoming.once("aborted", cancel)
  incoming.once("error", cancel)
  incoming.socket.once("close", cancel)
  incoming.socket.once("end", cancel)
  incoming.socket.once("error", cancel)
  response.once("close", cancel)
  response.once("error", cancel)
  try {
    tunnel = await connect(target(normalizeHostname(url.hostname), port), abort.signal)
    const headers = forwardedHeaders(incoming.headers)
    headers.host = url.host
    headers.connection = "close"
    const connection = tunnel
    agent = new Agent({ keepAlive: false, maxSockets: 1, noDelay: false })
    agent.createConnection = () => connection
    await new Promise<void>((resolve, reject) => {
      const upstream = request(
        {
          agent,
          hostname: url.hostname,
          port,
          path: `${url.pathname}${url.search}`,
          method: incoming.method,
          headers,
          maxHeaderSize: 64 * 1_024,
          signal: abort.signal,
        },
        (result) => {
          const headers = forwardedHeaders(result.headers)
          headers.connection = "close"
          response.writeHead(result.statusCode ?? 502, result.statusMessage, headers)
          result.once("error", reject)
          result.once("aborted", () => reject(new Error("Browser proxy target response was aborted")))
          result.once("end", resolve)
          result.pipe(response)
        },
      )
      upstream.once("continue", () => response.writeContinue())
      upstream.once("error", reject)
      incoming.pipe(upstream)
    })
  } finally {
    incoming.off("aborted", cancel)
    incoming.off("error", cancel)
    incoming.socket.off("close", cancel)
    incoming.socket.off("end", cancel)
    incoming.socket.off("error", cancel)
    response.off("close", cancel)
    response.off("error", cancel)
    agent?.destroy()
    tunnel?.destroy()
  }
}

function forwardedHeaders(input: IncomingHttpHeaders) {
  const headers = { ...input }
  const named = singleHeader(headers.connection)
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  named?.forEach((name) => delete headers[name])
  ;[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].forEach((name) => delete headers[name])
  return headers
}

function bridge(client: Duplex, tunnel: Duplex) {
  client.on("error", () => tunnel.destroy())
  tunnel.on("error", () => client.destroy())
  client.on("close", () => {
    if (!tunnel.destroyed) tunnel.destroy()
  })
  tunnel.on("close", () => {
    if (!client.destroyed) client.destroy()
  })
  client.pipe(tunnel)
  tunnel.pipe(client)
}

function authority(value: string, defaultPort: number) {
  const bracket = /^\[([^\]]+)](?::([0-9]+))?$/.exec(value)
  if (bracket) return validAuthority(bracket[1], bracket[2], defaultPort)
  if (value.includes("[")) return undefined
  const separator = value.lastIndexOf(":")
  if (separator < 0) return validAuthority(value, undefined, defaultPort)
  if (value.slice(0, separator).includes(":")) return undefined
  return validAuthority(value.slice(0, separator), value.slice(separator + 1), defaultPort)
}

function validAuthority(host: string, value: string | undefined, defaultPort: number) {
  if (!host || (value !== undefined && !/^[0-9]+$/.test(value))) return undefined
  const port = value === undefined ? defaultPort : Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined
  try {
    return { host: BrowserTunnel.Host.make(host), port: BrowserTunnel.Port.make(port) }
  } catch {
    return undefined
  }
}

function target(host: string, port: number): BrowserTunnel.Target {
  return { host: BrowserTunnel.Host.make(host), port: BrowserTunnel.Port.make(port) }
}

function normalizeHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function singleHeader(value: string | ReadonlyArray<string> | undefined) {
  return typeof value === "string" ? value : undefined
}

function connectionLimiter(limit: number, capacity: number) {
  const queue: Array<() => void> = []
  let active = 0
  let closed = false
  const drain = (): void => {
    if (active >= limit) return
    const start = queue.shift()
    if (!start) return
    start()
    drain()
  }
  return {
    run<Result>(task: () => Promise<Result>, signal: AbortSignal) {
      return new Promise<Result>((resolve, reject) => {
        if (closed || signal.aborted) {
          reject(signal.reason ?? new Error("Browser proxy connection was cancelled"))
          return
        }
        if (active >= limit && queue.length >= capacity) {
          reject(new Error("Browser proxy connection queue is full"))
          return
        }
        const start = () => {
          signal.removeEventListener("abort", cancel)
          if (closed || signal.aborted) {
            reject(signal.reason ?? new Error("Browser proxy connection was cancelled"))
            return
          }
          active++
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active--
              drain()
            })
        }
        const cancel = () => {
          const index = queue.indexOf(start)
          if (index === -1) return
          queue.splice(index, 1)
          reject(signal.reason ?? new Error("Browser proxy connection was cancelled"))
        }
        if (active < limit) start()
        else {
          signal.addEventListener("abort", cancel, { once: true })
          queue.push(start)
        }
      })
    },
    close() {
      closed = true
      queue.splice(0).forEach((start) => start())
    },
  }
}
