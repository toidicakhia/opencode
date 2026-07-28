import { sameBrowserPaneSession, type BrowserPaneIdentity } from "./browser-pane-lifecycle"

export function emptyBrowserPaneState() {
  return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
}

export function browserPaneEndpointRevision(
  endpoint: { readonly fingerprint: string; readonly revision: number } | undefined,
  fingerprint: string,
) {
  if (!endpoint) return 0
  return endpoint.fingerprint === fingerprint ? endpoint.revision : endpoint.revision + 1
}

export function browserPaneEndpointUpdate(
  endpoint: { readonly fingerprint: string; readonly revision: number } | undefined,
  observed: { readonly revision: number } | undefined,
  fingerprint: string,
) {
  if (!endpoint || endpoint.fingerprint === fingerprint) return endpoint ? "current" : "replace"
  if (observed && observed.revision < endpoint.revision) return "stale"
  return "replace"
}

export function browserPaneRetryCandidate(
  entries: ReadonlyArray<{
    readonly id: number
    readonly owner?: BrowserPaneIdentity
    readonly desired?: BrowserPaneIdentity
  }>,
  identity: BrowserPaneIdentity,
) {
  if (entries.some((entry) => entry.owner && sameBrowserPaneSession(entry.owner, identity))) return undefined
  return entries
    .filter((entry) => !entry.owner && entry.desired && sameBrowserPaneSession(entry.desired, identity))
    .toSorted((left, right) => left.id - right.id)[0]?.id
}
