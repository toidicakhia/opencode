export * as BrowserTunnelProtocol from "./browser-tunnel.js"

import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Effect, Schema } from "effect"

export const FrameType = {
  Data: 0,
  Control: 1,
} as const

export const MaxDataBytes = 64 * 1_024
export const MaxControlBytes = 16 * 1_024
export const InitialWindowBytes = 256 * 1_024
export const InitialFrameWindow = 16

export class FrameError extends Schema.TaggedErrorClass<FrameError>()("BrowserTunnelProtocol.FrameError", {
  kind: Schema.Literals(["invalid", "too_large"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type DataFrame = {
  readonly type: "data"
  readonly data: Uint8Array
}

export type ControlFrame<Message> = {
  readonly type: "control"
  readonly message: Message
}

export type FromDesktop = DataFrame | ControlFrame<BrowserTunnel.FromDesktop>
export type FromServer = DataFrame | ControlFrame<BrowserTunnel.FromServer>

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const encodeDesktop = Schema.encodeSync(Schema.fromJsonString(BrowserTunnel.FromDesktop))
const encodeServer = Schema.encodeSync(Schema.fromJsonString(BrowserTunnel.FromServer))
const decodeDesktop = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserTunnel.FromDesktop), {
  errors: "all",
  onExcessProperty: "error",
})
const decodeServer = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserTunnel.FromServer), {
  errors: "all",
  onExcessProperty: "error",
})

export function data(input: Uint8Array) {
  if (input.byteLength === 0 || input.byteLength > MaxDataBytes) {
    throw new RangeError(`Browser tunnel data must contain between 1 and ${MaxDataBytes} bytes.`)
  }
  const frame = new Uint8Array(input.byteLength + 1)
  frame[0] = FrameType.Data
  frame.set(input, 1)
  return frame
}

export function encodeFromDesktop(input: BrowserTunnel.FromDesktop) {
  return control(encodeDesktop(input))
}

export function encodeFromServer(input: BrowserTunnel.FromServer) {
  return control(encodeServer(input))
}

function control(input: string) {
  const payload = encoder.encode(input)
  if (payload.byteLength > MaxControlBytes) {
    throw new RangeError(`Browser tunnel control data must not exceed ${MaxControlBytes} bytes.`)
  }
  const frame = new Uint8Array(payload.byteLength + 1)
  frame[0] = FrameType.Control
  frame.set(payload, 1)
  return frame
}

export function decodeFromDesktop(input: string | Uint8Array): Effect.Effect<FromDesktop, FrameError> {
  return decode(input, decodeDesktop)
}

export function decodeFromServer(input: string | Uint8Array): Effect.Effect<FromServer, FrameError> {
  return decode(input, decodeServer)
}

function decode<Message>(
  input: string | Uint8Array,
  decodeMessage: (input: unknown) => Effect.Effect<Message, unknown>,
): Effect.Effect<DataFrame | ControlFrame<Message>, FrameError> {
  if (typeof input === "string" || input.byteLength === 0) {
    return Effect.fail(new FrameError({ kind: "invalid", message: "Browser tunnel frames must use binary framing." }))
  }
  if (input[0] === FrameType.Data) {
    if (input.byteLength === 1 || input.byteLength > MaxDataBytes + 1) {
      return Effect.fail(new FrameError({ kind: "too_large", message: "Browser tunnel data frame size is invalid." }))
    }
    return Effect.succeed({ type: "data", data: input.subarray(1) })
  }
  if (input[0] !== FrameType.Control) {
    return Effect.fail(new FrameError({ kind: "invalid", message: "Browser tunnel frame type is invalid." }))
  }
  if (input.byteLength > MaxControlBytes + 1) {
    return Effect.fail(new FrameError({ kind: "too_large", message: "Browser tunnel control frame is too large." }))
  }
  return Effect.try({
    try: () => decoder.decode(input.subarray(1)),
    catch: (cause) =>
      new FrameError({ kind: "invalid", message: "Browser tunnel control frame is not valid UTF-8.", cause }),
  }).pipe(
    Effect.flatMap(decodeMessage),
    Effect.map((message) => ({ type: "control" as const, message })),
    Effect.mapError((cause) =>
      cause instanceof FrameError
        ? cause
        : new FrameError({ kind: "invalid", message: "Browser tunnel control frame is invalid.", cause }),
    ),
  )
}
