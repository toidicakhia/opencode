export * as BrowserControlConnection from "./browser-control-connection"

import { BrowserHost } from "@opencode-ai/core/browser-host"
import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Cause, Effect, Queue, Ref, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { BrowserClose } from "./browser-close"

const InboundCapacity = 64
const OutboundCapacity = 64
const InboundBytes = BrowserControlProtocol.MaxMessageBytes * 2
const encoder = new TextEncoder()

type Inbound = {
  readonly message: BrowserControl.FromDesktop
  readonly bytes: number
}

export const make = Effect.fn("BrowserControlConnection.make")(function* (
  socket: Socket.Socket,
  opened: Effect.Effect<void> = Effect.void,
) {
  const inbound = yield* Queue.dropping<Inbound, BrowserHost.ConnectionError>(InboundCapacity)
  const outbound = yield* Queue.dropping<string | Socket.CloseEvent>(OutboundCapacity)
  const inboundBytes = yield* Ref.make(0)
  const write = yield* socket.writer

  const fail = (kind: BrowserHost.ConnectionError["kind"], message: string, cause?: unknown) =>
    Effect.sync(() => {
      Queue.failCauseUnsafe(inbound, Cause.fail(new BrowserHost.ConnectionError({ kind, message, cause })))
    })

  yield* socket
    .runRaw(
      (message) =>
        Effect.gen(function* () {
          const bytes = typeof message === "string" ? encoder.encode(message).byteLength : message.byteLength
          const admitted = yield* Ref.modify(inboundBytes, (current) =>
            current + bytes <= InboundBytes ? [true, current + bytes] : [false, current],
          )
          if (!admitted) return yield* fail("overloaded", "Browser control receive byte budget is full.")
          return yield* BrowserControlProtocol.decodeFromDesktop(message).pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                Ref.update(inboundBytes, (current) => Math.max(0, current - bytes)).pipe(
                  Effect.andThen(
                    fail(
                      cause.kind === "too_large" ? "message_too_large" : "invalid_message",
                      "Browser control message is invalid.",
                      cause,
                    ),
                  ),
                ),
              onSuccess: (value) => {
                if (Queue.offerUnsafe(inbound, { message: value, bytes })) return Effect.void
                return Ref.update(inboundBytes, (current) => Math.max(0, current - bytes)).pipe(
                  Effect.andThen(fail("overloaded", "Browser control receive queue is full.")),
                )
              },
            }),
          )
        }),
      {
        onOpen: opened.pipe(
          Effect.andThen(write(BrowserControlProtocol.encodeFromServer({ type: "browser.control.ready" }))),
          Effect.orDie,
        ),
      },
    )
    .pipe(
      Effect.matchCauseEffect({
        onSuccess: () => fail("closed", "Browser control connection closed."),
        onFailure: (cause) => fail("transport", "Browser control connection failed.", Cause.squash(cause)),
      }),
      Effect.forkScoped,
    )

  yield* Effect.gen(function* () {
    while (true) yield* write(yield* Queue.take(outbound))
  }).pipe(
    Effect.catch((cause) => fail("transport", "Browser control writer failed.", cause)),
    Effect.forkScoped,
  )

  yield* Effect.addFinalizer(() =>
    Effect.all([Queue.shutdown(inbound), Queue.shutdown(outbound)], { concurrency: "unbounded", discard: true }),
  )

  return {
    messages: Stream.fromQueue(inbound).pipe(
      Stream.mapEffect((item) =>
        Ref.update(inboundBytes, (current) => Math.max(0, current - item.bytes)).pipe(Effect.as(item.message)),
      ),
    ),
    send: (message) =>
      Effect.try({
        try: () => BrowserControlProtocol.encodeFromServer(message),
        catch: (cause) =>
          new BrowserHost.ConnectionError({
            kind: "transport",
            message: "Failed to encode browser control message.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((frame) => Queue.offer(outbound, frame)),
        Effect.flatMap((offered) =>
          offered
            ? Effect.void
            : new BrowserHost.ConnectionError({ kind: "overloaded", message: "Browser control send queue is full." }),
        ),
      ),
    close: (close, message) =>
      write(new Socket.CloseEvent(BrowserClose.control(close), message.slice(0, 123))).pipe(
        Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
        Effect.catch(() => Effect.void),
      ),
  } satisfies BrowserHost.Peer
})
