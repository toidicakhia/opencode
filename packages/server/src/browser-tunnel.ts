export * as BrowserTunnelServer from "./browser-tunnel"

import { BrowserHost } from "@opencode-ai/core/browser-host"
import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect"
import { Socket } from "effect/unstable/socket"
import { BrowserClose } from "./browser-close"

const ActiveLimit = 64
const InboundCapacity = BrowserTunnelProtocol.InitialFrameWindow * 2 + 4

export class CapacityError extends Schema.TaggedErrorClass<CapacityError>()("BrowserTunnel.CapacityError", {
  limit: Schema.Int,
  message: Schema.String,
}) {}

class TransportError extends Schema.TaggedErrorClass<TransportError>()("BrowserTunnel.TransportError", {
  kind: Schema.Literals(["socket_closed", "protocol", "too_large", "target", "lease_revoked"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class ConnectError extends Schema.TaggedErrorClass<ConnectError>()("BrowserTunnel.ConnectError", {
  kind: Schema.Literals(["failed", "timeout"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type Dial = (host: string, port: number) => Effect.Effect<import("node:net").Socket, ConnectError, Scope.Scope>

type Inbound = {
  readonly message: string | Uint8Array
}

type TargetOutput = { readonly type: "data"; readonly data: Uint8Array } | { readonly type: "end" }

type ServerState = {
  readonly active: number
  readonly shutdown: boolean
}

export interface Connection {
  readonly run: (socket: Socket.Socket, opened?: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
}

export interface Interface {
  readonly acquire: Effect.Effect<Connection, CapacityError, Scope.Scope>
  readonly shutdown: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/BrowserTunnel") {}

export function make(dial: Dial = connect) {
  return Effect.gen(function* () {
    const browser = yield* BrowserHost.Service
    const state = yield* SynchronizedRef.make<ServerState>({ active: 0, shutdown: false })
    const connections = new Set<Effect.Effect<void>>()

    const shutdown = Effect.fn("BrowserTunnel.shutdown")(function* () {
      const first = yield* SynchronizedRef.modify(state, (current) => [
        !current.shutdown,
        { ...current, shutdown: true },
      ])
      if (!first) return
      yield* Effect.all(Array.from(connections), { concurrency: "unbounded", discard: true })
    })

    yield* Effect.addFinalizer(() => shutdown())

    const acquire: Interface["acquire"] = Effect.acquireRelease(
      SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function* (current) {
          if (current.shutdown) {
            return yield* new CapacityError({
              limit: ActiveLimit,
              message: "The browser tunnel server is shutting down.",
            })
          }
          if (current.active >= ActiveLimit) {
            return yield* new CapacityError({
              limit: ActiveLimit,
              message: "The browser tunnel limit has been reached.",
            })
          }
          return [undefined, { ...current, active: current.active + 1 }] as const
        }),
      ),
      () => SynchronizedRef.update(state, (current) => ({ ...current, active: Math.max(0, current.active - 1) })),
    ).pipe(
      Effect.andThen(Ref.make(false)),
      Effect.map((started) => ({
        run: (socket: Socket.Socket, opened = Effect.void) =>
          Effect.gen(function* () {
            const write = yield* socket.writer
            if (yield* Ref.getAndSet(started, true)) {
              yield* close(write, BrowserClose.Code.ProtocolError, "Browser tunnel connection can only run once")
              return
            }
            const restart = write(new Socket.CloseEvent(BrowserClose.Code.Restart, "Server restarting")).pipe(
              Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
              Effect.catch(() => Effect.void),
            )
            connections.add(restart)
            yield* Effect.gen(function* () {
              if ((yield* SynchronizedRef.get(state)).shutdown) {
                yield* socket
                  .runRaw(() => Effect.void, { onOpen: opened.pipe(Effect.andThen(restart)) })
                  .pipe(
                    Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
                    Effect.catch(() => Effect.void),
                  )
                return
              }
              yield* serve(browser, socket, write, dial, opened).pipe(Effect.catch(() => Effect.void))
            }).pipe(Effect.ensuring(Effect.sync(() => connections.delete(restart))))
          }),
      })),
    )

    return Service.of({ acquire, shutdown: shutdown() })
  })
}

export const layer = Layer.effect(Service, make())

const serve = Effect.fn("BrowserTunnel.serve")(function* (
  browser: BrowserHost.Interface,
  socket: Socket.Socket,
  writeSocket: (data: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>,
  dial: Dial,
  opened: Effect.Effect<void>,
) {
  const inbound = yield* Queue.dropping<Inbound, TransportError>(InboundCapacity)

  const reader = yield* socket
    .runRaw(
      (message) => {
        const invalid = rawFrameError(message)
        if (invalid) return fail(inbound, invalid)
        return Queue.offerUnsafe(inbound, { message })
          ? Effect.void
          : fail(inbound, new TransportError({ kind: "protocol", message: "Browser tunnel receive queue is full." }))
      },
      {
        onOpen: opened.pipe(
          Effect.andThen(writeSocket(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.ready" }))),
          Effect.orDie,
        ),
      },
    )
    .pipe(
      Effect.matchCauseEffect({
        onSuccess: () =>
          fail(inbound, new TransportError({ kind: "socket_closed", message: "Browser tunnel closed." })),
        onFailure: (cause) =>
          fail(
            inbound,
            new TransportError({
              kind: "socket_closed",
              message: "Browser tunnel failed.",
              cause: Cause.squash(cause),
            }),
          ),
      }),
      Effect.forkScoped,
    )

  const firstResult = yield* Effect.result(
    Queue.take(inbound).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new TransportError({ kind: "protocol", message: "Browser tunnel open timed out." })),
      }),
    ),
  )
  if (Result.isFailure(firstResult)) {
    yield* reject(
      writeSocket,
      "invalid_open",
      firstResult.failure.message,
      firstResult.failure.kind === "too_large" ? BrowserClose.Code.MessageTooLarge : BrowserClose.Code.ProtocolError,
    )
    return
  }
  const first = firstResult.success
  const firstFrame = yield* BrowserTunnelProtocol.decodeFromDesktop(first.message).pipe(Effect.option)
  if (
    Option.isNone(firstFrame) ||
    firstFrame.value.type !== "control" ||
    firstFrame.value.message.type !== "browser.tunnel.open"
  ) {
    yield* reject(
      writeSocket,
      "invalid_open",
      "Browser tunnel open message is invalid.",
      BrowserClose.Code.InvalidPayload,
    )
    return
  }
  const open = firstFrame.value.message

  const lease = yield* browser.lease(open.sessionID)
  if (Option.isNone(lease)) {
    yield* reject(
      writeSocket,
      "not_attached",
      "No desktop browser is attached to this Session.",
      BrowserClose.Code.Normal,
    )
    return
  }
  if (lease.value.id !== open.leaseID) {
    yield* reject(writeSocket, "stale_lease", "The desktop browser lease is stale.", BrowserClose.Code.Normal)
    return
  }

  const target = yield* Effect.result(
    Effect.raceFirst(
      dial(open.target.host, open.target.port),
      Effect.raceFirst(
        Fiber.join(reader).pipe(
          Effect.andThen(new TransportError({ kind: "socket_closed", message: "Browser tunnel closed." })),
        ),
        lease.value.revoked.pipe(
          Effect.andThen(new TransportError({ kind: "lease_revoked", message: "Browser attachment was revoked." })),
        ),
      ),
    ),
  )
  if (Result.isFailure(target)) {
    if (target.failure instanceof TransportError) {
      if (target.failure.kind === "lease_revoked") {
        yield* reject(writeSocket, "stale_lease", target.failure.message, BrowserClose.Code.Normal)
      }
      return
    }
    yield* reject(
      writeSocket,
      target.failure.kind === "timeout" ? "connect_timeout" : "connect_failed",
      target.failure.message,
      BrowserClose.Code.Normal,
    )
    return
  }
  const tcp = target.success

  const sending = yield* Semaphore.make(1)
  const outboundBytes = yield* Semaphore.make(open.receiveWindow)
  const outboundFrames = yield* Semaphore.make(open.receiveFrames)
  const outboundOutstanding = yield* Ref.make({ bytes: 0, frames: 0 })
  const inboundRemaining = yield* Ref.make({
    bytes: BrowserTunnelProtocol.InitialWindowBytes,
    frames: BrowserTunnelProtocol.InitialFrameWindow,
  })
  const targetEnded = yield* Deferred.make<void>()
  const send = (message: BrowserTunnel.FromServer) =>
    sending.withPermits(1)(
      writeSocket(BrowserTunnelProtocol.encodeFromServer(message)).pipe(
        Effect.mapError(
          (cause) =>
            new TransportError({ kind: "socket_closed", message: "Failed to send tunnel control frame.", cause }),
        ),
      ),
    )
  const sendData = (data: Uint8Array) =>
    outboundFrames.take(1).pipe(
      Effect.andThen(outboundBytes.take(data.byteLength)),
      Effect.andThen(
        Ref.update(outboundOutstanding, (outstanding) => ({
          bytes: outstanding.bytes + data.byteLength,
          frames: outstanding.frames + 1,
        })),
      ),
      Effect.andThen(
        sending.withPermits(1)(
          writeSocket(BrowserTunnelProtocol.data(data)).pipe(
            Effect.mapError(
              (cause) => new TransportError({ kind: "socket_closed", message: "Failed to send tunnel data.", cause }),
            ),
          ),
        ),
      ),
    )

  yield* send({
    type: "browser.tunnel.opened",
    receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
    receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
  })

  const output = yield* Queue.bounded<TargetOutput, TransportError>(2)
  const onData = (data: Uint8Array) => {
    tcp.pause()
    if (Queue.offerUnsafe(output, { type: "data", data })) return
    Queue.failCauseUnsafe(
      output,
      Cause.fail(new TransportError({ kind: "target", message: "Browser tunnel target output queue is full." })),
    )
  }
  const onEnd = () => {
    if (Queue.offerUnsafe(output, { type: "end" })) return
    Queue.failCauseUnsafe(
      output,
      Cause.fail(new TransportError({ kind: "target", message: "Browser tunnel target end queue is full." })),
    )
  }
  const onError = (cause: Error) =>
    Queue.failCauseUnsafe(
      output,
      Cause.fail(new TransportError({ kind: "target", message: "Browser tunnel target failed.", cause })),
    )
  const onClose = (hadError: boolean) => {
    if (!hadError) return
    Queue.failCauseUnsafe(
      output,
      Cause.fail(new TransportError({ kind: "target", message: "Browser tunnel target closed with an error." })),
    )
  }
  tcp.on("data", onData)
  tcp.once("end", onEnd)
  tcp.once("error", onError)
  tcp.once("close", onClose)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      tcp.off("data", onData)
      tcp.off("end", onEnd)
      tcp.off("error", onError)
      tcp.off("close", onClose)
    }).pipe(Effect.andThen(Queue.shutdown(output))),
  )

  const desktop = { ended: false, done: false }
  const fromDesktop = Effect.whileLoop({
    while: () => !desktop.done,
    body: () =>
      Effect.gen(function* () {
        const frame = desktop.ended
          ? yield* Effect.raceFirst(
              Queue.take(inbound).pipe(Effect.map(Option.some)),
              Deferred.await(targetEnded).pipe(Effect.as(Option.none<Inbound>())),
            )
          : Option.some(yield* Queue.take(inbound))
        if (Option.isNone(frame)) {
          desktop.done = true
          return
        }
        const decoded = yield* BrowserTunnelProtocol.decodeFromDesktop(frame.value.message).pipe(
          Effect.mapError(
            (cause) =>
              new TransportError({
                kind: cause.kind === "too_large" ? "too_large" : "protocol",
                message: "Browser tunnel frame is invalid.",
                cause,
              }),
          ),
        )
        if (decoded.type === "data") {
          if (desktop.ended) {
            yield* new TransportError({ kind: "protocol", message: "Browser tunnel received data after end." })
            return
          }
          const accepted = yield* Ref.modify(inboundRemaining, (window) =>
            decoded.data.byteLength <= window.bytes && window.frames > 0
              ? [true, { bytes: window.bytes - decoded.data.byteLength, frames: window.frames - 1 }]
              : ([false, window] as const),
          )
          if (!accepted) {
            yield* new TransportError({ kind: "protocol", message: "Browser tunnel receive window exceeded." })
            return
          }
          yield* write(tcp, decoded.data)
          yield* Ref.update(inboundRemaining, (window) => ({
            bytes: window.bytes + decoded.data.byteLength,
            frames: window.frames + 1,
          }))
          yield* send({
            type: "browser.tunnel.window",
            bytes: BrowserTunnel.WindowBytes.make(decoded.data.byteLength),
            frames: BrowserTunnel.FrameWindow.make(1),
          })
          return
        }
        const control = decoded.message
        if (control.type === "browser.tunnel.open") {
          yield* new TransportError({ kind: "protocol", message: "Browser tunnel cannot be opened twice." })
          return
        }
        if (control.type === "browser.tunnel.window") {
          const released = yield* Ref.modify(outboundOutstanding, (outstanding) =>
            control.bytes <= outstanding.bytes && control.frames <= outstanding.frames
              ? [
                  true,
                  {
                    bytes: outstanding.bytes - control.bytes,
                    frames: outstanding.frames - control.frames,
                  },
                ]
              : ([false, outstanding] as const),
          )
          if (!released) {
            yield* new TransportError({ kind: "protocol", message: "Browser tunnel window exceeds sent data." })
            return
          }
          yield* outboundBytes.release(control.bytes)
          yield* outboundFrames.release(control.frames)
          return
        }
        if (control.type === "browser.tunnel.reset") {
          yield* new TransportError({
            kind: "socket_closed",
            message: `Desktop reset browser tunnel: ${control.code}`,
          })
          return
        }
        if (desktop.ended) {
          yield* new TransportError({ kind: "protocol", message: "Browser tunnel received duplicate end." })
          return
        }
        yield* end(tcp)
        desktop.ended = true
      }),
    step: () => undefined,
  })

  const targetState = { done: false }
  const fromTarget = Effect.whileLoop({
    while: () => !targetState.done,
    body: () =>
      Effect.gen(function* () {
        const item = yield* Queue.take(output)
        if (item.type === "end") {
          yield* send({ type: "browser.tunnel.end" })
          yield* Deferred.succeed(targetEnded, undefined)
          targetState.done = true
          return
        }
        yield* sendTargetData(item.data, sendData).pipe(Effect.ensuring(Effect.sync(() => tcp.resume())))
      }),
    step: () => undefined,
  })

  const transfer = Effect.all([fromDesktop, fromTarget], { concurrency: "unbounded", discard: true })
  yield* Effect.raceFirst(
    transfer,
    Effect.raceFirst(
      Fiber.join(reader).pipe(
        Effect.andThen(new TransportError({ kind: "socket_closed", message: "Browser tunnel closed." })),
      ),
      lease.value.revoked.pipe(
        Effect.andThen(new TransportError({ kind: "lease_revoked", message: "Browser attachment was revoked." })),
      ),
    ),
  ).pipe(
    Effect.matchEffect({
      onSuccess: () => close(writeSocket, BrowserClose.Code.Normal, "Browser tunnel complete"),
      onFailure: (error) =>
        send({
          type: "browser.tunnel.reset",
          code:
            error.kind === "lease_revoked"
              ? "lease_revoked"
              : error.kind === "too_large"
                ? "message_too_large"
                : error.kind === "protocol"
                  ? "protocol_error"
                  : error.kind === "target"
                    ? "target_error"
                    : "cancelled",
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(
            close(
              writeSocket,
              error.kind === "too_large"
                ? BrowserClose.Code.MessageTooLarge
                : error.kind === "protocol"
                  ? BrowserClose.Code.ProtocolError
                  : error.kind === "target"
                    ? BrowserClose.Code.UpstreamError
                    : BrowserClose.Code.GoingAway,
              error.message,
            ),
          ),
        ),
    }),
    Effect.ensuring(Effect.sync(() => tcp.destroy())),
  )
})

function sendTargetData(
  data: Uint8Array,
  send: (data: Uint8Array) => Effect.Effect<void, TransportError>,
): Effect.Effect<void, TransportError> {
  return Stream.fromIterable(
    Array.from({ length: Math.ceil(data.byteLength / BrowserTunnelProtocol.MaxDataBytes) }, (_, index) =>
      data.subarray(index * BrowserTunnelProtocol.MaxDataBytes, (index + 1) * BrowserTunnelProtocol.MaxDataBytes),
    ),
  ).pipe(Stream.runForEach(send))
}

function rawFrameError(message: string | Uint8Array) {
  if (typeof message === "string") {
    return new TransportError({ kind: "protocol", message: "Browser tunnel frames must use binary framing." })
  }
  const limit =
    message[0] === BrowserTunnelProtocol.FrameType.Control
      ? BrowserTunnelProtocol.MaxControlBytes + 1
      : BrowserTunnelProtocol.MaxDataBytes + 1
  if (message.byteLength <= limit) return undefined
  return new TransportError({ kind: "too_large", message: "Browser tunnel frame is too large." })
}

function connect(host: string, port: number) {
  return Effect.gen(function* () {
    const net = yield* Effect.promise(() => import("node:net"))
    return yield* Effect.acquireRelease(
      Effect.callback<import("node:net").Socket, ConnectError>((resume) => {
        const socket = new net.Socket({
          allowHalfOpen: true,
        })
        const onError = (cause: Error) => {
          resume(
            Effect.fail(
              new ConnectError({ kind: "failed", message: "Failed to connect browser tunnel target.", cause }),
            ),
          )
        }
        const onConnect = () => {
          socket.off("error", onError)
          socket.setNoDelay(true)
          resume(Effect.succeed(socket))
        }
        socket.once("error", onError)
        socket.connect(port, host, onConnect)
        return Effect.sync(() => socket.destroy())
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(new ConnectError({ kind: "timeout", message: "Browser tunnel target connection timed out." })),
        }),
      ),
      (socket) => Effect.sync(() => socket.destroy()),
    )
  })
}

function write(socket: import("node:net").Socket, data: Uint8Array) {
  return Effect.callback<void, TransportError>((resume) => {
    socket.write(data, (cause) => {
      if (cause) {
        resume(
          Effect.fail(new TransportError({ kind: "target", message: "Failed to write browser tunnel data.", cause })),
        )
        return
      }
      resume(Effect.void)
    })
  })
}

function end(socket: import("node:net").Socket) {
  return Effect.try({
    try: () => socket.end(),
    catch: (cause) => new TransportError({ kind: "target", message: "Failed to end browser tunnel target.", cause }),
  })
}

function reject(
  write: (data: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>,
  code: BrowserTunnel.OpenErrorCode,
  message: string,
  closeCode: number,
) {
  return Effect.try({
    try: () => BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.rejected", code, message }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((frame) => (frame ? write(frame) : Effect.void)),
    Effect.catch(() => Effect.void),
    Effect.andThen(close(write, closeCode, message)),
  )
}

function close(
  write: (data: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>,
  code: number,
  reason: string,
) {
  return write(new Socket.CloseEvent(code, reason.slice(0, 123))).pipe(
    Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
    Effect.catch(() => Effect.void),
  )
}

function fail(queue: Queue.Queue<Inbound, TransportError>, error: TransportError) {
  return Effect.sync(() => {
    Queue.failCauseUnsafe(queue, Cause.fail(error))
  })
}
