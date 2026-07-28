import { Browser } from "@opencode-ai/schema/browser"
import {
  BrowserDriverError,
  type BrowserDriver,
  type BrowserDriverContext,
  type BrowserDriverInstance,
} from "./driver.js"

type ChromiumViewState = {
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

type ChromiumViewEvent = {
  readonly state: ChromiumViewState
  readonly mainDocumentChanged: boolean
}

/** Platform-specific Chromium primitives used by the shared semantic driver. */
export interface ChromiumPort<Resource> {
  readonly resource: Resource
  readonly state: () => ChromiumViewState
  readonly subscribe: (listener: (event: ChromiumViewEvent) => void) => () => void
  readonly navigate: (url: string) => PromiseLike<void>
  readonly back: () => PromiseLike<void> | void
  readonly forward: () => PromiseLike<void> | void
  readonly reload: () => PromiseLike<void> | void
  readonly stop: () => void
  /** Sends CDP commands in invocation order. */
  readonly send: (method: string, params?: Record<string, unknown>) => PromiseLike<unknown>
  readonly viewport: () => { readonly width: number; readonly height: number }
  /** Captures a proportionally scaled viewport PNG without upscaling. */
  readonly screenshot: (options: { readonly maxDimension: number }) => PromiseLike<{
    readonly data: Uint8Array
    readonly width: number
    readonly height: number
  }>
  readonly dispose: () => PromiseLike<void> | void
}

/** Local controller exposed as the browser attachment resource. */
export interface ChromiumController<Resource> extends AsyncDisposable {
  readonly resource: Resource
  readonly state: () => Browser.State
  readonly subscribe: (listener: (state: Browser.State) => void) => () => void
  readonly navigate: (url: string) => Promise<void>
  readonly back: () => Promise<void>
  readonly forward: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly stop: () => void
  readonly dispose: () => Promise<void>
}

export type ChromiumDriver<Resource> = BrowserDriver<ChromiumController<Resource>>

type Ref = { readonly snapshot: number; readonly token: string; readonly objectID: string }
type SnapshotNode = {
  readonly token?: string
  readonly role: string
  readonly name: string
  readonly value: string
  readonly depth: number
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly expanded?: boolean
  readonly selected?: boolean
}
type Operation = { started: boolean }
type Page<Resource> = {
  readonly port: ChromiumPort<Resource>
  readonly lifetime: AbortSignal
  document: number
  snapshot: number
  nextRef: number
  snapshotObjectID?: string
  readonly refs: Map<string, Ref>
  readonly listeners: Set<(state: Browser.State) => void>
  readonly requests: Set<AbortController>
  state: ChromiumViewState
  unsubscribe?: () => void
  active?: AbortController
  disposed: boolean
  disposal?: Promise<void>
  queue: Promise<void>
}

const debuggerCommandTimeout = 10_000
const browserSnapshotLimit = 500
const screenshotDimensionLimit = 2_000
const screenshotByteLimit = 5 * 1_024 * 1_024

export function chromiumDriver<Resource>(
  create: (context: BrowserDriverContext) => PromiseLike<ChromiumPort<Resource>> | ChromiumPort<Resource>,
): ChromiumDriver<Resource> {
  return async (context) => {
    const port = await create(context)
    if (context.signal.aborted) {
      await cleanup(() => port.dispose())
      throw abortReason(context.signal, "Chromium driver creation was aborted")
    }
    const initialized = Promise.resolve().then(() => createInstance(port, context.signal))
    return initialized.then(
      async (instance) => {
        if (!context.signal.aborted) return instance
        await Promise.resolve(instance.dispose()).catch(() => undefined)
        throw abortReason(context.signal, "Chromium driver creation was aborted")
      },
      async (error) => {
        await cleanup(() => port.dispose())
        throw error
      },
    )
  }
}

function createInstance<Resource>(
  port: ChromiumPort<Resource>,
  lifetime: AbortSignal,
): BrowserDriverInstance<ChromiumController<Resource>> {
  requirePort(port)
  const page: Page<Resource> = {
    port,
    lifetime,
    document: 0,
    snapshot: 0,
    nextRef: 0,
    refs: new Map(),
    listeners: new Set(),
    requests: new Set(),
    state: readPortState(port.state()),
    disposed: false,
    queue: Promise.resolve(),
  }
  page.unsubscribe = port.subscribe((event) => {
    if (page.disposed) return
    if (typeof event.mainDocumentChanged !== "boolean") {
      throw new TypeError("Chromium port published an invalid view event")
    }
    if (event.mainDocumentChanged) {
      page.document++
      invalidateRefs(page)
    }
    page.state = readPortState(event.state)
    publish(page)
  })
  if (typeof page.unsubscribe !== "function") {
    throw new TypeError("Chromium port subscribe must return an unsubscribe function")
  }

  const dispose = () => disposePage(page)
  const controller: ChromiumController<Resource> = Object.freeze({
    resource: port.resource,
    state: () => contractState(page.state, page.document),
    subscribe: (listener) => subscribe(page, listener),
    navigate: (url) => localNavigate(page, url),
    back: () => localAction(page, () => port.back()),
    forward: () => localAction(page, () => port.forward()),
    reload: () => localAction(page, () => port.reload()),
    stop: () => stop(page),
    dispose,
    [Symbol.asyncDispose]: dispose,
  })
  return Object.freeze({
    resource: controller,
    state: controller.state,
    subscribe: controller.subscribe,
    execute: (command: Browser.Command, options: { readonly signal: AbortSignal }) =>
      executeDriver(page, command, options.signal),
    dispose,
  })
}

async function executeDriver<Resource>(
  page: Page<Resource>,
  command: Browser.Command,
  signal: AbortSignal,
): Promise<Browser.Result> {
  return schedule(page, [page.lifetime, signal], (abort, verify, operation) =>
    execute(page, command, abort, verify, operation),
  )
}

async function execute<Resource>(
  page: Page<Resource>,
  command: Browser.Command,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
): Promise<Browser.Result> {
  throwIfAborted(abort)
  assertAttached(page)
  assertDocument(page, command.generation)
  switch (command.type) {
    case "navigate":
      await navigate(page, command.url, abort, verify, operation)
      return { type: "navigate", state: contractState(page.state, page.document) }
    case "snapshot":
      return snapshot(page, command.generation, abort, verify, operation)
    case "click":
      await click(page, command.ref, command.generation, abort, verify, operation)
      return { type: "click", state: refreshedState(page, verify) }
    case "fill":
      await fill(page, command.ref, command.text, command.generation, abort, verify, operation)
      return { type: "fill", state: refreshedState(page, verify) }
    case "press":
      await press(page, command.key, command.generation, abort, verify, operation)
      return { type: "press", state: refreshedState(page, verify) }
    case "scroll":
      await scroll(page, command.direction, command.pixels, command.generation, abort, verify, operation)
      return { type: "scroll", state: refreshedState(page, verify) }
    case "screenshot":
      return screenshot(page, command.generation, abort, verify, operation)
  }
  throw browserError("internal", "Unsupported browser command.")
}

async function localNavigate<Resource>(page: Page<Resource>, input: string) {
  return schedule(page, [page.lifetime], (abort, verify, operation) => navigate(page, input, abort, verify, operation))
}

async function localAction<Resource>(page: Page<Resource>, run: () => PromiseLike<void> | void) {
  return schedule(page, [page.lifetime], async (abort, verify, operation) => {
    throwIfAborted(abort)
    verify()
    await startOperation(operation, run)
    verify()
  })
}

async function navigate<Resource>(
  page: Page<Resource>,
  input: string,
  abort: AbortSignal | undefined,
  verify: (() => void) | undefined,
  operation: Operation,
) {
  const url = (() => {
    try {
      return normalizeBrowserURL(input)
    } catch {
      throw browserError("invalid_url", "Only HTTP, HTTPS, and about:blank URLs are supported.")
    }
  })()
  throwIfAborted(abort)
  const onAbort = () => page.port.stop()
  abort?.addEventListener("abort", onAbort, { once: true })
  await boundedOperation(() => startOperation(operation, () => page.port.navigate(url)), {
    signal: abort,
    timeout: 30_000,
    aborted: () => browserError("aborted", "The browser navigation was aborted."),
    timedOut: () => {
      page.port.stop()
      return browserError("timeout", "The browser navigation timed out.")
    },
  })
    .catch((error) => {
      if (abort?.aborted) throw browserError("aborted", "The browser navigation was aborted.")
      if (error instanceof BrowserDriverError) throw error
      throw browserError("navigation_failed", error instanceof Error ? error.message : String(error))
    })
    .finally(() => abort?.removeEventListener("abort", onAbort))
  throwIfAborted(abort)
  verify?.()
  refresh(page)
  verify?.()
}

async function snapshot<Resource>(
  page: Page<Resource>,
  generation: number,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
): Promise<Browser.SnapshotResult> {
  throwIfAborted(abort)
  // The bounded main-world traversal intentionally omits cross-origin iframe contents and editable values.
  const object = await debuggerCommand(
    page,
    "Runtime.evaluate",
    { expression: browserSnapshotExpression(page.nextRef) },
    abort,
    operation,
  )
  const objectID = readRuntimeObjectID(object)
  const result = await debuggerCommand(
    page,
    "Runtime.callFunctionOn",
    {
      objectId: objectID,
      functionDeclaration: "function() { return this.result }",
      returnByValue: true,
    },
    abort,
    operation,
  )
    .then((response) => {
      verify()
      throwIfAborted(abort)
      assertDocument(page, generation)
      return readSnapshot(response)
    })
    .catch((error) => {
      releaseSnapshotObject(page, objectID)
      throw error
    })

  invalidateRefs(page)
  page.snapshotObjectID = objectID
  page.nextRef = Math.max(page.nextRef, result.nextRef)
  const lines = result.nodes.map((node) => {
    if (node.token) page.refs.set(node.token, { snapshot: page.snapshot, token: node.token, objectID })
    const properties = [
      node.checked === undefined ? undefined : `checked=${node.checked}`,
      node.disabled === undefined ? undefined : `disabled=${node.disabled}`,
      node.expanded === undefined ? undefined : `expanded=${node.expanded}`,
      node.selected === undefined ? undefined : `selected=${node.selected}`,
    ].filter((item): item is string => item !== undefined)
    const detail = [
      node.name ? JSON.stringify(node.name) : undefined,
      node.value && node.value !== node.name ? `value=${JSON.stringify(node.value)}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(" ")
    return `${"  ".repeat(node.depth)}${node.token ? `${node.token} ` : ""}[${node.role}]${detail ? ` ${detail}` : ""}${properties.length ? ` ${properties.join(" ")}` : ""}`
  })
  const state = readPortState(page.port.state())
  const content = [
    `Page: ${state.title.replaceAll(/\s+/g, " ").trim().slice(0, 1_024)}`,
    `URL: ${state.url.slice(0, 16_384)}`,
    "",
    ...lines,
  ]
    .join("\n")
    .slice(0, 40 * 1_024)
  assertDocument(page, generation)
  verify()
  return {
    type: "snapshot",
    state: refreshedState(page, verify),
    format: "opencode.semantic.v1",
    content,
  }
}

async function click<Resource>(
  page: Page<Resource>,
  ref: Browser.Ref,
  generation: number,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
) {
  const node = resolveRef(page, ref)
  const response = await debuggerCommand(
    page,
    "Runtime.callFunctionOn",
    {
      objectId: node.objectID,
      functionDeclaration:
        "function(token) { const element = this.refs[token]; if (!element || !element.isConnected) throw new Error('stale element'); element.scrollIntoView({ block: 'center', inline: 'center' }); const bounds = element.getBoundingClientRect(); if (bounds.width <= 0 || bounds.height <= 0) throw new Error('element has no bounds'); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } }",
      arguments: [{ value: node.token }],
      returnByValue: true,
    },
    abort,
    operation,
  )
  verify()
  const point = readPoint(response)
  throwIfAborted(abort)
  assertDocument(page, generation)
  await debuggerCommand(page, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, abort, operation)
  verify()
  assertDocument(page, generation)
  await runInputPair({
    assert: () => {
      verify()
      assertDocument(page, generation)
    },
    press: () =>
      debuggerCommand(
        page,
        "Input.dispatchMouseEvent",
        { type: "mousePressed", button: "left", clickCount: 1, ...point },
        abort,
        operation,
      ).then(() => undefined),
    release: () =>
      debuggerCommand(
        page,
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", clickCount: 1, ...point },
        undefined,
        operation,
      ).then(() => undefined),
  })
}

async function fill<Resource>(
  page: Page<Resource>,
  ref: Browser.Ref,
  text: string,
  generation: number,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
) {
  throwIfAborted(abort)
  const node = resolveRef(page, ref)
  const response = await debuggerCommand(
    page,
    "Runtime.callFunctionOn",
    {
      objectId: node.objectID,
      functionDeclaration: browserFillFunction,
      arguments: [{ value: node.token }],
      returnByValue: true,
    },
    abort,
    operation,
  )
  const editable = readRuntimeValue(response)
  verify()
  assertDocument(page, generation)
  if (editable !== true) {
    throw browserError("stale_ref", "The browser element is not editable. Call browser_snapshot again.")
  }
  const modifiers = process.platform === "darwin" ? 4 : 2
  const assert = () => {
    verify()
    assertDocument(page, generation)
  }
  await runInputPair({
    assert,
    press: () =>
      debuggerCommand(
        page,
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "a", code: "KeyA", modifiers },
        abort,
        operation,
      ).then(() => undefined),
    release: () =>
      debuggerCommand(
        page,
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "a", code: "KeyA", modifiers },
        undefined,
        operation,
      ).then(() => undefined),
  })
  await runInputPair({
    assert,
    press: () =>
      debuggerCommand(
        page,
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
        abort,
        operation,
      ).then(() => undefined),
    release: () =>
      debuggerCommand(
        page,
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
        undefined,
        operation,
      ).then(() => undefined),
  })
  await debuggerCommand(page, "Input.insertText", { text }, abort, operation)
  verify()
}

async function press<Resource>(
  page: Page<Resource>,
  key: Browser.Key,
  generation: number,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
) {
  throwIfAborted(abort)
  assertDocument(page, generation)
  const info = keyInfo(key)
  await runInputPair({
    assert: () => {
      verify()
      assertDocument(page, generation)
    },
    press: () =>
      debuggerCommand(page, "Input.dispatchKeyEvent", { type: "keyDown", ...info }, abort, operation).then(
        () => undefined,
      ),
    release: () =>
      debuggerCommand(page, "Input.dispatchKeyEvent", { type: "keyUp", ...info }, undefined, operation).then(
        () => undefined,
      ),
  })
}

async function scroll<Resource>(
  page: Page<Resource>,
  direction: Browser.Direction,
  pixels: number,
  generation: number,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
) {
  throwIfAborted(abort)
  assertDocument(page, generation)
  const bounds = page.port.viewport()
  const distance = Math.min(2_000, Math.max(1, pixels))
  await debuggerCommand(
    page,
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x: Math.max(0, Math.round(bounds.width / 2)),
      y: Math.max(0, Math.round(bounds.height / 2)),
      deltaX: direction === "left" ? -distance : direction === "right" ? distance : 0,
      deltaY: direction === "up" ? -distance : direction === "down" ? distance : 0,
    },
    abort,
    operation,
  )
  verify()
}

async function screenshot<Resource>(
  page: Page<Resource>,
  generation: number,
  abort: AbortSignal,
  verify: () => void,
  operation: Operation,
): Promise<Browser.ScreenshotResult> {
  throwIfAborted(abort)
  const source = await boundedOperation(
    () => startOperation(operation, () => page.port.screenshot({ maxDimension: screenshotDimensionLimit })),
    {
      signal: abort,
      timeout: debuggerCommandTimeout,
      aborted: () => browserError("aborted", "The browser screenshot was aborted."),
      timedOut: () => browserError("timeout", "The browser screenshot timed out."),
    },
  )
  verify()
  throwIfAborted(abort)
  assertDocument(page, generation)
  if (!record(source) || !(source.data instanceof Uint8Array)) {
    throw browserError("internal", "Invalid browser screenshot response.")
  }
  const output = new Uint8Array(source.data)
  if (output.byteLength > screenshotByteLimit) {
    throw browserError("result_too_large", "The browser screenshot exceeds 5 MiB.")
  }
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1 ||
    source.width > screenshotDimensionLimit ||
    source.height > screenshotDimensionLimit
  ) {
    throw browserError("internal", "The browser pane has no drawable area.")
  }
  assertDocument(page, generation)
  verify()
  return {
    type: "screenshot",
    state: refreshedState(page, verify),
    mediaType: "image/png",
    data: output,
    width: source.width,
    height: source.height,
  }
}

function schedule<Resource, Result>(
  page: Page<Resource>,
  signals: ReadonlyArray<AbortSignal>,
  run: (abort: AbortSignal, verify: () => void, operation: Operation) => Promise<Result>,
) {
  signals.forEach((signal) => throwIfAborted(signal))
  assertAttached(page)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const observed = [...new Set(signals)]
  observed.forEach((signal) => signal.addEventListener("abort", abort, { once: true }))
  if (observed.some((signal) => signal.aborted)) controller.abort()
  const operation = { started: false }
  const verify = () => {
    throwIfAborted(controller.signal)
    assertAttached(page)
  }
  page.requests.add(controller)
  return enqueue(page, () =>
    fenceOperation(page, operation, () => active(page, controller, () => run(controller.signal, verify, operation))),
  )
    .finally(() => {
      observed.forEach((signal) => signal.removeEventListener("abort", abort))
      page.requests.delete(controller)
    })
    .catch((error) => {
      throw normalizeBrowserError(error)
    })
}

async function fenceOperation<Resource, Result>(
  page: Page<Resource>,
  operation: Operation,
  run: () => Promise<Result>,
) {
  try {
    return await run()
  } catch (error) {
    if (operation.started && interruptedOperation(error)) void disposePage(page).catch(() => undefined)
    throw error
  }
}

function interruptedOperation(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return error.code === "aborted" || error.code === "timeout"
}

async function active<Resource, Result>(page: Page<Resource>, controller: AbortController, run: () => Promise<Result>) {
  page.active = controller
  try {
    return await run()
  } finally {
    if (page.active === controller) page.active = undefined
  }
}

function enqueue<Resource, Result>(page: Page<Resource>, run: () => Promise<Result>) {
  const result = page.queue.then(run, run)
  page.queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function stop<Resource>(page: Page<Resource>) {
  assertAttached(page)
  page.active?.abort()
  try {
    page.port.stop()
  } catch (error) {
    throw normalizeBrowserError(error)
  }
}

function subscribe<Resource>(page: Page<Resource>, listener: (state: Browser.State) => void) {
  assertAttached(page)
  page.listeners.add(listener)
  listener(contractState(page.state, page.document))
  return () => {
    page.listeners.delete(listener)
  }
}

function publish<Resource>(page: Page<Resource>) {
  const state = contractState(page.state, page.document)
  page.listeners.forEach((listener) => listener(state))
}

function refresh<Resource>(page: Page<Resource>) {
  page.state = readPortState(page.port.state())
  publish(page)
  return page.state
}

function refreshedState<Resource>(page: Page<Resource>, verify: () => void) {
  const state = contractState(refresh(page), page.document)
  verify()
  return state
}

function disposePage<Resource>(page: Page<Resource>) {
  if (page.disposal) return page.disposal
  page.disposed = true
  page.active?.abort()
  page.active = undefined
  page.requests.forEach((request) => request.abort())
  page.requests.clear()
  page.listeners.clear()
  page.snapshotObjectID = undefined
  page.snapshot++
  page.refs.clear()
  const unsubscribe = page.unsubscribe
  page.unsubscribe = undefined
  page.disposal = Promise.resolve().then(async () => {
    const results = [
      await cleanup(() => unsubscribe?.()),
      await cleanup(() => page.port.stop()),
      await cleanup(() => page.port.dispose()),
    ]
    const failure = results.find((result): result is { readonly ok: false; readonly error: unknown } => !result.ok)
    if (failure) throw failure.error
  })
  return page.disposal
}

function invalidateRefs<Resource>(page: Page<Resource>) {
  const objectID = page.snapshotObjectID
  page.snapshotObjectID = undefined
  page.snapshot++
  page.refs.clear()
  if (objectID) releaseSnapshotObject(page, objectID)
}

function releaseSnapshotObject<Resource>(page: Page<Resource>, objectID: string) {
  if (page.disposed) return
  void Promise.resolve(page.port.send("Runtime.releaseObject", { objectId: objectID })).catch(() => undefined)
}

function resolveRef<Resource>(page: Page<Resource>, ref: Browser.Ref) {
  const node = page.refs.get(normalizeBrowserRef(ref))
  if (!node || node.snapshot !== page.snapshot) {
    throw browserError("stale_ref", "The element reference is stale. Call browser_snapshot again.")
  }
  return node
}

async function debuggerCommand<Resource>(
  page: Page<Resource>,
  method: string,
  params: Record<string, unknown> | undefined,
  abort: AbortSignal | undefined,
  operation: Operation,
) {
  throwIfAborted(abort)
  assertAttached(page)
  return boundedOperation(() => startOperation(operation, () => page.port.send(method, params)), {
    signal: abort,
    timeout: debuggerCommandTimeout,
    aborted: () => browserError("aborted", "The browser action was aborted."),
    timedOut: () => browserError("timeout", "The browser command timed out."),
  }).catch((error) => {
    const stale = browserProtocolError(error)
    if (stale) throw browserError("stale_ref", stale.message)
    throw error
  })
}

function readSnapshot(input: unknown) {
  const value = readRuntimeValue(input)
  if (
    !record(value) ||
    !Array.isArray(value.nodes) ||
    !Number.isSafeInteger(value.nextRef) ||
    Number(value.nextRef) < 0
  ) {
    throw browserError("internal", "Invalid browser snapshot response.")
  }
  if (value.nodes.length > browserSnapshotLimit || !value.nodes.every(snapshotNode)) {
    throw browserError("internal", "Invalid browser snapshot nodes.")
  }
  return { nodes: value.nodes, nextRef: Number(value.nextRef) }
}

function snapshotNode(input: unknown): input is SnapshotNode {
  if (!record(input)) return false
  if (
    typeof input.role !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(input.role) ||
    input.role.length > 40 ||
    typeof input.name !== "string" ||
    input.name.length > 300 ||
    typeof input.value !== "string" ||
    input.value.length > 300 ||
    !Number.isSafeInteger(input.depth) ||
    Number(input.depth) < 0 ||
    Number(input.depth) > 6
  )
    return false
  if (input.token !== undefined && (typeof input.token !== "string" || !/^e[1-9][0-9]*$/.test(input.token))) {
    return false
  }
  if (input.expanded !== undefined && typeof input.expanded !== "boolean") return false
  return [input.checked, input.disabled, input.selected].every(
    (property) => property === undefined || typeof property === "boolean",
  )
}

function readRuntimeObjectID(input: unknown) {
  if (!record(input) || !record(input.result) || typeof input.result.objectId !== "string") {
    throw browserError("internal", "Invalid browser runtime object.")
  }
  return input.result.objectId
}

function readRuntimeValue(input: unknown) {
  if (!record(input)) throw browserError("internal", "Browser page operation failed.")
  if (input.exceptionDetails !== undefined) {
    const details = record(input.exceptionDetails) ? input.exceptionDetails : undefined
    const exception = details && record(details.exception) ? details.exception : undefined
    const message =
      (exception && typeof exception.description === "string" && exception.description) ||
      (details && typeof details.text === "string" && details.text) ||
      "Browser page operation failed."
    const stale = browserProtocolError(message)
    if (stale) throw browserError("stale_ref", stale.message)
    throw browserError("internal", message)
  }
  if (!record(input.result) || !("value" in input.result)) {
    throw browserError("internal", "Browser page operation failed.")
  }
  return input.result.value
}

function readPoint(input: unknown) {
  const value = readRuntimeValue(input)
  if (
    !record(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    throw browserError("stale_ref", "The browser element has no clickable bounds.")
  }
  return { x: value.x, y: value.y }
}

function keyInfo(key: Browser.Key) {
  const value = key === "Space" ? " " : key
  const code = key === "Space" ? "Space" : key
  const windowsVirtualKeyCode =
    key === "Enter"
      ? 13
      : key === "Tab"
        ? 9
        : key === "Escape"
          ? 27
          : key === "Backspace"
            ? 8
            : key === "Delete"
              ? 46
              : key === "Space"
                ? 32
                : undefined
  return { key: value, code, ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}) }
}

function contractState(state: ChromiumViewState, generation: number): Browser.State {
  return {
    url: state.url.slice(0, 16_384),
    title: state.title.slice(0, 1_024),
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    generation,
  }
}

function readPortState(input: ChromiumViewState): ChromiumViewState {
  if (
    !record(input) ||
    typeof input.url !== "string" ||
    typeof input.title !== "string" ||
    typeof input.loading !== "boolean" ||
    typeof input.canGoBack !== "boolean" ||
    typeof input.canGoForward !== "boolean"
  ) {
    throw new TypeError("Chromium port returned an invalid view state")
  }
  return {
    url: input.url.slice(0, 16_384),
    title: input.title.slice(0, 1_024),
    loading: input.loading,
    canGoBack: input.canGoBack,
    canGoForward: input.canGoForward,
  }
}

function requirePort<Resource>(input: ChromiumPort<Resource>) {
  if (!record(input)) throw new TypeError("Chromium driver factory returned an invalid port")
  const methods = [
    input.state,
    input.subscribe,
    input.navigate,
    input.back,
    input.forward,
    input.reload,
    input.stop,
    input.send,
    input.viewport,
    input.screenshot,
    input.dispose,
  ]
  if (methods.some((method) => typeof method !== "function")) {
    throw new TypeError("Chromium driver factory returned an invalid port")
  }
}

function assertDocument<Resource>(page: Page<Resource>, generation: number) {
  if (page.document !== generation) {
    throw browserError("stale_ref", "The browser page changed. Call browser_snapshot again.")
  }
}

function assertAttached<Resource>(page: Page<Resource>) {
  if (page.disposed) throw browserError("not_attached", "The browser page is no longer attached.")
}

function throwIfAborted(abort?: AbortSignal) {
  if (abort?.aborted) throw browserError("aborted", "The browser action was aborted.")
}

function browserError(code: Browser.ErrorCode, message: string) {
  return new BrowserDriverError(code, message.slice(0, 1_024))
}

function normalizeBrowserError(error: unknown) {
  if (error instanceof BrowserDriverError) return error
  return browserError("internal", error instanceof Error ? error.message : String(error))
}

function normalizeBrowserURL(input: string) {
  const value = input.trim()
  if (value.length > 16_384) throw new Error("Browser URL is too long")
  if (!value || value === "about:blank") return "about:blank"
  const candidate = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(:\d+)?(?:\/|$)/i.test(value)
    ? `http://${value}`
    : /^[a-z][a-z\d+.-]*:/i.test(value)
      ? value
      : `https://${value}`
  if (!URL.canParse(candidate)) throw new Error("Enter a valid HTTP or HTTPS URL")
  const url = new URL(candidate)
  if (!allowedBrowserURL(url.href)) {
    throw new Error("Only HTTP, HTTPS, and about:blank URLs without credentials are supported")
  }
  if (url.href.length > 16_384) throw new Error("Browser URL is too long")
  return url.href
}

function allowedBrowserURL(input: string) {
  if (input === "about:blank") return true
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
}

function normalizeBrowserRef(input: string) {
  const value = input.trim().replace(/^@/, "")
  if (!/^e[1-9][0-9]*$/.test(value)) throw new Error("Enter a valid browser element reference")
  return value
}

function browserSnapshotExpression(nextRef: number, limit = browserSnapshotLimit) {
  return `(() => {
    const interactive = new Set(["button","checkbox","combobox","link","menuitem","option","radio","searchbox","slider","spinbutton","switch","tab","textbox"])
    const readable = new Set(["article","cell","columnheader","heading","img","list","listitem","p","region","row","rowheader","table"])
    const roleFor = (element) => {
      const explicit = element.getAttribute("role")
      if (explicit) return explicit.slice(0, 100).split(/\\s+/)[0]
      if (/^H[1-6]$/.test(element.tagName)) return "heading"
      if (element.tagName === "INPUT") {
        if (element.type === "checkbox") return "checkbox"
        if (element.type === "radio") return "radio"
        if (element.type === "range") return "slider"
        if (element.type === "number") return "spinbutton"
        if (element.type === "search") return "searchbox"
        return "textbox"
      }
      return ({A:"link",ARTICLE:"article",BUTTON:"button",IMG:"img",LI:"listitem",OL:"list",P:"p",SELECT:"combobox",TABLE:"table",TD:"cell",TH:"columnheader",TR:"row",TEXTAREA:"textbox",UL:"list"})[element.tagName] || element.tagName.toLowerCase()
    }
    const clean = (value) => String(value || "").slice(0, 1000).replace(/\\s+/g, " ").trim().slice(0, 300)
    const textFor = (element) => {
      const queue = []
      for (let index = 0; index < element.childNodes.length && queue.length < 20; index++) queue.push(element.childNodes[index])
      const parts = []
      let visited = 0
      while (queue.length && visited++ < 20) {
        const item = queue.shift()
        if (item.nodeType === Node.TEXT_NODE) parts.push(item.nodeValue || "")
        for (let index = 0; index < item.childNodes.length && queue.length + visited < 20; index++) queue.push(item.childNodes[index])
      }
      return parts.join(" ")
    }
    const nameFor = (element, editable) => {
      const labelledBy = element.getAttribute("aria-labelledby")
      const label = labelledBy && document.getElementById(labelledBy)
      return element.getAttribute("aria-label") || (label && textFor(label)) || element.alt || (editable ? "" : textFor(element))
    }
    const nodes = []
    const refs = Object.create(null)
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
    let visited = 0
    let ref = ${Math.max(0, Math.floor(nextRef))}
    while (visited++ < ${Math.max(1, Math.floor(limit))}) {
      const element = walker.nextNode()
      if (!element) break
      if (element.hidden || element.getAttribute("aria-hidden") === "true" || (element.tagName === "INPUT" && element.type === "hidden")) continue
      const role = clean(roleFor(element)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "node"
      const isInteractive = interactive.has(role) || element.tabIndex >= 0
      const isReadable = readable.has(role)
      if (!isInteractive && !isReadable) continue
      const editable = ["INPUT","TEXTAREA","SELECT"].includes(element.tagName) || ["textbox","searchbox","combobox","spinbutton"].includes(role) || element.isContentEditable
      const token = isInteractive ? "e" + (++ref) : undefined
      if (token) refs[token] = element
      let depth = 0
      for (let item = element.parentElement; item && depth < 6; item = item.parentElement) depth++
      nodes.push({
        token,
        role,
        name: clean(nameFor(element, editable)),
        value: editable ? "" : clean(element.value),
        depth,
        checked: "checked" in element ? Boolean(element.checked) : undefined,
        disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
        expanded: element.getAttribute("aria-expanded") === "true" ? true : element.getAttribute("aria-expanded") === "false" ? false : undefined,
        selected: "selected" in element ? Boolean(element.selected) : undefined,
      })
    }
    return { result: { nodes, nextRef: ref }, refs }
  })()`
}

const browserFillFunction = `function(token) {
  const element = this.refs[token]
  if (!element || !element.isConnected) throw new Error("stale element")
  const role = String(element.getAttribute("role") || "").split(/\\s+/, 1)[0]
  const input = element.tagName === "INPUT" && !["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].includes(String(element.type).toLowerCase())
  const editable = input || element.tagName === "TEXTAREA" || element.isContentEditable || ["textbox","searchbox","combobox","spinbutton"].includes(role)
  if (!editable || element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-readonly") === "true") return false
  element.focus()
  return true
}`

function boundedOperation<Result>(
  run: () => PromiseLike<Result>,
  input: {
    readonly signal?: AbortSignal
    readonly timeout: number
    readonly aborted: () => Error
    readonly timedOut: () => Error
  },
) {
  return new Promise<Result>((resolve, reject) => {
    type OperationResult = { readonly ran: false } | { readonly ran: true; readonly value: Result }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
    const succeed = (value: Result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => fail(input.aborted())

    if (input.signal?.aborted) {
      onAbort()
      return
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => fail(input.timedOut()), input.timeout)
    void Promise.resolve()
      .then<OperationResult>(() => {
        if (settled) return { ran: false }
        return new Promise<OperationResult>((resolve, reject) => {
          run().then(
            (value) => resolve({ ran: true, value }),
            (error) => reject(error),
          )
        })
      })
      .then((result) => {
        if (result.ran) succeed(result.value)
      }, fail)
  })
}

async function runInputPair(input: {
  readonly assert: () => void
  readonly press: () => Promise<void>
  readonly release: () => Promise<void>
}) {
  input.assert()
  try {
    await input.press()
  } finally {
    await input.release()
  }
  input.assert()
}

function browserProtocolError(input: unknown): (Error & { readonly code: "stale_ref" }) | undefined {
  const message = input instanceof Error ? input.message : String(input)
  if (
    !/Could not find (node|object)|No node with given id|Node with given id does not belong|Could not push node|Could not compute box model|stale element/i.test(
      message,
    )
  )
    return undefined
  return Object.assign(new Error("The element reference is stale. Call browser_snapshot again."), {
    code: "stale_ref" as const,
  })
}

function startOperation<Result>(operation: Operation, run: () => Result) {
  operation.started = true
  return run()
}

function cleanup(task: () => unknown) {
  return Promise.resolve()
    .then(task)
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
}

function abortReason(signal: AbortSignal, message: string) {
  return signal.reason instanceof Error ? signal.reason : new Error(message)
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
