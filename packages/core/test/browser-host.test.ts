import { describe, expect } from "bun:test"
import { BrowserHost } from "@opencode-ai/core/browser-host"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Session } from "@opencode-ai/schema/session"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Queue, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.effect(
    BrowserHost.Service,
    BrowserHost.make(() => Effect.succeed(true)),
  ),
)
const denied = testEffect(
  Layer.effect(
    BrowserHost.Service,
    BrowserHost.make(() => Effect.succeed(false)),
  ),
)
const sessionID = Session.ID.make("ses_browser_host")
const state: Browser.State = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 3,
}

const makePeer = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<BrowserControl.FromDesktop, BrowserHost.ConnectionError>()
  const outbound = yield* Queue.unbounded<BrowserControl.FromServer>()
  const closed = yield* Deferred.make<{ close: BrowserHost.CloseReason; message: string }>()
  return {
    peer: {
      messages: Stream.fromQueue(inbound),
      send: (message) => Queue.offer(outbound, message).pipe(Effect.asVoid),
      close: (close, message) => Deferred.succeed(closed, { close, message }).pipe(Effect.asVoid),
    } satisfies BrowserHost.Peer,
    inbound,
    outbound,
    closed,
  }
})

const attach = (peer: Effect.Success<typeof makePeer>, leaseID: Browser.LeaseID, revision = 1) =>
  Queue.offer(peer.inbound, {
    type: "browser.control.sync" as const,
    revision,
    attachments: [{ sessionID, leaseID, state }],
  }).pipe(Effect.asVoid)

const awaitSynced = Effect.fn("BrowserHostTest.awaitSynced")(function* (peer: Effect.Success<typeof makePeer>) {
  const message = yield* Queue.take(peer.outbound)
  if (message.type !== "browser.control.synced") throw new Error("expected sync acknowledgement")
  return message
})

const awaitLease = Effect.fn("BrowserHostTest.awaitLease")(function* (host: BrowserHost.Interface) {
  while (true) {
    const lease = yield* host.lease(sessionID)
    if (Option.isSome(lease)) return lease.value
    yield* Effect.yieldNow
  }
})

describe("BrowserHost", () => {
  it.effect("correlates requests with the exact synced lease", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      yield* Effect.forkChild(connection.run(transport.peer))
      const leaseID = Browser.LeaseID.make("brl_first")
      yield* attach(transport, leaseID)
      expect(yield* awaitSynced(transport)).toEqual({ type: "browser.control.synced", revision: 1 })
      const lease = yield* awaitLease(host)

      const result = yield* Effect.forkChild(lease.request({ type: "snapshot", generation: state.generation }))
      const request = yield* Queue.take(transport.outbound)
      expect(request).toMatchObject({
        type: "browser.control.request",
        sessionID,
        leaseID,
        command: { type: "snapshot", generation: state.generation },
      })
      if (request.type !== "browser.control.request") throw new Error("expected request")
      yield* Queue.offer(transport.inbound, {
        type: "browser.control.response",
        requestID: request.requestID,
        leaseID,
        outcome: {
          type: "success",
          result: { type: "snapshot", state, format: "opencode.semantic.v1", content: "page" },
        },
      })

      expect(yield* Fiber.join(result)).toEqual({
        type: "snapshot",
        state,
        format: "opencode.semantic.v1",
        content: "page",
      })
    }),
  )

  it.effect("revokes captured leases instead of redirecting them", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      yield* Effect.forkChild(connection.run(transport.peer))
      yield* attach(transport, Browser.LeaseID.make("brl_first"))
      yield* awaitSynced(transport)
      const first = yield* awaitLease(host)

      yield* attach(transport, Browser.LeaseID.make("brl_second"), 2)
      yield* awaitSynced(transport)
      yield* first.revoked
      const stale = yield* first.request({ type: "snapshot", generation: state.generation }).pipe(Effect.result)
      expect(stale).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.RequestError", code: "not_attached" },
      })
      expect((yield* awaitLease(host)).id).toBe(Browser.LeaseID.make("brl_second"))
    }),
  )

  it.effect("sends cancellation when request execution is interrupted", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      yield* Effect.forkChild(connection.run(transport.peer))
      const leaseID = Browser.LeaseID.make("brl_cancel")
      yield* attach(transport, leaseID)
      yield* awaitSynced(transport)
      const lease = yield* awaitLease(host)

      const fiber = yield* Effect.forkChild(
        lease.request({ type: "click", ref: Browser.Ref.make("e1"), generation: state.generation }),
      )
      const request = yield* Queue.take(transport.outbound)
      if (request.type !== "browser.control.request") throw new Error("expected request")
      yield* Fiber.interrupt(fiber)

      expect(yield* Queue.take(transport.outbound)).toEqual({
        type: "browser.control.cancel",
        requestID: request.requestID,
        leaseID,
      })
    }),
  )

  it.effect("settles the maximum legal response burst without overflowing transport assumptions", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      yield* Effect.forkChild(connection.run(transport.peer))
      const leaseID = Browser.LeaseID.make("brl_burst")
      yield* attach(transport, leaseID)
      yield* awaitSynced(transport)
      const lease = yield* awaitLease(host)
      const scope = yield* Scope.Scope

      const fibers = yield* Effect.forEach(
        Array.from({ length: 32 }),
        () =>
          Effect.forkIn(lease.request({ type: "snapshot", generation: state.generation }), scope, {
            startImmediately: true,
          }),
        { concurrency: "unbounded" },
      )
      while ((yield* Queue.size(transport.outbound)) < 32) yield* Effect.yieldNow
      const requests = yield* Queue.takeAll(transport.outbound)
      expect(requests.length).toBe(32)
      yield* Effect.forEach(
        requests,
        (request) => {
          if (request.type !== "browser.control.request") return Effect.die("expected request")
          return Queue.offer(transport.inbound, {
            type: "browser.control.response" as const,
            requestID: request.requestID,
            leaseID,
            outcome: {
              type: "success" as const,
              result: {
                type: "snapshot" as const,
                state,
                format: "opencode.semantic.v1" as const,
                content: "page",
              },
            },
          })
        },
        { concurrency: "unbounded", discard: true },
      )
      expect((yield* Fiber.joinAll(fibers)).length).toBe(32)
    }),
  )

  it.effect("rejects a second process-local browser owner", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      yield* host.claim
      expect(yield* host.claim.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.OwnerExistsError" },
      })
    }),
  )

  it.effect("does not admit another owner after shutdown", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      yield* host.claim
      yield* host.shutdown
      yield* host.shutdown

      expect(yield* host.claim.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.OwnerExistsError", message: expect.stringContaining("shutting down") },
      })
    }),
  )

  it.effect("requires an initial attachment snapshot", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      const running = yield* Effect.forkChild(connection.run(transport.peer))
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(running).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.ProtocolError" },
      })
      expect(yield* host.claim.pipe(Effect.as(true))).toBe(true)
    }),
  )

  it.effect("revokes leases when their Session is deleted", () =>
    Effect.gen(function* () {
      const available = { value: true }
      const host = yield* BrowserHost.make(() => Effect.succeed(available.value))
      const connection = yield* host.claim
      const transport = yield* makePeer
      yield* Effect.forkChild(connection.run(transport.peer))
      yield* attach(transport, Browser.LeaseID.make("brl_deleted"))
      yield* awaitSynced(transport)
      const lease = Option.getOrThrow(yield* host.lease(sessionID))

      available.value = false
      expect(Option.isNone(yield* host.lease(sessionID))).toBe(true)
      yield* lease.revoked
      expect(
        yield* lease.request({ type: "snapshot", generation: state.generation }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.RequestError", code: "not_attached" },
      })
    }),
  )

  denied.effect("rejects attachment snapshots for unknown Sessions", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      const running = yield* Effect.forkChild(connection.run(transport.peer))
      yield* attach(transport, Browser.LeaseID.make("brl_unknown"))
      expect(yield* Fiber.join(running).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.ProtocolError" },
      })
      expect(Option.isNone(yield* host.lease(sessionID))).toBe(true)
    }),
  )

  it.effect("clears attachments and pending requests when the connection fails", () =>
    Effect.gen(function* () {
      const host = yield* BrowserHost.Service
      const connection = yield* host.claim
      const transport = yield* makePeer
      yield* Effect.forkChild(connection.run(transport.peer))
      yield* attach(transport, Browser.LeaseID.make("brl_disconnect"))
      yield* awaitSynced(transport)
      const lease = yield* awaitLease(host)
      const request = yield* Effect.forkChild(lease.request({ type: "snapshot", generation: state.generation }))
      yield* Queue.take(transport.outbound)

      Queue.failCauseUnsafe(
        transport.inbound,
        Cause.fail(new BrowserHost.ConnectionError({ kind: "closed", message: "disconnected" })),
      )

      expect(yield* request.pipe(Fiber.join, Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BrowserHost.RequestError", code: "not_attached" },
      })
      expect(Option.isNone(yield* host.lease(sessionID))).toBe(true)
    }),
  )
})
