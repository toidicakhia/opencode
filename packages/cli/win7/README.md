# Windows 7/8/8.1 native assets

The prebuilt `win32-x64` natives pulled from npm require Windows 8+ APIs, so a
compiled `opencode.exe` starts on Windows 7 but fails as soon as the PTY service
or the TUI native library is loaded:

| Asset | Win8+ static imports |
| --- | --- |
| `@opencode/pty-win32-x64` `opencode-pty.exe` | `bcryptprimitives!ProcessPrng`, `api-ms-win-core-synch-l1-2-0!{WaitOnAddress,WakeByAddressSingle,WakeByAddressAll}`, `kernel32!GetSystemTimePreciseAsFileTime`, `ntdll!RtlGetSystemTimePrecise` |
| `@opentui/core-win32-x64` `opentui.dll` | `kernel32!{GetSystemTimePreciseAsFileTime,DiscardVirtualMemory}`, `ntdll!RtlGetSystemTimePrecise` |
| `bun-pty` `rust_pty.dll` | `bcryptprimitives!ProcessPrng`, `api-ms-win-core-synch-l1-2-0!{WaitOnAddress,WakeByAddressSingle,WakeByAddressAll}` |

This directory vendors patched copies produced by `src/patch_win7.py`:

- `opencode-pty.exe`
  - `bcryptprimitives.dll` and `api-ms-win-core-synch-l1-2-0.dll` imports are
    redirected to `win7shim.dll`.
  - `GetSystemTimePreciseAsFileTime` → `GetSystemTimeAsFileTime`.
  - `RtlGetSystemTimePrecise` → local stub that builds the same 64-bit FILETIME
    from `GetSystemTimeAsFileTime`.
- `opentui.dll`
  - `GetSystemTimePreciseAsFileTime` → `GetSystemTimeAsFileTime`.
  - `RtlGetSystemTimePrecise` → the same local FILETIME stub.
  - The single `DiscardVirtualMemory` call goes through a `xor eax, eax; ret`
    thunk (returns `ERROR_SUCCESS`, matching Bun's Windows 7 shim); the import
    is renamed to `GetLastError` so the Windows 7 loader can resolve it.
- `rust_pty.dll`
  - `bcryptprimitives.dll` and `api-ms-win-core-synch-l1-2-0.dll` imports are
    redirected to `win7shim.dll`, same as the PTY daemon.
  - `packages/cli/src/win7.ts` installs it (plus the shim) under
    `<cache>/bin/win7-pty`, preloads the shim, and sets `BUN_PTY_LIB` before
    `bun-pty` is imported. The env var bypasses Bun's FFI extraction of the
    embedded DLL.
- `win7shim.dll`
  - Exports `ProcessPrng` (falls back to `advapi32!SystemFunction036`), the
    `WaitOnAddress`/`WakeByAddress*` futex fallback (ported from Bun's
    `workaround-missing-symbols.cpp`), and the two time APIs.
  - On Windows 8+ it uses the native `ntdll!RtlWaitOnAddress` and
    `bcryptprimitives!ProcessPrng` when available.
  - `packages/core/src/persistent-pty/binary.bun.ts` installs it next to
    `opencode-pty.exe` before spawning the daemon.

`opentui.dll` is injected by the `opentui-win7` plugin in
`packages/cli/script/build.ts` for `win32-x64` targets. The PTY binary stays a
normal `@opencode/pty` asset, but `resolveOpencodePty(..., { win7: true })` uses
the vendored copy and adds the shim.

## Regenerating

```sh
python3 -m pip install pefile capstone
python3 packages/cli/win7/src/patch_win7.py <dir-with-original-binaries> packages/cli/win7
```

`<dir-with-original-binaries>` must contain `opentui.dll` and
`opencode-pty.exe` from the npm packages pinned in `packages/cli/package.json`,
and `rust_pty.dll` from `node_modules/bun-pty/rust-pty/target/release/`.
Rebuild `win7shim.dll` with LLVM 21 and an xwin splat:

```sh
clang-cl /nologo /LD /O2 /MT /GS- \
  /winsysroot /opt/winsysroot \
  -fuse-ld=lld \
  packages/cli/win7/src/win7shim.c \
  /link /winsysroot:/opt/winsysroot /DLL /SUBSYSTEM:WINDOWS
```

Windows 7 still needs SP1 and the Universal CRT update (KB2999226) because Zig's
and Rust's static CRT code imports the `api-ms-win-crt-*` API sets.

## Limitations

The PTY daemon (`opencode-pty.exe`) and `bun-pty` both use ConPTY, which
Microsoft shipped with Windows 10 1809 (build 17763). Terminals therefore do
not work on Windows 7/8/8.1; `PersistentPty.available` reports `false` there so
the UI does not advertise them. The rest of opencode (TUI, server, models) does
not depend on ConPTY.

The build is verified under Wine in Windows 7 mode: the TUI renders through the
patched `opentui.dll`, `opencode.exe serve` starts, and `POST /api/pty` launches
the patched daemon. Actual terminal I/O cannot be checked under Wine because
Wine's ConPTY support is incomplete.
