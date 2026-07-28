import { BrowserHost } from "@opencode-ai/core/browser-host"
import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Option, Queue } from "effect"
import { Socket } from "effect/unstable/socket"
import { it } from "../../core/test/lib/effect"
import { BrowserTunnelServer } from "../src/browser-tunnel"

const sessionID = Session.ID.make("ses_pending_tunnel")
const leaseID = Browser.LeaseID.make("brl_pendingtunnel")
const state: Browser.State = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}
const end = Symbol("end")

const makeSocket = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<string | Uint8Array | typeof end>()
  const outbound = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
  return {
    inbound,
    outbound,
    socket: Socket.make({
      runRaw: (handler, options) =>
        Effect.gen(function* () {
          if (options?.onOpen) yield* options.onOpen
          while (true) {
            const message = yield* Queue.take(inbound)
            if (message === end) return
            const handled = handler(message)
            if (Effect.isEffect(handled)) yield* Effect.asVoid(handled)
          }
        }),
      writer: Effect.succeed((message) => Queue.offer(outbound, message).pipe(Effect.asVoid)),
    }),
  }
})

const cancellationCase = (cause: "reader" | "lease") =>
  Effect.gen(function* () {
    const revoked = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const browser = BrowserHost.Service.of({
      claim: Effect.die("unused"),
      lease: () =>
        Effect.succeed(
          Option.some({
            id: leaseID,
            sessionID,
            state,
            revoked: Deferred.await(revoked),
            request: () => Effect.die("unused"),
          }),
        ),
      shutdown: Effect.void,
    })
    const tunnels = yield* BrowserTunnelServer.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)),
      ),
    ).pipe(Effect.provideService(BrowserHost.Service, browser))
    const connection = yield* tunnels.acquire
    const transport = yield* makeSocket
    const running = yield* Effect.scoped(connection.run(transport.socket)).pipe(Effect.forkChild)

    const ready = yield* Queue.take(transport.outbound)
    const frame = ready instanceof Uint8Array ? ready : yield* Effect.die("expected tunnel ready frame")
    expect(yield* BrowserTunnelProtocol.decodeFromServer(frame)).toEqual({
      type: "control",
      message: { type: "browser.tunnel.ready" },
    })
    yield* Queue.offer(
      transport.inbound,
      BrowserTunnelProtocol.encodeFromDesktop({
        type: "browser.tunnel.open",
        sessionID,
        leaseID,
        target: { host: BrowserTunnel.Host.make("target.example"), port: BrowserTunnel.Port.make(443) },
        receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
        receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
      }),
    )
    yield* Deferred.await(started)

    if (cause === "reader") yield* Queue.offer(transport.inbound, end)
    if (cause === "lease") yield* Deferred.succeed(revoked, undefined)

    yield* Deferred.await(cancelled)
    yield* Fiber.join(running)
  })

describe("BrowserTunnelServer", () => {
  it.effect("interrupts a pending target dial when the reader ends or the lease is revoked", () =>
    Effect.forEach(["reader", "lease"] as const, cancellationCase, { discard: true }),
  )
})
