import { NodeHttpServerRequest } from "@effect/platform-node"
import { BrowserHost } from "@opencode-ai/core/browser-host"
import { BROWSER_CONTROL_PROTOCOL, BROWSER_TUNNEL_PROTOCOL } from "@opencode-ai/protocol/groups/browser"
import { ConflictError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerResponse } from "node:http"
import { Api } from "../api"
import { BrowserControlConnection } from "../browser-control-connection"
import { BrowserTunnelServer } from "../browser-tunnel"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "../cors"

export const BrowserHandler = HttpApiBuilder.group(Api, "server.browser", (handlers) =>
  Effect.gen(function* () {
    const browser = yield* BrowserHost.Service
    const tunnels = yield* BrowserTunnelServer.Service
    const cors = yield* CorsConfig

    return handlers
      .handleRaw(
        "browser.control.connect",
        Effect.fn("BrowserHandler.control")(function* (ctx) {
          const rejected = rejectUpgrade(ctx.request.headers, BROWSER_CONTROL_PROTOCOL, cors)
          if (rejected) return rejected
          const connection = yield* browser.claim.pipe(
            Effect.mapError((error) => new ConflictError({ resource: "browser", message: error.message })),
          )
          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const peer = yield* BrowserControlConnection.make(
            socket,
            Effect.sync(() => markUpgraded(ctx.request)),
          )
          yield* connection.run(peer).pipe(
            Effect.catchTags({
              "BrowserHost.ProtocolError": (error) =>
                Effect.logWarning("Browser control protocol failed", { message: error.message }),
              "BrowserHost.ConnectionError": (error) =>
                Effect.logDebug("Browser control connection closed", { message: error.message }),
            }),
          )
          return HttpServerResponse.empty()
        }),
      )
      .handleRaw(
        "browser.tunnel.connect",
        Effect.fn("BrowserHandler.tunnel")(function* (ctx) {
          const rejected = rejectUpgrade(ctx.request.headers, BROWSER_TUNNEL_PROTOCOL, cors)
          if (rejected) return rejected
          const connection = yield* tunnels.acquire.pipe(
            Effect.mapError((error) => new ServiceUnavailableError({ service: "browser", message: error.message })),
          )
          const socket = yield* Effect.orDie(ctx.request.upgrade)
          yield* connection.run(
            socket,
            Effect.sync(() => markUpgraded(ctx.request)),
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)

function markUpgraded(request: HttpServerRequest.HttpServerRequest) {
  const socket = NodeHttpServerRequest.toIncomingMessage(request).socket
  // Bun leaves its HTTP handshake response assigned after ws takes ownership. Detaching
  // matches Node's post-upgrade socket state and lets Effect complete the raw handler normally.
  const response = Reflect.get(socket, "_httpMessage")
  if (response instanceof ServerResponse) response.detachSocket(socket)
}

function rejectUpgrade(
  headers: Readonly<Record<string, string | undefined>>,
  protocol: string,
  cors: CorsOptions | undefined,
) {
  if (!isAllowedRequestOrigin(headers.origin, headers.host, cors)) {
    return HttpServerResponse.empty({ status: 403 })
  }
  if (headers["sec-websocket-protocol"]?.split(",", 1)[0]?.trim() !== protocol) {
    return HttpServerResponse.empty({ status: 426, headers: { "sec-websocket-protocol": protocol } })
  }
  return undefined
}
