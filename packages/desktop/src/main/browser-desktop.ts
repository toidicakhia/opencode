export * as BrowserDesktop from "./browser-desktop"

import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/node"
import { BrowserWindow } from "electron"
import { createBrowserPaneController } from "./browser-pane"
import { browserPaneEndpointRevision, browserPaneEndpointUpdate } from "./browser-pane-coordination"
import { BrowserPaneIpc } from "./browser-pane-ipc"

export function createBrowserDesktop() {
  const bindings = new Map<
    string,
    { readonly serverKey: string; readonly fingerprint: string; readonly revision: number }
  >()
  const windows = new Map<number, Map<string, { readonly fingerprint: string; readonly revision: number }>>()
  const endpoints = new Map<
    string,
    { readonly fingerprint: string; readonly revision: number; readonly client: OpenCodeClient }
  >()
  const pane = createBrowserPaneController({
    client(identity) {
      const endpoint = endpoints.get(identity.serverKey)
      if (!endpoint || endpoint.revision !== identity.endpointRevision) {
        throw new Error("Browser server endpoint is unavailable")
      }
      return endpoint.client
    },
  })

  const observations = (win: BrowserWindow) => {
    const existing = windows.get(win.id)
    if (existing) return existing
    const created = new Map<string, { readonly fingerprint: string; readonly revision: number }>()
    windows.set(win.id, created)
    win.once("closed", () => windows.delete(win.id))
    return created
  }

  const bind = (win: BrowserWindow, input: unknown) => {
    const binding = BrowserPaneIpc.binding(input)
    const fingerprint = JSON.stringify(binding.endpoint)
    const observed = observations(win)
    const known = bindings.get(binding.bindingID)
    if (known) {
      if (known.serverKey !== binding.serverKey || known.fingerprint !== fingerprint) {
        throw new Error("Browser pane binding endpoint changed after creation")
      }
      return BrowserPaneIpc.identity(binding, known.revision)
    }
    const previous = endpoints.get(binding.serverKey)
    const update = browserPaneEndpointUpdate(previous, observed.get(binding.serverKey), fingerprint)
    if (update === "current" && previous) {
      bindings.set(binding.bindingID, { serverKey: binding.serverKey, fingerprint, revision: previous.revision })
      observed.set(binding.serverKey, { fingerprint, revision: previous.revision })
      return BrowserPaneIpc.identity(binding, previous.revision)
    }
    if (update === "stale" && previous) {
      const revision = observed.get(binding.serverKey)?.revision ?? previous.revision - 1
      bindings.set(binding.bindingID, { serverKey: binding.serverKey, fingerprint, revision })
      return BrowserPaneIpc.identity(binding, revision)
    }
    if (previous) {
      pane.invalidate(binding.serverKey)
      BrowserWindow.getAllWindows().forEach((other) => {
        if (other.id === win.id) return
        observations(other).set(binding.serverKey, {
          fingerprint: previous.fingerprint,
          revision: previous.revision,
        })
      })
    }
    const revision = (previous?.revision ?? -1) + 1
    const authorization =
      binding.endpoint.password === undefined
        ? undefined
        : `Basic ${Buffer.from(`${binding.endpoint.username ?? "opencode"}:${binding.endpoint.password}`).toString("base64")}`
    endpoints.set(
      binding.serverKey,
      Object.freeze({
        fingerprint,
        revision,
        client: Object.freeze(
          OpenCode.make({
            baseUrl: binding.endpoint.url,
            headers: authorization ? Object.freeze({ Authorization: authorization }) : undefined,
          }),
        ),
      }),
    )
    bindings.set(binding.bindingID, { serverKey: binding.serverKey, fingerprint, revision })
    observed.set(binding.serverKey, { fingerprint, revision })
    return BrowserPaneIpc.identity(binding, revision)
  }

  const currentIdentity = (binding: ReturnType<typeof BrowserPaneIpc.binding>) => {
    const known = bindings.get(binding.bindingID)
    if (known?.serverKey === binding.serverKey && known.fingerprint === JSON.stringify(binding.endpoint)) {
      return BrowserPaneIpc.identity(binding, known.revision)
    }
    const endpoint = endpoints.get(binding.serverKey)
    return BrowserPaneIpc.identity(binding, browserPaneEndpointRevision(endpoint, JSON.stringify(binding.endpoint)))
  }

  return {
    setLayout(win: BrowserWindow, binding: unknown, layout: unknown) {
      const parsedBinding = BrowserPaneIpc.binding(binding)
      const parsedLayout = BrowserPaneIpc.layout(layout)
      const identity = parsedLayout.attached ? bind(win, parsedBinding) : currentIdentity(parsedBinding)
      if (parsedLayout.attached && endpoints.get(identity.serverKey)?.revision !== identity.endpointRevision) return
      pane.setLayout(win, identity, parsedLayout)
    },
    command(win: BrowserWindow, binding: unknown, command: unknown) {
      const parsed = BrowserPaneIpc.binding(binding)
      return pane.command(win, currentIdentity(parsed), BrowserPaneIpc.command(command))
    },
    state(win: BrowserWindow, binding: unknown) {
      const parsed = BrowserPaneIpc.binding(binding)
      const identity = currentIdentity(parsed)
      return { ...identity, state: pane.state(win, identity) }
    },
    dispose() {
      pane.dispose()
      bindings.clear()
      windows.clear()
      endpoints.clear()
    },
  }
}

export type Controller = ReturnType<typeof createBrowserDesktop>
