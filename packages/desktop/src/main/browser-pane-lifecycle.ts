export type BrowserPaneIdentity = {
  readonly serverKey: string
  readonly sessionID: string
  readonly bindingID: string
  readonly endpointRevision: number
}

export function sameBrowserPaneSession(left: BrowserPaneIdentity, right: BrowserPaneIdentity) {
  return left.serverKey === right.serverKey && left.sessionID === right.sessionID
}

export function sameBrowserPaneIdentity(left: BrowserPaneIdentity, right: BrowserPaneIdentity) {
  return (
    sameBrowserPaneSession(left, right) &&
    left.bindingID === right.bindingID &&
    left.endpointRevision === right.endpointRevision
  )
}

export class BrowserPaneSupersededError extends Error {
  constructor() {
    super("Browser pane context was superseded")
    this.name = "BrowserPaneSupersededError"
  }
}

export type BrowserPaneClaim<Context> = BrowserPaneIdentity & { readonly context: Context }

type Slot<Context> = BrowserPaneIdentity & {
  readonly context: Context
  pending?: Promise<BrowserPaneClaim<Context>>
  claim?: BrowserPaneClaim<Context>
}

export function createBrowserPaneLifecycle<Context extends object>(input: {
  readonly create: (identity: BrowserPaneIdentity) => {
    readonly context: Context
    readonly ready: PromiseLike<unknown>
  }
  readonly close: (context: Context) => void
}) {
  let disposed = false
  let active: Slot<Context> | undefined
  const closed = new WeakSet<Context>()

  const close = (context: Context) => {
    if (closed.has(context)) return
    closed.add(context)
    input.close(context)
  }

  const remove = (slot: Slot<Context>) => {
    if (active === slot) active = undefined
    slot.claim = undefined
    close(slot.context)
  }

  const release = (identity?: BrowserPaneIdentity) => {
    if (!active || (identity && !sameBrowserPaneIdentity(active, identity))) return false
    remove(active)
    return true
  }

  const claim = (target: BrowserPaneIdentity): Promise<BrowserPaneClaim<Context>> => {
    if (disposed) return Promise.reject(new Error("Browser pane lifecycle is disposed"))
    if (active && sameBrowserPaneIdentity(active, target)) {
      if (active.claim) return Promise.resolve(active.claim)
      if (active.pending) return active.pending
    }

    release()
    const identity: BrowserPaneIdentity = {
      serverKey: target.serverKey,
      sessionID: target.sessionID,
      bindingID: target.bindingID,
      endpointRevision: target.endpointRevision,
    }
    const created = (() => {
      try {
        return input.create(identity)
      } catch (error) {
        return { error }
      }
    })()
    if ("error" in created) return Promise.reject(created.error)

    const next: Slot<Context> = { ...identity, context: created.context }
    active = next
    next.pending = Promise.resolve(created.ready).then(
      () => {
        if (active !== next) throw new BrowserPaneSupersededError()
        const result: BrowserPaneClaim<Context> = { ...identity, context: next.context }
        next.claim = result
        next.pending = undefined
        return result
      },
      (error) => {
        if (active !== next) throw new BrowserPaneSupersededError()
        remove(next)
        throw error
      },
    )
    return next.pending
  }

  const crash = (context: Context) => {
    if (!active || active.context !== context) return undefined
    const identity: BrowserPaneIdentity = {
      serverKey: active.serverKey,
      sessionID: active.sessionID,
      bindingID: active.bindingID,
      endpointRevision: active.endpointRevision,
    }
    remove(active)
    return identity
  }

  return {
    claim,
    release,
    crash,
    state: () =>
      active && {
        context: active.context,
        serverKey: active.serverKey,
        sessionID: active.sessionID,
        bindingID: active.bindingID,
        endpointRevision: active.endpointRevision,
      },
    current: () => active?.claim,
    contains: (context: Context) => active?.context === context,
    isCurrent: (claim: BrowserPaneClaim<Context>) => active?.claim === claim,
    dispose() {
      if (disposed) return
      disposed = true
      if (active) remove(active)
    },
  }
}

export type BrowserPaneLifecycle<Context extends object> = ReturnType<typeof createBrowserPaneLifecycle<Context>>
