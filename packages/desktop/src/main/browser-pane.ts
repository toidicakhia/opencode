import { randomUUID } from "node:crypto"
import {
  BrowserDriver,
  type BrowserAttachment,
  type ChromiumController,
  type ChromiumPort,
  type OpenCodeClient,
} from "@opencode-ai/client/node"
import { BrowserWindow, View, WebContentsView } from "electron"
import { installBrowserNetwork } from "./browser-network"
import { browserPaneRetryCandidate, emptyBrowserPaneState } from "./browser-pane-coordination"
import {
  allowedBrowserDestination,
  browserBottomMasks,
  browserContextPartition,
  browserDestinationOrigin,
  browserHistoryDestinationOrigin,
  normalizeBrowserBounds,
  type BrowserPaneBounds,
} from "./browser-pane-policy"
import {
  BrowserPaneSupersededError,
  createBrowserPaneLifecycle,
  sameBrowserPaneIdentity,
  sameBrowserPaneSession,
  type BrowserPaneClaim,
  type BrowserPaneIdentity,
  type BrowserPaneLifecycle,
} from "./browser-pane-lifecycle"

export type { BrowserPaneBounds, BrowserPaneIdentity }

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

export type BrowserPaneState = ChromiumViewState & { readonly error?: string }

export type BrowserPaneStateUpdate = BrowserPaneIdentity & { readonly state: BrowserPaneState }

export type BrowserPaneLayout = {
  readonly attached: boolean
  readonly visible: boolean
  readonly destroy?: boolean
  readonly background?: string
  readonly bounds?: BrowserPaneBounds
}

export type BrowserPaneCommand =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "reload" }
  | { readonly type: "stop" }

export interface BrowserPaneClients {
  readonly client: (identity: BrowserPaneIdentity) => OpenCodeClient
}

type Page = {
  readonly win: BrowserWindow
  readonly identity: BrowserPaneIdentity
  readonly view: WebContentsView
  readonly session: Electron.Session
  approvedOrigin?: string
  readonly attachmentAbort: AbortController
  readonly listeners: Set<(event: ChromiumViewEvent) => void>
  attachment?: BrowserAttachment<ChromiumController<Page>>
  portDispose?: () => void
  closed: boolean
  readonly cleanups: Array<() => void>
  state: BrowserPaneState
}

type Entry = {
  readonly win: BrowserWindow
  readonly masks: View[]
  readonly lifecycle: BrowserPaneLifecycle<Page>
  desired?: DesiredLayout
  disposed: boolean
  readonly cleanups: Array<() => void>
  state: BrowserPaneState
}

type AttachedLayout = BrowserPaneLayout
type DesiredLayout = { readonly identity: BrowserPaneIdentity; readonly layout: AttachedLayout }

export function createBrowserPaneController(clients: BrowserPaneClients) {
  const entries = new Map<number, Entry>()

  const publish = (
    entry: Entry,
    page?: Page,
    input?: {
      readonly error?: string
      readonly identity?: BrowserPaneIdentity
      readonly state?: ChromiumViewState
      readonly mainDocumentChanged?: boolean
    },
  ) => {
    if (page && !entry.lifecycle.contains(page)) return entry.state
    const source = input?.state ?? (page ? readViewState(page) : entry.state)
    const message = input?.error?.slice(0, 1_024)
    const state: BrowserPaneState = {
      url: source.url.slice(0, 16_384),
      title: source.title.slice(0, 1_024),
      loading: source.loading,
      canGoBack: source.canGoBack,
      canGoForward: source.canGoForward,
      ...(message ? { error: message } : {}),
    }
    if (page) {
      page.state = state
      page.listeners.forEach((listener) =>
        listener({ state, mainDocumentChanged: input?.mainDocumentChanged === true }),
      )
      if (!entry.lifecycle.contains(page)) return state
    }
    entry.state = state
    const owner = input?.identity ?? entry.lifecycle.state() ?? page?.identity ?? entry.desired?.identity
    if (!entry.win.isDestroyed() && owner) {
      entry.win.webContents.send("browser-pane-state", {
        serverKey: owner.serverKey,
        sessionID: owner.sessionID,
        bindingID: owner.bindingID,
        endpointRevision: owner.endpointRevision,
        state,
      } satisfies BrowserPaneStateUpdate)
    }
    return state
  }

  const disposePage = (page: Page) => {
    if (page.closed) return
    page.closed = true
    page.attachmentAbort.abort(new BrowserPaneSupersededError())
    page.listeners.clear()
    const attachment = page.attachment
    page.attachment = undefined
    const portDispose = page.portDispose
    page.portDispose = undefined
    const contents = page.view.webContents
    page.cleanups.splice(0).forEach((cleanup) => {
      try {
        cleanup()
      } catch {}
    })
    try {
      portDispose?.()
    } catch {}
    try {
      page.session.setPermissionRequestHandler(null)
      page.session.setPermissionCheckHandler(null)
      page.session.setDevicePermissionHandler(null)
      page.session.setDisplayMediaRequestHandler(null)
    } finally {
      if (!contents.isDestroyed()) contents.stop()
      if (!page.win.isDestroyed()) page.win.contentView.removeChildView(page.view)
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
      void attachment?.close().catch(() => undefined)
    }
  }

  const createPage = (win: BrowserWindow, masks: View[], identity: BrowserPaneIdentity) => {
    const client = clients.client(identity)
    const view = new WebContentsView({
      webPreferences: {
        partition: browserContextPartition(identity.serverKey, identity.sessionID, identity.bindingID, randomUUID()),
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        plugins: false,
        experimentalFeatures: false,
        safeDialogs: true,
        disableDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: "document-user-activation-required",
        focusOnNavigation: false,
        devTools: false,
      },
    })
    view.setVisible(false)
    view.setBorderRadius(0)
    view.setBackgroundColor("#ffffff")
    win.contentView.addChildView(view)
    masks.forEach((mask) => win.contentView.addChildView(mask))
    const page: Page = {
      win,
      identity,
      view,
      session: view.webContents.session,
      approvedOrigin: "about:blank",
      attachmentAbort: new AbortController(),
      listeners: new Set(),
      closed: false,
      cleanups: [],
      state: emptyBrowserPaneState(),
    }

    const contents = view.webContents
    page.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    page.session.setPermissionCheckHandler(() => false)
    page.session.setDevicePermissionHandler(() => false)
    page.session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    const onDownload = (event: Electron.Event) => event.preventDefault()
    page.session.on("will-download", onDownload)
    page.cleanups.push(() => page.session.off("will-download", onDownload))

    const preventUnsafeNavigation = (
      event: Electron.Event<Electron.WebContentsWillNavigateEventParams | Electron.WebContentsWillRedirectEventParams>,
    ) => {
      if (allowedBrowserDestination(event.url, page.approvedOrigin)) return
      event.preventDefault()
      const entry = entries.get(win.id)
      if (entry) publish(entry, page, { error: "Navigation was blocked by the browser security policy" })
    }
    contents.on("will-navigate", preventUnsafeNavigation)
    page.cleanups.push(() => contents.off("will-navigate", preventUnsafeNavigation))
    contents.on("will-redirect", preventUnsafeNavigation)
    page.cleanups.push(() => contents.off("will-redirect", preventUnsafeNavigation))
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    const onBounds = (event: Electron.Event) => event.preventDefault()
    contents.on("content-bounds-updated", onBounds)
    page.cleanups.push(() => contents.off("content-bounds-updated", onBounds))

    const onPublish = () => {
      const entry = entries.get(win.id)
      if (entry) publish(entry, page)
    }
    contents.on("did-start-loading", onPublish)
    page.cleanups.push(() => contents.off("did-start-loading", onPublish))
    contents.on("did-stop-loading", onPublish)
    page.cleanups.push(() => contents.off("did-stop-loading", onPublish))
    contents.on("did-navigate", onPublish)
    page.cleanups.push(() => contents.off("did-navigate", onPublish))
    contents.on("did-navigate-in-page", onPublish)
    page.cleanups.push(() => contents.off("did-navigate-in-page", onPublish))
    contents.on("page-title-updated", onPublish)
    page.cleanups.push(() => contents.off("page-title-updated", onPublish))

    const onStartNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (!event.isMainFrame) return
      const entry = entries.get(win.id)
      if (!entry?.lifecycle.contains(page)) return
      publish(entry, page, {
        state: { ...readViewState(page), url: event.url, loading: true },
        mainDocumentChanged: !event.isSameDocument,
      })
    }
    contents.on("did-start-navigation", onStartNavigation)
    page.cleanups.push(() => contents.off("did-start-navigation", onStartNavigation))
    const onFailLoad = (
      _event: Electron.Event,
      code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || code === -3) return
      const entry = entries.get(win.id)
      if (entry) publish(entry, page, { error: description })
    }
    contents.on("did-fail-load", onFailLoad)
    page.cleanups.push(() => contents.off("did-fail-load", onFailLoad))

    const replace = (message: string) => {
      const entry = entries.get(win.id)
      if (entry) replacePage(entry, page, message)
    }
    const onRenderGone = () => replace("The browser page crashed")
    contents.on("render-process-gone", onRenderGone)
    page.cleanups.push(() => contents.off("render-process-gone", onRenderGone))
    const browserDebugger = contents.debugger
    const onDebuggerDetach = () => replace("The browser debugger detached")
    browserDebugger.on("detach", onDebuggerDetach)
    page.cleanups.push(() => browserDebugger.off("detach", onDebuggerDetach))

    const driver = BrowserDriver.chromium<Page>(async ({ proxy, signal }) => {
      const cleanup = await installBrowserNetwork({ proxy, session: page.session, webContents: contents })
      let disposed = false
      let commands = Promise.resolve()
      const dispose = () => {
        if (disposed) return
        disposed = true
        if (page.portDispose === dispose) page.portDispose = undefined
        cleanup()
        if (page.closed) return
        const entry = entries.get(win.id)
        if (entry?.lifecycle.contains(page)) {
          replacePage(entry, page, "The browser context restarted after its attachment closed")
          return
        }
        disposePage(page)
      }
      page.portDispose = dispose

      const assertCurrent = () => {
        if (signal.aborted) throw signal.reason ?? new BrowserPaneSupersededError()
        const entry = entries.get(win.id)
        if (!entry || !ownsDesiredPage(entry, page, identity)) throw new BrowserPaneSupersededError()
      }
      const port = {
        resource: page,
        state: () => readViewState(page),
        subscribe(listener: (event: ChromiumViewEvent) => void) {
          page.listeners.add(listener)
          return () => page.listeners.delete(listener)
        },
        navigate(url: string) {
          const origin = browserDestinationOrigin(url)
          if (origin === undefined) throw new Error("The browser navigation destination is not allowed")
          page.approvedOrigin = origin
          return contents.loadURL(url)
        },
        back: () => navigateHistory(page, -1),
        forward: () => navigateHistory(page, 1),
        reload: () => contents.reload(),
        stop: () => {
          if (!contents.isDestroyed()) contents.stop()
        },
        send(method: string, params?: Record<string, unknown>) {
          const result = commands.then(() => {
            if (page.closed || contents.isDestroyed()) throw new Error("The browser page is no longer available")
            if (!browserDebugger.isAttached()) browserDebugger.attach("1.3")
            return browserDebugger.sendCommand(method, params)
          })
          commands = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        },
        viewport: () => {
          const bounds = view.getBounds()
          return { width: bounds.width, height: bounds.height }
        },
        async screenshot(options: { readonly maxDimension: number }) {
          if (!Number.isFinite(options.maxDimension) || options.maxDimension < 1) {
            throw new TypeError("Browser screenshot dimension must be positive")
          }
          const source = await contents.capturePage()
          const size = source.getSize()
          const scale = Math.min(1, Math.floor(options.maxDimension) / Math.max(size.width, size.height))
          const image =
            scale < 1
              ? source.resize({
                  width: Math.max(1, Math.round(size.width * scale)),
                  height: Math.max(1, Math.round(size.height * scale)),
                  quality: "good",
                })
              : source
          const dimensions = image.getSize()
          return { data: new Uint8Array(image.toPNG()), width: dimensions.width, height: dimensions.height }
        },
        dispose,
      } satisfies ChromiumPort<Page>

      return Promise.resolve()
        .then(assertCurrent)
        .then(() => contents.loadURL("about:blank"))
        .then(() => {
          assertCurrent()
          return port
        })
        .catch((error) => {
          dispose()
          throw error
        })
    })
    const ready = client.browser
      .attach({ sessionID: identity.sessionID, driver, signal: page.attachmentAbort.signal })
      .then(async (attachment) => {
        page.attachment = attachment
        if (!page.closed) return
        await attachment.close()
        throw new BrowserPaneSupersededError()
      })

    return { context: page, ready }
  }

  const createEntry = (win: BrowserWindow) => {
    const masks = Array.from({ length: 8 }, () => new View())
    masks.forEach((mask) => {
      mask.setVisible(false)
      win.contentView.addChildView(mask)
    })
    const entry: Entry = {
      win,
      masks,
      lifecycle: createBrowserPaneLifecycle<Page>({
        create: (identity) => createPage(win, masks, identity),
        close: disposePage,
      }),
      disposed: false,
      cleanups: [],
      state: emptyBrowserPaneState(),
    }
    entries.set(win.id, entry)
    const onParentNavigation = () => detachEntry(entry)
    win.webContents.on("did-start-navigation", onParentNavigation)
    entry.cleanups.push(() => win.webContents.off("did-start-navigation", onParentNavigation))
    const onParentGone = () => detachEntry(entry)
    win.webContents.on("render-process-gone", onParentGone)
    entry.cleanups.push(() => win.webContents.off("render-process-gone", onParentGone))
    const onClosed = () => disposeEntry(entry)
    win.once("closed", onClosed)
    entry.cleanups.push(() => win.off("closed", onClosed))
    return entry
  }

  const setLayout = (win: BrowserWindow, binding: BrowserPaneIdentity, layout: BrowserPaneLayout) => {
    const entry = entries.get(win.id)
    const identity = requireIdentity(binding)
    if (layout.destroy) {
      if (entry && ownsIdentity(entry, identity)) disposeEntry(entry)
      return
    }
    if (!layout.attached) {
      if (entry) detachEntry(entry, identity)
      return
    }

    const next = entry ?? createEntry(win)
    const owner = [...entries.values()].find((item) => {
      if (item === next) return false
      const state = item.lifecycle.state()
      return state ? sameBrowserPaneSession(state, identity) : false
    })
    if (owner) {
      detachEntry(next)
      next.state = emptyBrowserPaneState()
      next.desired = { identity, layout }
      publish(next, undefined, {
        identity,
        error: "Browser tools for this server Session are attached in another window",
      })
      return
    }

    next.desired = { identity, layout }
    const state = next.lifecycle.state()
    if (!state || !sameBrowserPaneIdentity(state, identity)) {
      beginAttachment(next, identity, layout)
      return
    }
    const claim = next.lifecycle.current()
    if (!claim) {
      hideEntry(next)
      return
    }
    applyLayout(next, claim, layout)
  }

  const applyLayout = (entry: Entry, claim: BrowserPaneClaim<Page>, layout: AttachedLayout) => {
    if (!layout.visible || !layout.bounds || !entry.lifecycle.isCurrent(claim)) {
      hideEntry(entry)
      return
    }
    const bounds = normalizeBrowserBounds(layout.bounds, entry.win.contentView.getBounds())
    if (!bounds) {
      hideEntry(entry)
      return
    }
    claim.context.view.setBounds(bounds)
    claim.context.view.setVisible(true)
    const maskBounds = browserBottomMasks(bounds)
    entry.masks.forEach((mask, index) => {
      const next = maskBounds[index]
      if (!next) {
        mask.setVisible(false)
        return
      }
      mask.setBackgroundColor(layout.background ?? "#000000")
      mask.setBounds(next)
      entry.win.contentView.addChildView(mask)
      mask.setVisible(true)
    })
  }

  const beginAttachment = (entry: Entry, identity: BrowserPaneIdentity, layout: AttachedLayout) => {
    hideEntry(entry)
    entry.state = emptyBrowserPaneState()
    entry.desired = { identity, layout }
    publish(entry, undefined, { identity })
    const pending = entry.lifecycle.claim(identity)
    void pending.then(
      (claim) => {
        if (!entry.lifecycle.isCurrent(claim)) return
        const desired = entry.desired
        if (!desired || !sameBrowserPaneIdentity(desired.identity, claim)) {
          entry.lifecycle.release(claim)
          return
        }
        publish(entry, claim.context)
        applyLayout(entry, claim, desired.layout)
      },
      (error) => {
        if (error instanceof BrowserPaneSupersededError) return
        const desired = entry.desired
        if (!desired || !sameBrowserPaneIdentity(desired.identity, identity)) return
        publish(entry, undefined, { error: error instanceof Error ? error.message : String(error) })
      },
    )
  }

  const replacePage = (entry: Entry, page: Page, message: string) => {
    if (!entry.lifecycle.contains(page)) return
    hideEntry(entry)
    const identity = entry.lifecycle.crash(page)
    if (!identity) return
    publish(entry, undefined, { error: message })
    const desired = entry.desired
    if (!desired || !sameBrowserPaneIdentity(desired.identity, identity)) return
    beginAttachment(entry, desired.identity, desired.layout)
  }

  const command = async (win: BrowserWindow, binding: BrowserPaneIdentity, input: BrowserPaneCommand) => {
    const identity = requireIdentity(binding)
    const entry = entries.get(win.id)
    const claim = entry?.lifecycle.current()
    if (!entry || !claim || !sameBrowserPaneIdentity(claim, identity)) {
      throw new Error("The browser pane binding is no longer attached.")
    }
    const controller = claim.context.attachment?.resource
    if (!controller || controller.resource !== claim.context) {
      throw new Error("The browser pane binding is no longer attached.")
    }
    switch (input.type) {
      case "navigate":
        return controller.navigate(input.url)
      case "back":
        return controller.back()
      case "forward":
        return controller.forward()
      case "reload":
        return controller.reload()
      case "stop":
        controller.stop()
    }
  }

  const state = (win: BrowserWindow, binding: BrowserPaneIdentity) => {
    const identity = requireIdentity(binding)
    const entry = entries.get(win.id)
    return entry && ownsIdentity(entry, identity) ? entry.state : emptyBrowserPaneState()
  }

  const dispose = () => {
    for (const entry of entries.values()) disposeEntry(entry, false)
  }

  const detachEntry = (entry: Entry, identity?: BrowserPaneIdentity) => {
    const owner = entry.lifecycle.state()
    if (!detach(entry, identity)) return
    if (owner) retryBlocked(owner)
  }

  const invalidate = (serverKey: string) => {
    for (const entry of entries.values()) {
      const owner = entry.lifecycle.state()
      if (owner?.serverKey !== serverKey && entry.desired?.identity.serverKey !== serverKey) continue
      disposeEntry(entry, false)
    }
  }

  function disposeEntry(entry: Entry, retry = true) {
    if (entry.disposed) return
    const owner = entry.lifecycle.state()
    entry.disposed = true
    if (entries.get(entry.win.id) === entry) entries.delete(entry.win.id)
    entry.desired = undefined
    entry.lifecycle.dispose()
    entry.cleanups.splice(0).forEach((cleanup) => cleanup())
    if (!entry.win.isDestroyed()) entry.masks.forEach((mask) => entry.win.contentView.removeChildView(mask))
    if (retry && owner) retryBlocked(owner)
  }

  function retryBlocked(identity: BrowserPaneIdentity) {
    const id = browserPaneRetryCandidate(
      [...entries.values()].map((entry) => ({
        id: entry.win.id,
        owner: entry.lifecycle.state(),
        desired: entry.desired?.identity,
      })),
      identity,
    )
    if (id === undefined) return
    const entry = entries.get(id)
    const desired = entry?.desired
    if (!entry || !desired) return
    beginAttachment(entry, desired.identity, desired.layout)
  }

  return { setLayout, command, state, invalidate, dispose }
}

export type BrowserPaneController = ReturnType<typeof createBrowserPaneController>

function readViewState(page: Page): ChromiumViewState {
  const contents = page.view.webContents
  if (contents.isDestroyed()) {
    return {
      url: page.state.url,
      title: page.state.title,
      loading: false,
      canGoBack: page.state.canGoBack,
      canGoForward: page.state.canGoForward,
    }
  }
  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  }
}

function navigateHistory(page: Page, offset: -1 | 1) {
  const history = page.view.webContents.navigationHistory
  if (!history.canGoToOffset(offset)) return
  const origin = browserHistoryDestinationOrigin(history, offset)
  if (origin === undefined) throw new Error("The browser history destination is not allowed")
  page.approvedOrigin = origin
  history.goToOffset(offset)
}

function detach(entry: Entry, identity?: BrowserPaneIdentity) {
  const owner = entry.lifecycle.state() ?? entry.desired?.identity
  if (!owner || (identity && !sameBrowserPaneIdentity(owner, identity))) return false
  hideEntry(entry)
  entry.desired = undefined
  entry.lifecycle.release(identity)
  return true
}

function ownsIdentity(entry: Entry, identity: BrowserPaneIdentity) {
  const owner = entry.lifecycle.state() ?? entry.desired?.identity
  return owner ? sameBrowserPaneIdentity(owner, identity) : false
}

function ownsDesiredPage(entry: Entry, page: Page, identity: BrowserPaneIdentity) {
  const owner = entry.lifecycle.state()
  return (
    !entry.disposed &&
    !page.closed &&
    owner?.context === page &&
    sameBrowserPaneIdentity(owner, identity) &&
    !!entry.desired &&
    sameBrowserPaneIdentity(entry.desired.identity, identity)
  )
}

function hideEntry(entry: Entry) {
  const page = entry.lifecycle.state()?.context
  if (page && !page.view.webContents.isDestroyed()) page.view.setVisible(false)
  entry.masks.forEach((mask) => mask.setVisible(false))
}

function readIdentity(input: {
  readonly serverKey?: string
  readonly sessionID?: string
  readonly bindingID?: string
  readonly endpointRevision?: number
}) {
  const endpointRevision = input.endpointRevision
  if (
    !input.serverKey ||
    !input.sessionID ||
    !input.bindingID ||
    typeof endpointRevision !== "number" ||
    !Number.isSafeInteger(endpointRevision) ||
    endpointRevision < 0
  )
    return undefined
  return {
    serverKey: input.serverKey,
    sessionID: input.sessionID,
    bindingID: input.bindingID,
    endpointRevision,
  }
}

function requireIdentity(input: {
  readonly serverKey?: string
  readonly sessionID?: string
  readonly bindingID?: string
  readonly endpointRevision?: number
}): BrowserPaneIdentity {
  const identity = readIdentity(input)
  if (!identity) throw new TypeError("Browser pane attachment identity is incomplete.")
  return identity
}
