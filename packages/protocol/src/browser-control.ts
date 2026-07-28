export * as BrowserControlProtocol from "./browser-control.js"

import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Effect, Schema } from "effect"

export const MaxMessageBytes = 8 * 1_024 * 1_024

export class MessageError extends Schema.TaggedErrorClass<MessageError>()("BrowserControlProtocol.MessageError", {
  kind: Schema.Literals(["invalid", "too_large"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()
const encodeDesktop = Schema.encodeSync(Schema.fromJsonString(BrowserControl.FromDesktop))
const encodeServer = Schema.encodeSync(Schema.fromJsonString(BrowserControl.FromServer))
const decodeDesktop = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserControl.FromDesktop), {
  errors: "all",
  onExcessProperty: "error",
})
const decodeServer = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserControl.FromServer), {
  errors: "all",
  onExcessProperty: "error",
})

export function encodeFromDesktop(input: BrowserControl.FromDesktop) {
  return encode(input, encodeDesktop)
}

export function encodeFromServer(input: BrowserControl.FromServer) {
  return encode(input, encodeServer)
}

function encode<Message>(input: Message, encodeMessage: (input: Message) => string) {
  const output = encodeMessage(input)
  if (encoder.encode(output).byteLength > MaxMessageBytes) {
    throw new RangeError(`Browser control message must not exceed ${MaxMessageBytes} bytes.`)
  }
  return output
}

export function decodeFromDesktop(input: string | Uint8Array) {
  return decode(input, decodeDesktop)
}

export function decodeFromServer(input: string | Uint8Array) {
  return decode(input, decodeServer)
}

function decode<Message>(
  input: string | Uint8Array,
  decodeMessage: (input: unknown) => Effect.Effect<Message, unknown>,
): Effect.Effect<Message, MessageError> {
  if (typeof input === "string" && encoder.encode(input).byteLength > MaxMessageBytes) {
    return Effect.fail(new MessageError({ kind: "too_large", message: "Browser control message is too large." }))
  }
  if (typeof input !== "string" && input.byteLength > MaxMessageBytes) {
    return Effect.fail(new MessageError({ kind: "too_large", message: "Browser control message is too large." }))
  }
  const text =
    typeof input === "string"
      ? Effect.succeed(input)
      : Effect.try({
          try: () => decoder.decode(input),
          catch: (cause) =>
            new MessageError({ kind: "invalid", message: "Browser control message is not valid UTF-8.", cause }),
        })
  return text.pipe(
    Effect.flatMap(decodeMessage),
    Effect.mapError((cause) =>
      cause instanceof MessageError
        ? cause
        : new MessageError({ kind: "invalid", message: "Browser control message is invalid.", cause }),
    ),
  )
}
