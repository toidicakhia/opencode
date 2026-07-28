export * as BrowserClose from "./browser-close"

import type { BrowserHost } from "@opencode-ai/core/browser-host"

export const Code = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  InvalidPayload: 1007,
  MessageTooLarge: 1009,
  InternalError: 1011,
  Restart: 1012,
  TryAgainLater: 1013,
  UpstreamError: 1014,
} as const

export function control(reason: BrowserHost.CloseReason) {
  if (reason === "disconnected") return Code.GoingAway
  if (reason === "protocol_error") return Code.ProtocolError
  if (reason === "message_too_large") return Code.MessageTooLarge
  if (reason === "overloaded") return Code.TryAgainLater
  if (reason === "restart") return Code.Restart
  return Code.InternalError
}
