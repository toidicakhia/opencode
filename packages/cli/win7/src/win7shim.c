// Windows 7 compatibility shim for prebuilt opencode native assets.
//
// The published opencode-pty.exe and opentui.dll are linked against Windows 8+
// APIs that Windows 7/8/8.1 do not export. The PE patch script routes the
// pty's imports for these functions here; opentui's single DiscardVirtualMemory
// call is patched to a no-op thunk instead.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <stdint.h>

typedef BOOL(WINAPI *ProcessPrngFn)(PBYTE, SIZE_T);
typedef LONG(NTAPI *RtlWaitOnAddressFn)(volatile VOID *, PVOID, SIZE_T, PLARGE_INTEGER);
typedef VOID(NTAPI *RtlWakeAddressFn)(PVOID);
typedef BOOLEAN(WINAPI *SystemFunction036Fn)(PVOID, ULONG);

static ProcessPrngFn resolve_process_prng(void) {
  static ProcessPrngFn fn;
  static int resolved;
  if (!resolved) {
    resolved = 1;
    HMODULE module = GetModuleHandleW(L"bcryptprimitives.dll");
    if (module == NULL) module = LoadLibraryW(L"bcryptprimitives.dll");
    if (module != NULL) fn = (ProcessPrngFn)GetProcAddress(module, "ProcessPrng");
  }
  return fn;
}

static SystemFunction036Fn resolve_system_function_036(void) {
  static SystemFunction036Fn fn;
  static int resolved;
  if (!resolved) {
    resolved = 1;
    HMODULE module = GetModuleHandleW(L"advapi32.dll");
    if (module == NULL) module = LoadLibraryW(L"advapi32.dll");
    if (module != NULL) fn = (SystemFunction036Fn)GetProcAddress(module, "SystemFunction036");
  }
  return fn;
}

__declspec(dllexport) BOOL WINAPI ProcessPrng(PBYTE pbData, SIZE_T cbData) {
  ProcessPrngFn fn = resolve_process_prng();
  if (fn != NULL) return fn(pbData, cbData);

  SystemFunction036Fn rtlGenRandom = resolve_system_function_036();
  if (rtlGenRandom == NULL) return FALSE;

  while (cbData != 0) {
    ULONG chunk = cbData > 0xFFFFFFFFu ? 0xFFFFFFFFu : (ULONG)cbData;
    if (!rtlGenRandom(pbData, chunk)) return FALSE;
    pbData += chunk;
    cbData -= chunk;
  }
  return TRUE;
}

static RtlWaitOnAddressFn resolve_rtl_wait_on_address(void) {
  static RtlWaitOnAddressFn fn;
  static int resolved;
  if (!resolved) {
    resolved = 1;
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    if (module != NULL) fn = (RtlWaitOnAddressFn)GetProcAddress(module, "RtlWaitOnAddress");
  }
  return fn;
}

static RtlWakeAddressFn resolve_rtl_wake_address(const char *name) {
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  return module == NULL ? NULL : (RtlWakeAddressFn)GetProcAddress(module, name);
}

static BOOL have_rtl_wait_on_address(void) {
  static int available = -1;
  if (available < 0) {
    available = resolve_rtl_wait_on_address() != NULL &&
                resolve_rtl_wake_address("RtlWakeAddressSingle") != NULL &&
                resolve_rtl_wake_address("RtlWakeAddressAll") != NULL;
  }
  return available;
}

static SRWLOCK g_wait_on_address_lock = SRWLOCK_INIT;
static CONDITION_VARIABLE g_wait_on_address_cv = CONDITION_VARIABLE_INIT;

// One sized load, not memcmp: a byte-wise comparison can tear against a
// concurrent store and report the old value, which would lose the wakeup.
static BOOL address_equals(volatile VOID *address, PVOID compare, SIZE_T size) {
  switch (size) {
  case 1:
    return *(volatile uint8_t *)address == *(const uint8_t *)compare;
  case 2:
    return *(volatile uint16_t *)address == *(const uint16_t *)compare;
  case 4:
    return *(volatile uint32_t *)address == *(const uint32_t *)compare;
  case 8:
    return *(volatile uint64_t *)address == *(const uint64_t *)compare;
  default:
    return FALSE;
  }
}

__declspec(dllexport) BOOL WINAPI WaitOnAddress(volatile VOID *Address, PVOID CompareAddress, SIZE_T AddressSize,
                                                DWORD dwMilliseconds) {
  if (have_rtl_wait_on_address()) {
    RtlWaitOnAddressFn fn = resolve_rtl_wait_on_address();
    LARGE_INTEGER timeout;
    PLARGE_INTEGER timeout_ptr = NULL;
    if (dwMilliseconds != INFINITE) {
      timeout.QuadPart = -(LONGLONG)dwMilliseconds * 10000;
      timeout_ptr = &timeout;
    }
    LONG status = fn(Address, CompareAddress, AddressSize, timeout_ptr);
    if (status == 0) return TRUE;
    SetLastError(status == 0x102 ? ERROR_TIMEOUT : ERROR_INVALID_PARAMETER);
    return FALSE;
  }

  if (AddressSize != 1 && AddressSize != 2 && AddressSize != 4 && AddressSize != 8) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return FALSE;
  }

  BOOL has_deadline = dwMilliseconds != INFINITE;
  ULONGLONG deadline = has_deadline ? GetTickCount64() + dwMilliseconds : 0;

  AcquireSRWLockExclusive(&g_wait_on_address_lock);
  for (;;) {
    if (!address_equals(Address, CompareAddress, AddressSize)) {
      ReleaseSRWLockExclusive(&g_wait_on_address_lock);
      return TRUE;
    }

    DWORD wait_ms = INFINITE;
    if (has_deadline) {
      ULONGLONG now = GetTickCount64();
      if (now >= deadline) {
        ReleaseSRWLockExclusive(&g_wait_on_address_lock);
        SetLastError(ERROR_TIMEOUT);
        return FALSE;
      }
      ULONGLONG remaining = deadline - now;
      wait_ms = remaining >= INFINITE - 1 ? INFINITE - 1 : (DWORD)remaining;
    }

    if (SleepConditionVariableSRW(&g_wait_on_address_cv, &g_wait_on_address_lock, wait_ms, 0)) {
      continue;
    }

    DWORD error = GetLastError();
    if (error != ERROR_TIMEOUT) {
      ReleaseSRWLockExclusive(&g_wait_on_address_lock);
      SetLastError(error);
      return FALSE;
    }

    // A waker may have changed the value just as the timeout fired.
    if (!address_equals(Address, CompareAddress, AddressSize)) {
      ReleaseSRWLockExclusive(&g_wait_on_address_lock);
      return TRUE;
    }
    ReleaseSRWLockExclusive(&g_wait_on_address_lock);
    SetLastError(ERROR_TIMEOUT);
    return FALSE;
  }
}

__declspec(dllexport) VOID WINAPI WakeByAddressSingle(PVOID Address) {
  if (have_rtl_wait_on_address()) {
    resolve_rtl_wake_address("RtlWakeAddressSingle")(Address);
    return;
  }
  AcquireSRWLockExclusive(&g_wait_on_address_lock);
  WakeAllConditionVariable(&g_wait_on_address_cv);
  ReleaseSRWLockExclusive(&g_wait_on_address_lock);
}

__declspec(dllexport) VOID WINAPI WakeByAddressAll(PVOID Address) {
  if (have_rtl_wait_on_address()) {
    resolve_rtl_wake_address("RtlWakeAddressAll")(Address);
    return;
  }
  AcquireSRWLockExclusive(&g_wait_on_address_lock);
  WakeAllConditionVariable(&g_wait_on_address_cv);
  ReleaseSRWLockExclusive(&g_wait_on_address_lock);
}

// Not currently routed here (the patch renames the import instead), but kept
// for assets that may reference it in the future.
__declspec(dllexport) VOID WINAPI GetSystemTimePreciseAsFileTime(LPFILETIME fileTime) {
  typedef VOID(WINAPI * Fn)(LPFILETIME);
  static Fn fn;
  static int resolved;
  if (!resolved) {
    resolved = 1;
    HMODULE module = GetModuleHandleW(L"kernel32.dll");
    if (module != NULL) fn = (Fn)GetProcAddress(module, "GetSystemTimePreciseAsFileTime");
  }
  if (fn != NULL)
    fn(fileTime);
  else
    GetSystemTimeAsFileTime(fileTime);
}

__declspec(dllexport) DWORD WINAPI DiscardVirtualMemory(PVOID VirtualAddress, SIZE_T Size) {
  typedef DWORD(WINAPI * Fn)(PVOID, SIZE_T);
  static Fn fn;
  static int resolved;
  if (!resolved) {
    resolved = 1;
    HMODULE module = GetModuleHandleW(L"kernel32.dll");
    if (module != NULL) fn = (Fn)GetProcAddress(module, "DiscardVirtualMemory");
  }
  if (fn != NULL) return fn(VirtualAddress, Size);
  return ERROR_SUCCESS;
}
