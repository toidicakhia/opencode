import path from "node:path"
import { dlopen } from "bun:ffi"
import { Global } from "@opencode/util/global"
import { installAsset } from "./win7-asset"
import rustPty from "../win7/rust_pty.dll" with { type: "file" }
import win7Shim from "../win7/win7shim.dll" with { type: "file" }

// Windows 7/8/8.1: `rust_pty.dll` (bun-pty) imports ProcessPrng and the futex
// APIs from win7shim.dll, and Bun's FFI dlopen cannot extract an embedded
// shared library to disk on every host, so install both files and point
// bun-pty at the real path with BUN_PTY_LIB before it is imported.

if (process.platform === "win32") {
  const directory = path.join(Global.Path.bin, "win7-pty")
  const [pty, shim] = await Promise.all([
    installAsset(rustPty, directory, "rust_pty.dll"),
    installAsset(win7Shim, directory, "win7shim.dll"),
  ])
  process.env.BUN_PTY_LIB = pty

  const kernel32 = dlopen("kernel32.dll", {
    LoadLibraryW: { args: ["ptr"], returns: "ptr" },
    GetLastError: { args: [], returns: "u32" },
  })
  try {
    if (!kernel32.symbols.LoadLibraryW(Buffer.from(`${shim}\0`, "utf16le")))
      throw new Error(`Failed to load ${shim}: Windows error ${kernel32.symbols.GetLastError()}`)
  } finally {
    kernel32.close()
  }
}
