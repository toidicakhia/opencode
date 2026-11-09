import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export function win7Directory(name: string) {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(cache, "opencode", "bin", "win7", name)
}

/** Copy an embedded asset to `directory` unless the same bytes are already there. */
export async function installAsset(source: string, directory: string, name: string) {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer())
  const sha = createHash("sha256").update(bytes).digest("hex")
  const destination = path.join(directory, name)
  const file = Bun.file(destination)
  const current = (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined
  if (!current || sha !== createHash("sha256").update(current).digest("hex")) {
    await mkdir(directory, { recursive: true })
    await Bun.write(destination, bytes)
  }
  return destination
}
