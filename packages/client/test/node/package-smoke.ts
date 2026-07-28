import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const directory = resolve(import.meta.dir, "../..")

test("built Node entrypoint imports in Node and treats HTTP authentication rejection as fatal", async () => {
  await buildClient()
  const output = await Bun.file(join(directory, "dist/node/index.js")).text()
  expect(output).not.toMatch(/(?:from\s+|import\s*)["']\.\.?\//)

  const temporary = await mkdtemp(join(import.meta.dir, ".node-package-"))
  try {
    await Bun.write(join(temporary, "index.mjs"), output)
    await stageWorkspaceDependencies(temporary)
    const child = Bun.spawn(
      ["node", "--input-type=module", "-e", nodeScenario(pathToFileURL(join(temporary, "index.mjs")).href)],
      { cwd: temporary, stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stderr || stdout)
    expect(stdout.trim()).toBe("ok")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 60_000)

async function buildClient() {
  const child = Bun.spawn([process.execPath, "run", "build"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stdout + stderr)
}

async function stageWorkspaceDependencies(temporary: string) {
  const schema = join(temporary, "node_modules/@opencode-ai/schema")
  const protocol = join(temporary, "node_modules/@opencode-ai/protocol")
  await Promise.all([mkdir(schema, { recursive: true }), mkdir(protocol, { recursive: true })])

  const schemaEntry = join(temporary, "schema.ts")
  const protocolEntry = join(temporary, "protocol.ts")
  await Promise.all([
    Bun.write(
      schemaEntry,
      [
        `export { Browser } from ${JSON.stringify(importPath(temporary, resolve(directory, "../schema/src/browser.ts")))}`,
        `export { BrowserControl } from ${JSON.stringify(importPath(temporary, resolve(directory, "../schema/src/browser-control.ts")))}`,
        `export { BrowserTunnel } from ${JSON.stringify(importPath(temporary, resolve(directory, "../schema/src/browser-tunnel.ts")))}`,
        `export { Session } from ${JSON.stringify(importPath(temporary, resolve(directory, "../schema/src/session.ts")))}`,
      ].join("\n"),
    ),
    Bun.write(
      protocolEntry,
      [
        `export { BrowserControlProtocol } from ${JSON.stringify(importPath(temporary, resolve(directory, "../protocol/src/browser-control.ts")))}`,
        `export { BrowserTunnelProtocol } from ${JSON.stringify(importPath(temporary, resolve(directory, "../protocol/src/browser-tunnel.ts")))}`,
        `export { BROWSER_CONTROL_PROTOCOL, BROWSER_TUNNEL_PROTOCOL } from ${JSON.stringify(importPath(temporary, resolve(directory, "../protocol/src/groups/browser.ts")))}`,
      ].join("\n"),
    ),
  ])
  const [schemaBuild, protocolBuild] = await Promise.all([
    Bun.build({
      entrypoints: [schemaEntry],
      outdir: schema,
      naming: "index.js",
      target: "node",
      format: "esm",
      packages: "bundle",
    }),
    Bun.build({
      entrypoints: [protocolEntry],
      outdir: protocol,
      naming: "index.js",
      target: "node",
      format: "esm",
      packages: "bundle",
    }),
  ])
  if (!schemaBuild.success) throw new Error(schemaBuild.logs.map((log) => log.message).join("\n"))
  if (!protocolBuild.success) throw new Error(protocolBuild.logs.map((log) => log.message).join("\n"))
  await Promise.all([
    Bun.write(
      join(schema, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          "./browser": "./index.js",
          "./browser-control": "./index.js",
          "./browser-tunnel": "./index.js",
          "./session": "./index.js",
        },
      }),
    ),
    Bun.write(
      join(protocol, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          "./browser-control": "./index.js",
          "./browser-tunnel": "./index.js",
          "./groups/browser": "./index.js",
        },
      }),
    ),
  ])
}

function importPath(from: string, to: string) {
  const path = relative(from, to).replaceAll("\\", "/")
  return path.startsWith(".") ? path : `./${path}`
}

function nodeScenario(moduleURL: string) {
  return `import { createServer } from "node:http"
const sdk = await import(${JSON.stringify(moduleURL)})
if (typeof sdk.OpenCode.make !== "function") throw new Error("Missing OpenCode.make")
if (typeof sdk.BrowserDriver.define !== "function") throw new Error("Missing BrowserDriver.define")
if (typeof sdk.BrowserDriver.chromium !== "function") throw new Error("Missing BrowserDriver.chromium")
if (typeof sdk.BrowserDriverError !== "function") throw new Error("Missing BrowserDriverError")
if (!sdk.Browser.State) throw new Error("Missing canonical Browser export")

let upgrades = 0
const server = createServer()
server.on("upgrade", (_request, socket) => {
  upgrades++
  socket.end("HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") throw new Error("Server did not bind")
let disposed = 0
const driver = () => ({
  resource: undefined,
  state: () => ({ url: "about:blank", title: "", loading: false, canGoBack: false, canGoForward: false, generation: 0 }),
  subscribe: () => () => undefined,
  execute: async () => { throw new sdk.BrowserDriverError("internal", "unavailable") },
  dispose: () => { disposed++ },
})
const client = sdk.OpenCode.make({ baseUrl: \`http://127.0.0.1:\${address.port}\` })
const error = await Promise.race([
  client.browser.attach({ sessionID: "ses_node_auth_rejection", driver }).then(
    () => new Error("Expected authentication rejection"),
    (cause) => cause,
  ),
  new Promise((resolve) => setTimeout(() => resolve(new Error("Authentication rejection timed out")), 2_000)),
])
await new Promise((resolve) => setTimeout(resolve, 250))
await new Promise((resolve) => server.close(resolve))
if (!(error instanceof Error) || !error.message.includes("HTTP 401")) throw error
if (upgrades !== 1) throw new Error(\`Expected one upgrade, received \${upgrades}\`)
if (disposed !== 1) throw new Error(\`Expected one driver disposal, received \${disposed}\`)
console.log("ok")`
}
