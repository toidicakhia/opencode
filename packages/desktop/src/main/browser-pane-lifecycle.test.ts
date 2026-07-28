import { describe, expect, test } from "bun:test"
import {
  BrowserPaneSupersededError,
  createBrowserPaneLifecycle,
  sameBrowserPaneIdentity,
  sameBrowserPaneSession,
  type BrowserPaneIdentity,
} from "./browser-pane-lifecycle"

type Context = { readonly id: number; closed: boolean }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rejected(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("Expected operation to reject"),
    (error) => (error instanceof Error ? error : new Error(String(error))),
  )
}

function identity(serverKey: string, sessionID: string, bindingID: string, endpointRevision = 0): BrowserPaneIdentity {
  return { serverKey, sessionID, bindingID, endpointRevision }
}

function setup() {
  const ready: ReturnType<typeof deferred>[] = []
  const contexts: Context[] = []
  const closed: number[] = []
  const lifecycle = createBrowserPaneLifecycle({
    create: () => {
      const context = { id: contexts.length + 1, closed: false }
      const next = deferred()
      contexts.push(context)
      ready.push(next)
      return { context, ready: next.promise }
    },
    close: (context) => {
      context.closed = true
      closed.push(context.id)
    },
  })
  return { lifecycle, ready, contexts, closed }
}

describe("browser pane lifecycle", () => {
  test("uses exact attachment identity while coordinating ownership by server Session", async () => {
    const app = setup()
    const owner = identity("server-a", "session-a", "binding-a", 2)
    const pending = app.lifecycle.claim(owner)
    expect(app.lifecycle.claim({ ...owner })).toBe(pending)
    app.ready[0].resolve()
    const claim = await pending

    expect(await app.lifecycle.claim({ ...owner })).toBe(claim)
    expect(app.lifecycle.isCurrent({ ...claim })).toBe(false)
    expect(sameBrowserPaneIdentity(owner, { ...owner })).toBe(true)
    expect(sameBrowserPaneIdentity(owner, { ...owner, endpointRevision: 3 })).toBe(false)
    expect(sameBrowserPaneSession(owner, identity("server-a", "session-a", "binding-b"))).toBe(true)
    expect(sameBrowserPaneSession(owner, identity("server-b", "session-a", "binding-a"))).toBe(false)
  })

  test("supersedes and closes a pending context before creating its replacement", async () => {
    const app = setup()
    const first = app.lifecycle.claim(identity("server-a", "session-a", "binding-a"))
    const second = app.lifecycle.claim(identity("server-a", "session-b", "binding-b"))
    expect(app.contexts[0].closed).toBe(true)

    app.ready[0].resolve()
    expect(await rejected(first)).toBeInstanceOf(BrowserPaneSupersededError)
    app.ready[1].resolve()
    expect((await second).context).toBe(app.contexts[1])
    expect(app.closed).toEqual([1])
  })

  test("removes a crashed context and permits a clean exact-identity replacement", async () => {
    const app = setup()
    const owner = identity("server-a", "session-a", "binding-a")
    const first = app.lifecycle.claim(owner)
    const crashed = app.lifecycle.state()?.context
    if (!crashed) throw new Error("Pending browser context missing")

    expect(app.lifecycle.crash(crashed)).toEqual(owner)
    expect(app.lifecycle.crash(crashed)).toBeUndefined()
    expect(crashed.closed).toBe(true)
    const retry = app.lifecycle.claim(owner)
    app.ready[0].reject(new Error("renderer gone"))
    expect(await rejected(first)).toBeInstanceOf(BrowserPaneSupersededError)
    app.ready[1].resolve()
    expect((await retry).context).toBe(app.contexts[1])
  })

  test("releases only an exact owner and never retains the released context", async () => {
    const app = setup()
    const owner = identity("server-a", "session-a", "binding-a")
    const pending = app.lifecycle.claim(owner)
    app.ready[0].resolve()
    const claim = await pending

    expect(app.lifecycle.release({ ...owner, bindingID: "stale" })).toBe(false)
    expect(app.lifecycle.current()).toBe(claim)
    expect(app.lifecycle.release(owner)).toBe(true)
    expect(app.lifecycle.release(owner)).toBe(false)
    expect(claim.context.closed).toBe(true)

    const replacement = app.lifecycle.claim(owner)
    app.ready[1].resolve()
    expect((await replacement).context).not.toBe(claim.context)
  })

  test("disposes the active context exactly once", async () => {
    const app = setup()
    const pending = app.lifecycle.claim(identity("server-a", "session-a", "binding-a"))
    app.ready[0].resolve()
    await pending

    app.lifecycle.dispose()
    app.lifecycle.dispose()
    expect(app.closed).toEqual([1])
    expect((await rejected(app.lifecycle.claim(identity("server-a", "session-b", "binding-b")))).message).toBe(
      "Browser pane lifecycle is disposed",
    )
  })
})
