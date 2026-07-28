import { describe, expect, test } from "bun:test"
import {
  Browser,
  BrowserDriver,
  BrowserDriverError,
  type BrowserDriverContext,
  type ChromiumPort,
} from "@opencode-ai/client/node"

type PortListener = Parameters<ChromiumPort<unknown>["subscribe"]>[0]
type PortState = ReturnType<ChromiumPort<unknown>["state"]>

describe("Chromium browser driver", () => {
  test("increments generations and invalidates refs only for main-document changes", async () => {
    const app = await setup()
    const snapshot = await app.instance.execute(
      { type: "snapshot", generation: 0 },
      { signal: new AbortController().signal },
    )
    if (snapshot.type !== "snapshot") throw new Error("Expected snapshot result")
    expect(snapshot.content).toContain('e1 [button] "Save" disabled=false')

    await app.instance.execute(
      { type: "click", ref: Browser.Ref.make("e1"), generation: 0 },
      { signal: new AbortController().signal },
    )
    app.port.emit({ title: "Updated" }, false)
    expect(app.controller.state()).toMatchObject({ title: "Updated", generation: 0 })

    app.port.emit({ url: "https://next.example/" }, true)
    expect(app.controller.state()).toMatchObject({ url: "https://next.example/", generation: 1 })
    expect(app.port.calls.some((call) => call.method === "Runtime.releaseObject")).toBe(true)

    expect(
      requireDriverError(
        await rejected(
          app.instance.execute(
            { type: "click", ref: Browser.Ref.make("e1"), generation: 1 },
            { signal: new AbortController().signal },
          ),
        ),
      ),
    ).toMatchObject({ code: "stale_ref", message: "The element reference is stale. Call browser_snapshot again." })
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "stale_ref", message: "The browser page changed. Call browser_snapshot again." })
    await app.controller.dispose()
  })

  test("parses bounded snapshots and rejects untrusted oversized nodes", async () => {
    const app = await setup()
    const result = await app.instance.execute(
      { type: "snapshot", generation: 0 },
      { signal: new AbortController().signal },
    )
    if (result.type !== "snapshot") throw new Error("Expected snapshot result")
    expect(result.content).toBe(
      ["Page: Example", "URL: https://example.com/", "", '  e1 [button] "Save" disabled=false'].join("\n"),
    )
    expect(app.port.expressions[0]).toContain("while (visited++ < 500)")
    expect(app.port.expressions[0]).toContain('editable ? ""')
    expect(app.port.expressions[0]).not.toContain("textContent")
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(app.port.expressions[0] ?? "")).not.toThrow()

    app.port.snapshotValue = {
      nodes: Array.from({ length: 501 }, () => ({ role: "button", name: "Save", value: "", depth: 0 })),
      nextRef: 501,
    }
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "internal", message: "Invalid browser snapshot nodes." })

    app.port.snapshotValue = {
      nodes: [{ token: "e2", role: "bad role", name: "Save", value: "", depth: 0 }],
      nextRef: 2,
    }
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "internal", message: "Invalid browser snapshot nodes." })
    expect(app.port.calls.filter((call) => call.method === "Runtime.releaseObject").length).toBeGreaterThanOrEqual(2)
    await app.controller.dispose()
  })

  test("releases paired input and fences the port when cancellation races a press", async () => {
    const app = await setup()
    await app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal })
    const abort = new AbortController()
    const input: string[] = []
    app.port.onSend = (method, params) => {
      if (method !== "Input.dispatchMouseEvent") return app.port.response(method, params)
      if (params?.type === "mousePressed") {
        input.push("press")
        abort.abort()
        return new Promise<never>(() => undefined)
      }
      if (params?.type === "mouseReleased") input.push("release")
      return app.port.response(method, params)
    }

    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "click", ref: Browser.Ref.make("e1"), generation: 0 }, { signal: abort.signal }),
        ),
      ),
    ).toMatchObject({ code: "aborted", message: "The browser action was aborted." })
    await app.controller.dispose()
    expect(input).toEqual(["press", "release"])
    expect(app.port.stopCount).toBe(1)
    expect(app.port.disposeCount).toBe(1)
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ).code,
    ).toBe("not_attached")
  })

  test("serializes local controller work with remote commands", async () => {
    const app = await setup()
    const navigation = deferred()
    const started = deferred()
    app.port.onNavigate = () => {
      started.resolve()
      return navigation.promise
    }

    const local = app.controller.navigate("example.com")
    await started.promise
    const remote = app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal })
    await Promise.resolve()
    expect(app.port.calls.some((call) => call.method === "Runtime.evaluate")).toBe(false)
    expect(app.port.navigateURLs).toEqual(["https://example.com/"])

    navigation.resolve()
    await local
    expect((await remote).type).toBe("snapshot")
    expect(app.port.calls.some((call) => call.method === "Runtime.evaluate")).toBe(true)
    await app.controller.dispose()
  })

  test("maps navigation, CDP, and adapter failures to driver error codes", async () => {
    const app = await setup()
    expect(requireDriverError(await rejected(app.controller.navigate("javascript:alert(1)")))).toMatchObject({
      code: "invalid_url",
    })
    expect(app.port.navigateURLs).toEqual([])

    app.port.onNavigate = () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"))
    expect(requireDriverError(await rejected(app.controller.navigate("missing.example")))).toMatchObject({
      code: "navigation_failed",
      message: "net::ERR_NAME_NOT_RESOLVED",
    })

    app.port.onSend = () => Promise.reject(new Error("Could not find object with given id"))
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "stale_ref", message: "The element reference is stale. Call browser_snapshot again." })

    app.port.onSend = () => Promise.reject(new Error("Method not found"))
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "internal", message: "Method not found" })

    app.port.onSend = () => Promise.reject(new BrowserDriverError("page_crashed", "Renderer gone"))
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "snapshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "page_crashed", message: "Renderer gone" })
    await app.controller.dispose()
  })

  test("preserves viewport scroll and bounded PNG capture contracts", async () => {
    const app = await setup()
    app.port.viewportSize = { width: 101, height: 99 }
    await app.instance.execute(
      { type: "scroll", direction: "down", pixels: 5_000, generation: 0 },
      { signal: new AbortController().signal },
    )
    expect(app.port.calls.find((call) => call.params?.type === "mouseWheel")?.params).toEqual({
      type: "mouseWheel",
      x: 51,
      y: 50,
      deltaX: 0,
      deltaY: 2_000,
    })

    const result = await app.instance.execute(
      { type: "screenshot", generation: 0 },
      { signal: new AbortController().signal },
    )
    if (result.type !== "screenshot") throw new Error("Expected screenshot result")
    expect(app.port.screenshotLimits).toEqual([2_000])
    expect(result).toMatchObject({ mediaType: "image/png", width: 100, height: 50 })
    expect(result.data).toEqual(new Uint8Array([137, 80, 78, 71]))

    app.port.screenshotValue = {
      data: new Uint8Array(5 * 1_024 * 1_024 + 1),
      width: 100,
      height: 50,
    }
    expect(
      requireDriverError(
        await rejected(
          app.instance.execute({ type: "screenshot", generation: 0 }, { signal: new AbortController().signal }),
        ),
      ),
    ).toMatchObject({ code: "result_too_large", message: "The browser screenshot exceeds 5 MiB." })
    await app.controller.dispose()
  })
})

class FakeChromiumPort implements ChromiumPort<{ readonly name: string }> {
  readonly resource = { name: "fake-chromium" }
  readonly listeners = new Set<PortListener>()
  readonly calls: Array<{ readonly method: string; readonly params?: Record<string, unknown> }> = []
  readonly expressions: string[] = []
  readonly navigateURLs: string[] = []
  readonly screenshotLimits: number[] = []
  current: PortState = {
    url: "https://example.com/",
    title: "Example",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
  snapshotValue: unknown = {
    nodes: [{ token: "e1", role: "button", name: "Save", value: "", depth: 1, disabled: false }],
    nextRef: 1,
  }
  screenshotValue = { data: new Uint8Array([137, 80, 78, 71]), width: 100, height: 50 }
  viewportSize = { width: 800, height: 600 }
  onNavigate?: (url: string) => PromiseLike<void> | void
  onSend?: (method: string, params?: Record<string, unknown>) => unknown
  stopCount = 0
  disposeCount = 0
  private object = 0

  state() {
    return this.current
  }

  subscribe(listener: PortListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  navigate(url: string) {
    this.navigateURLs.push(url)
    return Promise.resolve().then(() => this.onNavigate?.(url))
  }

  back() {}

  forward() {}

  reload() {}

  stop() {
    this.stopCount++
  }

  send(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, ...(params ? { params } : {}) })
    if (method === "Runtime.evaluate" && typeof params?.expression === "string") {
      this.expressions.push(params.expression)
    }
    return Promise.resolve().then(() => (this.onSend ? this.onSend(method, params) : this.response(method, params)))
  }

  response(method: string, params?: Record<string, unknown>) {
    if (method === "Runtime.evaluate") return { result: { objectId: `snapshot-${++this.object}` } }
    if (method !== "Runtime.callFunctionOn") return {}
    if (params?.functionDeclaration === "function() { return this.result }") {
      return { result: { value: this.snapshotValue } }
    }
    if (typeof params?.functionDeclaration === "string" && params.functionDeclaration.includes("const editable")) {
      return { result: { value: true } }
    }
    return { result: { value: { x: 25, y: 40 } } }
  }

  viewport() {
    return this.viewportSize
  }

  screenshot(options: { readonly maxDimension: number }) {
    this.screenshotLimits.push(options.maxDimension)
    return Promise.resolve(this.screenshotValue)
  }

  dispose() {
    this.disposeCount++
  }

  emit(state: Partial<PortState>, mainDocumentChanged: boolean) {
    this.current = { ...this.current, ...state }
    this.listeners.forEach((listener) => listener({ state: this.current, mainDocumentChanged }))
  }
}

async function setup() {
  const port = new FakeChromiumPort()
  const lifetime = new AbortController()
  const driver = BrowserDriver.chromium(() => port)
  const instance = await driver({
    proxy: {
      url: "https://127.0.0.1:1234",
      host: "127.0.0.1",
      port: 1234,
      credentials: { username: "user", password: "pass" },
      certificateFingerprint: "fingerprint",
    },
    signal: lifetime.signal,
  } satisfies BrowserDriverContext)
  return { port, lifetime, instance, controller: instance.resource }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function rejected(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("Expected operation to reject"),
    (error: unknown) => error,
  )
}

function requireDriverError(input: unknown) {
  if (!(input instanceof BrowserDriverError)) throw input
  return input
}
