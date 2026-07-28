import { describe, expect, test } from "bun:test"
import { BrowserPaneIpc } from "./browser-pane-ipc"

const binding = {
  serverKey: "wsl:Debian",
  sessionID: "ses_test",
  bindingID: "binding",
  endpoint: { url: "http://127.0.0.1:4096", username: "opencode", password: "secret" },
}

describe("browser pane IPC", () => {
  test("copies a valid server-scoped binding", () => {
    const parsed = BrowserPaneIpc.binding(binding)
    expect(parsed).toEqual({ ...binding, endpoint: { ...binding.endpoint, url: "http://127.0.0.1:4096/" } })
    expect(BrowserPaneIpc.identity(parsed, 2)).toEqual({
      serverKey: binding.serverKey,
      sessionID: binding.sessionID,
      bindingID: binding.bindingID,
      endpointRevision: 2,
    })
  })

  test("defaults password-only auth and rejects a username without a password", () => {
    expect(() => BrowserPaneIpc.binding({ ...binding, endpoint: { url: "http://user:pass@localhost" } })).toThrow()
    expect(BrowserPaneIpc.binding({ ...binding, endpoint: { url: "http://localhost", password: "secret" } })).toEqual({
      ...binding,
      endpoint: { url: "http://localhost/", username: "opencode", password: "secret" },
    })
    expect(() =>
      BrowserPaneIpc.binding({ ...binding, endpoint: { url: "http://localhost", username: "user" } }),
    ).toThrow()
  })

  test("validates layouts and commands", () => {
    expect(
      BrowserPaneIpc.layout({ attached: true, visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } }),
    ).toEqual({ attached: true, visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(BrowserPaneIpc.command({ type: "navigate", url: "http://localhost:3000" })).toEqual({
      type: "navigate",
      url: "http://localhost:3000",
    })
    expect(() => BrowserPaneIpc.command({ type: "evaluate" })).toThrow()
    expect(() => BrowserPaneIpc.identity(BrowserPaneIpc.binding(binding), -1)).toThrow()
  })
})
