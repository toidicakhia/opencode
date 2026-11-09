import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import asset from "./pty-binding.js"

// The PTY daemon (portable-pty) and bun-pty both require ConPTY, which ships
// with Windows 10 1809 (build 17763).
function supportsConPTY() {
  if (process.platform !== "win32") return true
  const [major = 0, minor = 0, build = 0] = os.release().split(".").map(Number)
  if (major !== 10) return major > 10
  return minor > 0 || build >= 17763
}

export const available = supportsConPTY()

export async function resolveBinary(bin: string) {
  if (process.env.OPENCODE_PTY_BIN) return process.env.OPENCODE_PTY_BIN
  if (!asset) return "opencode-pty"
  if (typeof asset === "string") return asset
  return install(bin, asset)
}

async function install(
  bin: string,
  input: {
    readonly path: string
    readonly version: string
    readonly sha256: string
    readonly shim?: { readonly path: string; readonly sha256: string }
  },
) {
  const root = path.join(bin, "opencode-pty")
  await privateDirectory(root)
  const directory = path.join(root, `${input.version}-${input.sha256.slice(0, 16)}`)
  await privateDirectory(directory)
  // Windows only launches executables with their extension.
  const destination = path.join(directory, process.platform === "win32" ? "opencode-pty.exe" : "opencode-pty")
  if (!(await validateIfPresent(destination, input.sha256))) {
    await writeAtomically(input.path, destination, input.sha256, "Embedded opencode-pty checksum mismatch")
  }
  if (input.shim) {
    // The Windows 7 build imports ProcessPrng/WaitOnAddress from this DLL, so
    // it has to sit next to the executable before the daemon is spawned.
    const shim = path.join(directory, "win7shim.dll")
    if (!(await validateIfPresent(shim, input.shim.sha256))) {
      await writeAtomically(input.shim.path, shim, input.shim.sha256, "Embedded win7shim checksum mismatch")
    }
  }
  return validate(destination, input.sha256)
}

async function writeAtomically(source: string, destination: string, expected: string, mismatch: string) {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer())
  if (sha256(bytes) !== expected) throw new Error(mismatch)
  const temporary = path.join(path.dirname(destination), `${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    const file = await open(temporary, "wx", 0o700)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await chmod(temporary, 0o755)
    await rename(temporary, destination).catch(async (error) => {
      if (!(await validateIfPresent(destination, expected))) throw error
    })
  } finally {
    await rm(temporary, { force: true })
  }
  return validate(destination, expected)
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe opencode-pty directory: ${directory}`)
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`opencode-pty directory is owned by another user: ${directory}`)
  await chmod(directory, 0o700)
}

async function validateIfPresent(file: string, expected: string) {
  try {
    await validate(file, expected)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function validate(file: string, expected: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe opencode-pty executable: ${file}`)
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`opencode-pty executable is owned by another user: ${file}`)
  if (sha256(await readFile(file)) !== expected) throw new Error(`Cached opencode-pty checksum mismatch: ${file}`)
  await chmod(file, 0o755)
  return file
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
