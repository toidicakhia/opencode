import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, ServiceUnavailableError } from "../errors.js"

export const BROWSER_CONTROL_PROTOCOL = "opencode.browser.control.v1"
export const BROWSER_TUNNEL_PROTOCOL = "opencode.browser.tunnel.v1"

export function isBrowserConnectURL(input: string) {
  try {
    const path = decodeURI(new URL(input, "http://localhost").pathname)
      .replace(/;[^/]*$/, "")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "")
      .toLowerCase()
    return path === "/api/browser/control" || path === "/api/browser/tunnel"
  } catch {
    return false
  }
}

const websocket = (
  identifier: string,
  summary: string,
  description: string,
  subprotocol: string,
  incoming: string,
  outgoing: string,
) =>
  OpenApi.annotations({
    identifier,
    summary,
    description,
    transform: (operation) => ({
      ...operation,
      "x-websocket": true,
      "x-websocket-subprotocol": subprotocol,
      "x-websocket-incoming": incoming,
      "x-websocket-outgoing": outgoing,
      responses: {
        ...operation.responses,
        403: { description: "WebSocket Origin is not allowed." },
        426: { description: `WebSocket subprotocol ${subprotocol} is required.` },
      },
    }),
  })

export const BrowserGroup = HttpApiGroup.make("server.browser")
  .add(
    HttpApiEndpoint.get("browser.control.connect", "/api/browser/control", {
      success: Schema.Boolean,
      error: ConflictError,
    }).annotateMerge(
      websocket(
        "v2.browser.control.connect",
        "Connect desktop browser host",
        "Establish an authenticated WebSocket carrying Session-scoped browser attachments and semantic browser commands.",
        BROWSER_CONTROL_PROTOCOL,
        "BrowserControl.FromDesktop",
        "BrowserControl.FromServer",
      ),
    ),
  )
  .add(
    HttpApiEndpoint.get("browser.tunnel.connect", "/api/browser/tunnel", {
      success: Schema.Boolean,
      error: ServiceUnavailableError,
    }).annotateMerge(
      websocket(
        "v2.browser.tunnel.connect",
        "Open browser network tunnel",
        "Establish an authenticated WebSocket carrying one TCP stream dialed from the OpenCode server.",
        BROWSER_TUNNEL_PROTOCOL,
        "BrowserTunnel.FromDesktop and binary DATA frames",
        "BrowserTunnel.FromServer and binary DATA frames",
      ),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "browser",
      description: "Desktop browser host control and server-network tunnel routes.",
    }),
  )
