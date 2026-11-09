import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

export type OpencodePtyShim = {
  readonly source: string
  readonly sha256: string
}

export type OpencodePtyAsset = {
  readonly source: string
  readonly version: string
  readonly sha256: string
  /** Windows 7 shim DLL that must be installed next to the executable. */
  readonly shim?: OpencodePtyShim
}

type Target = {
  readonly platform: string
  readonly arch: string
  readonly libc?: "glibc" | "musl"
}

type Options = {
  /** Windows 7/8/8.1: use the patched PTY binary and its import shim. */
  readonly win7?: boolean
}

const core = createRequire(path.resolve(import.meta.dirname, "../../core/package.json"))
const pty = createRequire(core.resolve("@opencode/pty/package.json"))
const win7Dir = path.resolve(import.meta.dirname, "../win7")

async function digest(source: string) {
  return createHash("sha256")
    .update(await readFile(source))
    .digest("hex")
}

export async function resolveOpencodePty(target: Target, options?: Options): Promise<OpencodePtyAsset | undefined> {
  if (target.platform !== "darwin" && target.platform !== "linux" && target.platform !== "win32") return undefined
  if (target.arch !== "arm64" && target.arch !== "x64") return undefined

  const suffix = [target.platform, target.arch, target.platform === "linux" ? (target.libc ?? "glibc") : undefined]
    .filter(Boolean)
    .map((value) => (value === "glibc" ? "gnu" : value))
    .join("-")
  const name = `@opencode/pty-${suffix}`
  const local = process.env.OPENCODE_PTY_BIN
  if (local && (target.platform !== process.platform || target.arch !== process.arch))
    throw new Error("OPENCODE_PTY_BIN can only be embedded in a build for the current platform and architecture")
  const win7 = options?.win7 === true && target.platform === "win32" && target.arch === "x64"
  const source = local
    ? path.resolve(local)
    : win7
      ? path.join(win7Dir, "opencode-pty.exe")
      : pty.resolve(`${name}/bin/${target.platform === "win32" ? "opencode-pty.exe" : "opencode-pty"}`)
  const manifest: unknown = local
    ? { version: "local" }
    : JSON.parse(await readFile(pty.resolve(`${name}/package.json`), "utf8"))
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string")
    throw new Error(`Invalid package metadata for ${name}`)

  const shimSource = process.env.OPENCODE_PTY_SHIM
    ? path.resolve(process.env.OPENCODE_PTY_SHIM)
    : win7
      ? path.join(win7Dir, "win7shim.dll")
      : undefined
  const shim = shimSource ? { source: shimSource, sha256: await digest(shimSource) } : undefined

  return {
    source,
    version: manifest.version,
    sha256: await digest(source),
    ...(shim ? { shim } : {}),
  }
}
