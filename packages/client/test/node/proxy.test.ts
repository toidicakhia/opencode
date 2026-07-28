import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duplex } from "node:stream"
import { connect, type TLSSocket } from "node:tls"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "bun:test"
import { createBrowserProxy } from "../../src/node/browser/proxy"

describe("browser proxy", () => {
  test("forwards authenticated CONNECT streams without directly dialing the target", async () => {
    let directConnections = 0
    const decoy = createServer((_incoming, response) => response.end("DIRECT DIAL"))
    decoy.on("connection", () => directConnections++)
    await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve))
    const decoyAddress = decoy.address()
    if (decoyAddress === null || typeof decoyAddress === "string") throw new Error("decoy server did not bind TCP")
    const target = createServer((incoming, response) => response.end(`TARGET ${incoming.method} ${incoming.url}`))
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
    const targetAddress = target.address()
    if (targetAddress === null || typeof targetAddress === "string") throw new Error("target server did not bind TCP")
    const opened: Array<{ host: string; port: number }> = []
    const proxy = await createBrowserProxy({
      connect: async (destination, signal) => {
        opened.push(destination)
        const socket = new Socket({ allowHalfOpen: true })
        const abort = () => socket.destroy(new Error("cancelled"))
        signal.addEventListener("abort", abort, { once: true })
        socket.once("close", () => signal.removeEventListener("abort", abort))
        // Emulate the server-side tunnel dial. The local decoy must never receive a connection.
        socket.connect(targetAddress.port, "127.0.0.1")
        await once(socket, "connect")
        return socket
      },
    })
    try {
      const tunnel = await proxyConnect(proxy, `127.0.0.1:${decoyAddress.port}`)
      expect(tunnel.status).toBe(200)
      tunnel.socket.write(
        `GET /connected HTTP/1.1\r\nHost: 127.0.0.1:${decoyAddress.port}\r\nConnection: close\r\n\r\n`,
      )
      const response = await readAll(tunnel.socket, tunnel.leftover)
      expect(response).toContain("TARGET GET /connected")
      expect(opened).toEqual([{ host: "127.0.0.1", port: decoyAddress.port }])

      const certificate = await peerCertificate(proxy)
      expect(`sha256/${createHash("sha256").update(certificate).digest("base64")}`).toBe(proxy.certificateFingerprint)
      expect(directConnections).toBe(0)
    } finally {
      await proxy.close()
      await Promise.all([
        new Promise<void>((resolve) => target.close(() => resolve())),
        new Promise<void>((resolve) => decoy.close(() => resolve())),
      ])
    }
  })

  test("forwards absolute-form HTTP with Node framing and closes held-open targets", async () => {
    expect(await nodeAbsoluteFormScenario()).toEqual({
      unauthorized: { status: 407, body: "" },
      forwarded: { status: 200, body: "TARGET GET /absolute?q=1" },
      posted: { status: 200, body: "TARGET POST /post request body" },
      chunked: { status: 200, body: "TARGET CHUNKED" },
      held: { status: 200, body: "ok" },
      opened: 4,
      destinationsCorrect: true,
      directConnections: 0,
      heldDestroyed: true,
    })
  })

  test("limits concurrent tunnel setup to six connections", async () => {
    let active = 0
    let maximum = 0
    let started = 0
    const releases: Array<() => void> = []
    const proxy = await createBrowserProxy({
      connect: (_destination, signal) =>
        new Promise<Duplex>((resolve, reject) => {
          active++
          started++
          maximum = Math.max(maximum, active)
          const finish = (result: () => void) => {
            signal.removeEventListener("abort", abort)
            active--
            result()
          }
          const abort = () => finish(() => reject(new Error("cancelled")))
          signal.addEventListener("abort", abort, { once: true })
          releases.push(() =>
            finish(() =>
              resolve(
                new Duplex({
                  read() {},
                  write(_chunk, _encoding, callback) {
                    callback()
                  },
                }),
              ),
            ),
          )
        }),
    })
    const connections = Array.from({ length: 7 }, () =>
      proxyConnect(proxy, "target.example:443").then(
        (result) => result.socket.destroy(),
        () => undefined,
      ),
    )
    try {
      await waitFor(() => started === 6)
      expect(maximum).toBe(6)
      expect(started).toBe(6)

      releases.shift()?.()
      await waitFor(() => started === 7)
      expect(maximum).toBe(6)
    } finally {
      await proxy.close()
      await Promise.all(connections)
    }
  })

  test("aborts pending CONNECT setup when the downstream client closes", async () => {
    let aborted = false
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const proxy = await createBrowserProxy({
      connect: (_destination, signal) =>
        new Promise<Duplex>((_resolve, reject) => {
          resolveStarted()
          const abort = () => {
            aborted = true
            reject(new Error("cancelled"))
          }
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
        }),
    })
    const socket = proxyClient(
      proxy,
      `CONNECT target.example:443 HTTP/1.1\r\nHost: target.example:443\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    )
    try {
      await started
      socket.destroy()
      await waitFor(() => aborted)
    } finally {
      socket.destroy()
      await proxy.close()
    }
  })

  test("aborts pending absolute-form setup when the downstream client closes", async () => {
    let aborted = false
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const proxy = await createBrowserProxy({
      connect: (_destination, signal) =>
        new Promise<Duplex>((_resolve, reject) => {
          resolveStarted()
          const abort = () => {
            aborted = true
            reject(new Error("cancelled"))
          }
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
        }),
    })
    const socket = proxyClient(
      proxy,
      `GET http://target.example/pending HTTP/1.1\r\nHost: target.example\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    )
    try {
      await started
      socket.destroy()
      await waitFor(() => aborted)
    } finally {
      socket.destroy()
      await proxy.close()
    }
  })

  test("closes absolute-form requests when the target tunnel cannot connect", async () => {
    const proxy = await createBrowserProxy({ connect: () => Promise.reject(new Error("target unavailable")) })
    const socket = proxyClient(
      proxy,
      `GET http://target.example/unavailable HTTP/1.1\r\nHost: target.example\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    )
    const chunks: Buffer[] = []
    socket.on("data", (chunk) => chunks.push(chunk))
    try {
      await once(socket, "close")
      expect(Buffer.concat(chunks).toString()).not.toContain("502 Bad Gateway")
    } finally {
      socket.destroy()
      await proxy.close()
    }
  })
})

type ProxyInfo = Awaited<ReturnType<typeof createBrowserProxy>>

function authorization(proxy: ProxyInfo) {
  return `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`
}

function proxyClient(proxy: ProxyInfo, request: string) {
  const socket = connect(
    {
      host: "127.0.0.1",
      port: proxy.port,
      servername: proxy.host.endsWith(".localhost") ? proxy.host : undefined,
      rejectUnauthorized: false,
    },
    () => socket.write(request),
  )
  socket.on("error", () => undefined)
  return socket
}

async function nodeAbsoluteFormScenario() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-browser-proxy-"))
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../src/node/browser/proxy.ts")],
      outdir: directory,
      naming: "browser-proxy.mjs",
      target: "node",
      format: "esm",
    })
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join("\n"))
    const output = built.outputs[0]
    if (!output) throw new Error("Browser proxy Node bundle was not emitted")
    const child = Bun.spawn(
      ["node", "--input-type=module", "-e", absoluteFormScenario(pathToFileURL(output.path).href)],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(stderr || stdout)
    const result: unknown = JSON.parse(stdout)
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function absoluteFormScenario(moduleURL: string) {
  return `import { createBrowserProxy } from ${JSON.stringify(moduleURL)}
import { once } from "node:events"
import { Agent, createServer, request } from "node:http"
import { Socket } from "node:net"
import { Duplex } from "node:stream"
import { connect } from "node:tls"

const proxyRequest = async (proxy, path, authenticated, options = {}) => {
  const socket = await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port, servername: proxy.host, rejectUnauthorized: false }, () => resolve(socket))
    socket.once("error", reject)
  })
  const agent = new Agent({ keepAlive: false, maxSockets: 1, noDelay: false })
  agent.createConnection = () => socket
  const body = Buffer.from(options.body ?? "")
  try {
    return await new Promise((resolve, reject) => {
      const incoming = request({
        agent,
        hostname: proxy.host,
        path,
        method: options.method ?? "GET",
        headers: {
          connection: "close",
          ...(authenticated ? { "proxy-authorization": "Basic " + Buffer.from(proxy.credentials.username + ":" + proxy.credentials.password).toString("base64") } : {}),
          ...(options.chunked ? { "transfer-encoding": "chunked" } : { "content-length": body.byteLength.toString() }),
        },
      }, (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      })
      incoming.once("error", reject)
      incoming.end(body)
    })
  } finally {
    agent.destroy()
    socket.destroy()
  }
}

let directConnections = 0
const decoy = createServer((_incoming, response) => response.end("DIRECT DIAL"))
decoy.on("connection", () => directConnections++)
decoy.listen(0, "127.0.0.1")
await once(decoy, "listening")
const decoyAddress = decoy.address()
if (!decoyAddress || typeof decoyAddress === "string") throw new Error("decoy server did not bind TCP")

const targetServer = createServer((incoming, response) => {
  const chunks = []
  incoming.on("data", (chunk) => chunks.push(chunk))
  incoming.on("end", () => {
    response.writeHead(200, { "content-type": "text/plain" })
    if (incoming.url === "/chunked") {
      response.write("TARGET ")
      response.end("CHUNKED")
      return
    }
    const body = Buffer.concat(chunks).toString()
    response.end("TARGET " + incoming.method + " " + incoming.url + (body ? " " + body : ""))
  })
})
targetServer.listen(0, "127.0.0.1")
await once(targetServer, "listening")
const targetAddress = targetServer.address()
if (!targetAddress || typeof targetAddress === "string") throw new Error("target server did not bind TCP")

const opened = []
let held
const proxy = await createBrowserProxy({
  connect: async (destination, signal) => {
    opened.push(destination)
    if (destination.host === "held.example") {
      let responded = false
      held = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          if (!responded && Buffer.from(chunk).includes(Buffer.from("\\r\\n\\r\\n"))) {
            responded = true
            this.push(Buffer.from("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"))
          }
          callback()
        },
      })
      return held
    }
    const socket = new Socket({ allowHalfOpen: true })
    const abort = () => socket.destroy(new Error("cancelled"))
    signal.addEventListener("abort", abort, { once: true })
    socket.once("close", () => signal.removeEventListener("abort", abort))
    socket.connect(targetAddress.port, "127.0.0.1")
    await once(socket, "connect")
    return socket
  },
})

try {
  const base = "http://127.0.0.1:" + decoyAddress.port
  const unauthorized = await proxyRequest(proxy, base + "/private", false)
  const forwarded = await proxyRequest(proxy, base + "/absolute?q=1", true)
  const posted = await proxyRequest(proxy, base + "/post", true, { method: "POST", body: "request body", chunked: true })
  const chunked = await proxyRequest(proxy, base + "/chunked", true)
  const heldResult = await proxyRequest(proxy, "http://held.example/held-open", true)
  await new Promise((resolve) => setImmediate(resolve))
  console.log(JSON.stringify({
    unauthorized,
    forwarded,
    posted,
    chunked,
    held: heldResult,
    opened: opened.length,
    destinationsCorrect: opened.slice(0, 3).every((item) => item.host === "127.0.0.1" && item.port === decoyAddress.port) && opened[3]?.host === "held.example" && opened[3]?.port === 80,
    directConnections,
    heldDestroyed: held?.destroyed === true,
  }))
} finally {
  await proxy.close()
  targetServer.closeAllConnections()
  decoy.closeAllConnections()
  await Promise.all([new Promise((resolve) => targetServer.close(resolve)), new Promise((resolve) => decoy.close(resolve))])
}`
}

function proxyConnect(proxy: ProxyInfo, destination: string) {
  return new Promise<{ status: number; socket: TLSSocket; leftover: Buffer }>((resolve, reject) => {
    const socket = connect(
      {
        host: "127.0.0.1",
        port: proxy.port,
        servername: proxy.host.endsWith(".localhost") ? proxy.host : undefined,
        rejectUnauthorized: false,
      },
      () => {
        socket.write(
          `CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
        )
      },
    )
    let buffered = Buffer.alloc(0)
    let settled = false
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf("\r\n\r\n")
      if (end < 0) return
      socket.off("data", onData)
      const status = Number(buffered.toString("ascii", 0, end).split(" ", 2)[1])
      settled = true
      resolve({ status, socket, leftover: buffered.subarray(end + 4) })
    }
    socket.on("data", onData)
    socket.once("error", reject)
    socket.once("close", () => {
      if (!settled) reject(new Error("Browser proxy connection closed before responding"))
    })
  })
}

function readAll(socket: TLSSocket, initial: Buffer) {
  return new Promise<string>((resolve, reject) => {
    const chunks = [initial]
    socket.on("data", (chunk) => chunks.push(chunk))
    socket.on("end", () => resolve(Buffer.concat(chunks).toString()))
    socket.once("error", reject)
  })
}

function peerCertificate(proxy: ProxyInfo) {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = connect(
      {
        host: "127.0.0.1",
        port: proxy.port,
        servername: proxy.host.endsWith(".localhost") ? proxy.host : undefined,
        rejectUnauthorized: false,
      },
      () => {
        resolve(socket.getPeerCertificate().raw)
        socket.end()
      },
    )
    socket.once("error", reject)
  })
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for browser proxy test condition")
}
