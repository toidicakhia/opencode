import sys
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from capstone.x86 import X86_OP_MEM, X86_REG_RIP
POST = {"CreateFile2","GetCurrentThreadStackLimits","GetHostNameW","GetOverlappedResultEx","GetPackageFamilyName","GetSystemTimePreciseAsFileTime","PrefetchVirtualMemory","ProcessPrng","RtlAddGrowableFunctionTable","RtlDeleteGrowableFunctionTable","RtlGrowFunctionTable","RtlWaitOnAddress","RtlWakeAddressAll","RtlWakeAddressSingle","WaitOnAddress","WakeByAddressAll","WakeByAddressSingle","DiscardVirtualMemory","RtlGetSystemTimePrecise","CreatePseudoConsole","ResizePseudoConsole","ClosePseudoConsole","GetDpiForWindow","GetSystemCpuSetInformation","GetThreadDescription","MapViewOfFile3","SetProcessDpiAwarenessContext","SetThreadDescription","VirtualAlloc2","GetFileInformationByName","GetTempPath2W"}
for path in sys.argv[1:]:
    pe=pefile.PE(path, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT']])
    bad=[]
    for e in pe.DIRECTORY_ENTRY_IMPORT:
        dll=e.dll.decode().lower()
        if dll=="win7shim.dll": continue
        for imp in e.imports:
            if imp.name and imp.name.decode() in POST:
                bad.append(f"{e.dll.decode()}!{imp.name.decode()}")
    print(path.split('/')[-1], "OK" if not bad else "BAD: "+", ".join(bad))
