export * as BrowserPaneIpc from "./browser-pane-ipc"

import type { BrowserPaneBinding, BrowserPaneCommand, BrowserPaneLayout } from "@opencode-ai/app/browser-pane"
import type { BrowserPaneIdentity } from "./browser-pane-lifecycle"

export function binding(input: unknown): BrowserPaneBinding {
  if (!record(input) || !record(input.endpoint)) throw new TypeError("Invalid browser pane binding")
  const serverKey = bounded(input.serverKey, "server key", 2_048)
  const sessionID = bounded(input.sessionID, "Session ID", 256)
  const bindingID = bounded(input.bindingID, "binding ID", 128)
  const username = optional(input.endpoint.username, "server username", 1_024)
  const password = optional(input.endpoint.password, "server password", 4_096)
  if (username !== undefined && password === undefined) {
    throw new TypeError("Browser server endpoint username requires a password")
  }
  const parsed = new URL(bounded(input.endpoint.url, "server URL", 16_384))
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new TypeError("Browser server URL must be HTTP or HTTPS without embedded credentials")
  }
  return Object.freeze({
    serverKey,
    sessionID,
    bindingID,
    endpoint: Object.freeze({
      url: parsed.href,
      ...(password === undefined ? {} : { username: username ?? "opencode" }),
      ...(password === undefined ? {} : { password }),
    }),
  })
}

export function identity(input: BrowserPaneBinding, endpointRevision: number): BrowserPaneIdentity {
  if (!Number.isSafeInteger(endpointRevision) || endpointRevision < 0) throw new TypeError("Invalid endpoint revision")
  return { serverKey: input.serverKey, sessionID: input.sessionID, bindingID: input.bindingID, endpointRevision }
}

export function layout(input: unknown): BrowserPaneLayout {
  if (!record(input) || typeof input.attached !== "boolean" || typeof input.visible !== "boolean") {
    throw new TypeError("Invalid browser pane layout")
  }
  const bounds = record(input.bounds)
    ? {
        x: finite(input.bounds.x),
        y: finite(input.bounds.y),
        width: finite(input.bounds.width),
        height: finite(input.bounds.height),
      }
    : undefined
  return {
    attached: input.attached,
    visible: input.visible,
    ...(input.destroy === true ? { destroy: true } : {}),
    ...(typeof input.background === "string" ? { background: input.background.slice(0, 128) } : {}),
    ...(bounds ? { bounds } : {}),
  }
}

export function command(input: unknown): BrowserPaneCommand {
  if (!record(input) || typeof input.type !== "string") throw new TypeError("Invalid browser pane command")
  if (input.type === "navigate") return { type: "navigate", url: bounded(input.url, "browser URL", 16_384) }
  if (input.type === "back" || input.type === "forward" || input.type === "reload" || input.type === "stop") {
    return { type: input.type }
  }
  throw new TypeError("Invalid browser pane command")
}

function bounded(input: unknown, name: string, limit: number) {
  if (typeof input !== "string" || input.length === 0 || input.length > limit) throw new TypeError(`Invalid ${name}`)
  return input
}

function optional(input: unknown, name: string, limit: number) {
  if (input === undefined) return undefined
  return bounded(input, name, limit)
}

function finite(input: unknown) {
  if (typeof input !== "number" || !Number.isFinite(input)) throw new TypeError("Invalid browser pane bounds")
  return input
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
