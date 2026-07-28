import { describe, expect, test } from "bun:test"
import {
  allowedBrowserDestination,
  allowedBrowserURL,
  browserBottomMasks,
  browserContextPartition,
  browserDestinationOrigin,
  browserHistoryDestinationOrigin,
  normalizeBrowserBounds,
} from "./browser-pane-policy"

describe("browser pane policy", () => {
  test("allows only the explicitly approved HTTP, HTTPS, or blank navigation origin", () => {
    expect(browserDestinationOrigin("https://example.com/path")).toBe("https://example.com")
    expect(allowedBrowserDestination("https://example.com/next", "https://example.com")).toBe(true)
    expect(allowedBrowserDestination("https://other.example/", "https://example.com")).toBe(false)
    expect(allowedBrowserDestination("http://example.com/", "https://example.com")).toBe(false)
    expect(allowedBrowserDestination("https://example.com/next")).toBe(false)
    expect(allowedBrowserDestination("about:blank")).toBe(true)
    expect(allowedBrowserURL("https://user:pass@example.com")).toBe(false)
    expect(allowedBrowserURL("data:text/html,test")).toBe(false)
    expect(allowedBrowserURL("about:srcdoc")).toBe(false)
  })

  test("selects the approved origin for back and forward history entries", () => {
    const history = {
      getActiveIndex: () => 1,
      getAllEntries: () => [
        { url: "https://before.example/path" },
        { url: "https://current.example/path" },
        { url: "https://after.example/path" },
      ],
    }
    expect(browserHistoryDestinationOrigin(history, -1)).toBe("https://before.example")
    expect(browserHistoryDestinationOrigin(history, 1)).toBe("https://after.example")
    expect(browserHistoryDestinationOrigin(history, 2)).toBeUndefined()
  })

  test("isolates every ephemeral Electron context", () => {
    const partition = browserContextPartition("https://server-a", "session-a", "binding-a", "context-a")
    expect(partition.startsWith("persist:")).toBe(false)
    expect(partition).not.toBe(browserContextPartition("https://server-b", "session-a", "binding-a", "context-a"))
    expect(partition).not.toBe(browserContextPartition("https://server-a", "session-b", "binding-a", "context-a"))
    expect(partition).not.toBe(browserContextPartition("https://server-a", "session-a", "binding-b", "context-a"))
    expect(partition).not.toBe(browserContextPartition("https://server-a", "session-a", "binding-a", "context-b"))
  })

  test("clamps browser bounds to the parent content view", () => {
    expect(
      normalizeBrowserBounds({ x: 90.4, y: 40.6, width: 50.2, height: 70.8 }, { x: 0, y: 0, width: 120, height: 100 }),
    ).toEqual({ x: 90, y: 41, width: 30, height: 59 })
    expect(
      normalizeBrowserBounds({ x: 10, y: 10, width: 0, height: 20 }, { x: 0, y: 0, width: 100, height: 100 }),
    ).toBeUndefined()
  })

  test("builds bottom-only corner masks", () => {
    expect(browserBottomMasks({ x: 100, y: 50, width: 400, height: 300 })).toEqual([
      { x: 100, y: 348, width: 6, height: 2 },
      { x: 494, y: 348, width: 6, height: 2 },
      { x: 100, y: 346, width: 3, height: 2 },
      { x: 497, y: 346, width: 3, height: 2 },
      { x: 100, y: 344, width: 2, height: 2 },
      { x: 498, y: 344, width: 2, height: 2 },
      { x: 100, y: 340, width: 1, height: 4 },
      { x: 499, y: 340, width: 1, height: 4 },
    ])
  })
})
