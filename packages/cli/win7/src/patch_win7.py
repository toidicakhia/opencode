#!/usr/bin/env python3
"""Patch opencode's prebuilt win32-x64 natives for Windows 7/8/8.1.

opentui.dll:
  * GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime (same signature)
  * RtlGetSystemTimePrecise (Win8+ ntdll) -> local stub that builds the same
    64-bit FILETIME from GetSystemTimeAsFileTime
  * DiscardVirtualMemory's jmp thunk -> `xor eax,eax; ret` (return
    ERROR_SUCCESS, matching Bun's Win7 shim); the now-unused import is renamed
    so the Win7 loader can resolve it.

opencode-pty.exe:
  * route bcryptprimitives!ProcessPrng and the api-ms-win-core-synch-l1-2-0
    futex imports to win7shim.dll (shipped next to the exe)
  * GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime
  * RtlGetSystemTimePrecise -> local stub (same as opentui)
"""
import sys, os
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from capstone.x86 import X86_OP_MEM, X86_REG_RIP

IMAGE_SCN_MEM_EXECUTE = 0x20000000

def name_rva(pe, entry, idx):
    ilt = entry.struct.OriginalFirstThunk or entry.struct.FirstThunk
    thunk = pe.get_qword_at_rva(ilt + idx * 8)
    if thunk & 0x8000000000000000:
        return None
    # Hint/name table entry: 2-byte hint, then the NUL-terminated name.
    return (thunk & 0x7FFFFFFF) + 2

def find_import(pe, dll, symbol):
    for entry in pe.DIRECTORY_ENTRY_IMPORT:
        if entry.dll.decode().lower() != dll.lower():
            continue
        for i, imp in enumerate(entry.imports):
            name = imp.name.decode() if imp.name else None
            if symbol is None or name == symbol:
                return entry, i, imp, name_rva(pe, entry, i)
    return None

def rename_import(pe, dll, symbol, new_name):
    found = find_import(pe, dll, symbol)
    if not found:
        raise SystemExit(f"import not found: {dll}!{symbol}")
    entry, i, imp, rva = found
    old = pe.get_string_at_rva(rva).decode()
    if len(new_name) > len(old):
        raise SystemExit(f"new name {new_name!r} longer than {old!r}")
    pe.set_bytes_at_rva(rva, new_name.encode() + b"\0")
    print(f"  {dll}!{old} -> {new_name}")

def rename_dll(pe, dll, new_name):
    for entry in pe.DIRECTORY_ENTRY_IMPORT:
        if entry.dll.decode().lower() != dll.lower():
            continue
        old = entry.dll.decode()
        if len(new_name) > len(old):
            raise SystemExit(f"new dll {new_name!r} longer than {old!r}")
        pe.set_bytes_at_rva(entry.struct.Name, new_name.encode() + b"\0")
        print(f"  dll {old} -> {new_name}")
        return
    raise SystemExit(f"dll not found: {dll}")

def iat_refs(pe, iat_va):
    base = pe.OPTIONAL_HEADER.ImageBase
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = True
    refs = []
    for sec in pe.sections:
        if not (sec.Characteristics & IMAGE_SCN_MEM_EXECUTE):
            continue
        for insn in md.disasm(sec.get_data(), base + sec.VirtualAddress):
            for op in insn.operands:
                if op.type == X86_OP_MEM:
                    ea = None
                    if op.mem.base == X86_REG_RIP:
                        ea = insn.address + insn.size + op.mem.disp
                    elif op.mem.base == 0 and op.mem.index == 0:
                        ea = op.mem.disp
                    if ea == iat_va:
                        refs.append(insn)
    return refs

def import_iat_va(pe, dll, symbol):
    found = find_import(pe, dll, symbol)
    if not found:
        raise SystemExit(f"import not found: {dll}!{symbol}")
    return found[2].address

def align_up(value, alignment):
    return (value + alignment - 1) & ~(alignment - 1)

def place_stub(pe, code):
    """Append `code` to .text's mapped tail and return its RVA."""
    sections = sorted(pe.sections, key=lambda s: s.VirtualAddress)
    for idx, sec in enumerate(sections):
        if not (sec.Characteristics & IMAGE_SCN_MEM_EXECUTE):
            continue
        if sec.Name.rstrip(b"\0").decode() != ".text":
            continue
        next_va = sections[idx + 1].VirtualAddress if idx + 1 < len(sections) else sec.VirtualAddress + sec.SizeOfRawData
        offset = align_up(sec.Misc_VirtualSize, 16)
        if offset + len(code) > sec.SizeOfRawData:
            raise SystemExit("no room in .text for the stub")
        if sec.VirtualAddress + offset + len(code) > next_va:
            raise SystemExit("stub would overlap the next section")
        pe.set_bytes_at_offset(sec.PointerToRawData + offset, code)
        sec.Misc_VirtualSize = offset + len(code)
        return sec.VirtualAddress + offset
    raise SystemExit(".text not found")

def route_rtl_get_system_time_precise(pe):
    """Rewrite the RtlGetSystemTimePrecise thunk to a local FILETIME stub."""
    found = find_import(pe, "ntdll.dll", "RtlGetSystemTimePrecise")
    if not found:
        raise SystemExit("RtlGetSystemTimePrecise import not found")
    entry, i, imp, rva = found
    refs = iat_refs(pe, imp.address)
    if len(refs) != 1 or refs[0].mnemonic != "jmp":
        raise SystemExit(f"unexpected RtlGetSystemTimePrecise refs: {[(hex(r.address), r.mnemonic) for r in refs]}")
    thunk = refs[0]
    thunk_rva = thunk.address - pe.OPTIONAL_HEADER.ImageBase

    filetime_iat = import_iat_va(pe, "KERNEL32.dll", "GetSystemTimeAsFileTime")
    base = pe.OPTIONAL_HEADER.ImageBase
    # sub rsp,0x28 ; lea rcx,[rsp+0x20] ; call [filetime IAT] ;
    # mov rax,[rsp+0x20] ; add rsp,0x28 ; ret
    code = bytearray(b"\x48\x83\xEC\x28\x48\x8D\x4C\x24\x20")
    call_at = 9  # offset of the call instruction within the stub
    # Build with a placeholder, then fix the displacement once the RVA is known.
    fake_rva = 0
    disp = filetime_iat - (base + fake_rva + call_at + 6)
    code += b"\xFF\x15" + disp.to_bytes(4, "little", signed=True)
    code += b"\x48\x8B\x44\x24\x20\x48\x83\xC4\x28\xC3"
    stub_rva = place_stub(pe, bytes(code))
    disp = filetime_iat - (base + stub_rva + call_at + 6)
    pe.set_bytes_at_rva(stub_rva + call_at, b"\xFF\x15" + disp.to_bytes(4, "little", signed=True))

    rel = stub_rva - thunk_rva
    if not (-0x80000000 <= rel <= 0x7FFFFFFF):
        raise SystemExit("stub too far from thunk")
    pe.set_bytes_at_rva(thunk_rva, b"\xE9" + rel.to_bytes(4, "little", signed=True) + b"\x90")
    # The IAT slot is no longer used; point the loader at a Win7 export so the
    # static import can resolve.
    rename_import(pe, "ntdll.dll", "RtlGetSystemTimePrecise", "RtlGetVersion")
    print(f"  RtlGetSystemTimePrecise thunk @ {hex(thunk.address)} -> local stub @ {hex(base + stub_rva)}")

def patch_opentui(src, dst):
    print("opentui.dll:")
    pe = pefile.PE(src)
    rename_import(pe, "KERNEL32.dll", "GetSystemTimePreciseAsFileTime", "GetSystemTimeAsFileTime")
    route_rtl_get_system_time_precise(pe)
    found = find_import(pe, "KERNEL32.dll", "DiscardVirtualMemory")
    if not found:
        raise SystemExit("DiscardVirtualMemory import not found")
    entry, i, imp, rva = found
    refs = iat_refs(pe, imp.address)
    if len(refs) != 1 or refs[0].mnemonic != "jmp" or len(refs[0].bytes) != 6:
        raise SystemExit(f"unexpected DiscardVirtualMemory refs: {[(hex(r.address), r.mnemonic) for r in refs]}")
    thunk = refs[0]
    pe.set_bytes_at_rva(thunk.address - pe.OPTIONAL_HEADER.ImageBase, b"\x31\xC0\xC3\x90\x90\x90")
    print(f"  DiscardVirtualMemory thunk @ {hex(thunk.address)} -> return 0")
    rename_import(pe, "KERNEL32.dll", "DiscardVirtualMemory", "GetLastError")
    pe.write(dst)
    print(f"  wrote {dst}")

def patch_pty(src, dst):
    print("opencode-pty.exe:")
    pe = pefile.PE(src)
    for dll in ("bcryptprimitives.dll", "api-ms-win-core-synch-l1-2-0.dll"):
        found = find_import(pe, dll, None)
        if not found:
            raise SystemExit(f"{dll} import not found")
        entry = found[0]
        symbols = [i.name.decode() for i in entry.imports if i.name]
        print(f"  {dll}: {', '.join(symbols)}")
    rename_dll(pe, "bcryptprimitives.dll", "win7shim.dll")
    rename_dll(pe, "api-ms-win-core-synch-l1-2-0.dll", "win7shim.dll")
    rename_import(pe, "KERNEL32.dll", "GetSystemTimePreciseAsFileTime", "GetSystemTimeAsFileTime")
    route_rtl_get_system_time_precise(pe)
    pe.write(dst)
    print(f"  wrote {dst}")

def patch_rust_pty(src, dst):
    print("rust_pty.dll:")
    pe = pefile.PE(src)
    for dll in ("bcryptprimitives.dll", "api-ms-win-core-synch-l1-2-0.dll"):
        found = find_import(pe, dll, None)
        if not found:
            raise SystemExit(f"{dll} import not found")
        entry = found[0]
        symbols = [i.name.decode() for i in entry.imports if i.name]
        print(f"  {dll}: {', '.join(symbols)}")
    rename_dll(pe, "bcryptprimitives.dll", "win7shim.dll")
    rename_dll(pe, "api-ms-win-core-synch-l1-2-0.dll", "win7shim.dll")
    pe.write(dst)
    print(f"  wrote {dst}")

if __name__ == "__main__":
    src_dir, dst_dir = sys.argv[1], sys.argv[2]
    os.makedirs(dst_dir, exist_ok=True)
    patch_opentui(os.path.join(src_dir, "opentui.dll"), os.path.join(dst_dir, "opentui.dll"))
    patch_pty(os.path.join(src_dir, "opencode-pty.exe"), os.path.join(dst_dir, "opencode-pty.exe"))
    patch_rust_pty(os.path.join(src_dir, "rust_pty.dll"), os.path.join(dst_dir, "rust_pty.dll"))
