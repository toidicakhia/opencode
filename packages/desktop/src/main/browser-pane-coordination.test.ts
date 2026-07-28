import { describe, expect, test } from "bun:test"
import {
  browserPaneEndpointRevision,
  browserPaneEndpointUpdate,
  browserPaneRetryCandidate,
  emptyBrowserPaneState,
} from "./browser-pane-coordination"
import type { BrowserPaneIdentity } from "./browser-pane-lifecycle"

const identity = (serverKey: string, sessionID: string, bindingID: string): BrowserPaneIdentity => ({
  serverKey,
  sessionID,
  bindingID,
  endpointRevision: 0,
})

describe("browser pane coordination", () => {
  test("creates a fresh empty state for a new desired identity", () => {
    const state = emptyBrowserPaneState()
    expect(state).toEqual({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false })
    expect(state).not.toBe(emptyBrowserPaneState())
  })

  test("does not relabel a stale endpoint binding with the current revision", () => {
    const endpoint = { fingerprint: "new", revision: 4 }
    expect(browserPaneEndpointRevision(endpoint, "new")).toBe(4)
    expect(browserPaneEndpointRevision(endpoint, "old")).toBe(5)
  })

  test("requires a stale window to observe the current endpoint before replacing it", () => {
    const endpoint = { fingerprint: "current", revision: 4 }
    expect(browserPaneEndpointUpdate(endpoint, { revision: 3 }, "stale")).toBe("stale")
    expect(browserPaneEndpointUpdate(endpoint, { revision: 4 }, "next")).toBe("replace")
    expect(browserPaneEndpointUpdate(endpoint, { revision: 3 }, "current")).toBe("current")
  })

  test("selects one blocked window deterministically", () => {
    const target = identity("server", "session", "target")
    expect(
      browserPaneRetryCandidate(
        [
          { id: 8, desired: identity("server", "session", "later") },
          { id: 3, desired: identity("server", "session", "first") },
          { id: 1, desired: identity("server", "other", "other") },
        ],
        target,
      ),
    ).toBe(3)
  })

  test("does not retry while another window owns or is claiming the Session", () => {
    const target = identity("server", "session", "target")
    expect(
      browserPaneRetryCandidate(
        [
          { id: 2, owner: identity("server", "session", "pending") },
          { id: 3, desired: identity("server", "session", "blocked") },
        ],
        target,
      ),
    ).toBeUndefined()
  })
})
