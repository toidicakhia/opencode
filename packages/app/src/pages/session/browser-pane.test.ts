import { describe, expect, test } from "bun:test"
import { browserPaneAvailable, createBrowserPaneBinding } from "@/context/platform"
import { ServerConnection } from "@/context/server"

describe("browser pane availability", () => {
  const input = { platform: true, enabled: true, sessionID: "session" }

  test("keeps controls and bindings unavailable for V1 servers", () => {
    expect(browserPaneAvailable({ ...input, protocol: "v1" })).toBe(false)
  })

  test("enables controls and bindings only for V2 servers with desktop prerequisites", () => {
    expect(browserPaneAvailable({ ...input, protocol: "v2" })).toBe(true)
    expect(browserPaneAvailable({ ...input, protocol: undefined })).toBe(false)
    expect(browserPaneAvailable({ ...input, protocol: "v2", platform: false })).toBe(false)
    expect(browserPaneAvailable({ ...input, protocol: "v2", enabled: false })).toBe(false)
    expect(browserPaneAvailable({ ...input, protocol: "v2", sessionID: undefined })).toBe(false)
  })
})

describe("browser pane binding", () => {
  test("captures and freezes the route identity and endpoint credentials", () => {
    const endpoint = { url: "https://remote.example.com", username: "user", password: "secret" }
    const binding = createBrowserPaneBinding({
      serverKey: ServerConnection.Key.make("remote"),
      sessionID: "session",
      endpoint,
    })

    endpoint.url = "https://changed.example.com"
    endpoint.password = "changed"

    expect(binding.serverKey).toBe(ServerConnection.Key.make("remote"))
    expect(binding.sessionID).toBe("session")
    expect(binding.bindingID).toBeString()
    expect(binding.endpoint).toEqual({
      url: "https://remote.example.com",
      username: "user",
      password: "secret",
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.endpoint)).toBe(true)
    expect(
      createBrowserPaneBinding({
        serverKey: ServerConnection.Key.make("remote"),
        sessionID: "session",
        endpoint,
      }).bindingID,
    ).not.toBe(binding.bindingID)
  })
})
