export * as BrowserTunnel from "./browser-tunnel.js"

import { Schema } from "effect"
import { Browser } from "./browser.js"
import { Session } from "./session.js"

export const Host = Schema.NonEmptyString.check(Schema.isMaxLength(253), Schema.isPattern(/^[^\s/?#]+$/))
  .pipe(Schema.brand("BrowserTunnel.Host"))
  .annotate({ identifier: "BrowserTunnel.Host" })
export type Host = typeof Host.Type

export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
  .pipe(Schema.brand("BrowserTunnel.Port"))
  .annotate({ identifier: "BrowserTunnel.Port" })
export type Port = typeof Port.Type

export const WindowBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 }))
  .pipe(Schema.brand("BrowserTunnel.WindowBytes"))
  .annotate({ identifier: "BrowserTunnel.WindowBytes" })
export type WindowBytes = typeof WindowBytes.Type

export const WindowSize = Schema.Int.check(Schema.isBetween({ minimum: 65_536, maximum: 1_048_576 }))
  .pipe(Schema.brand("BrowserTunnel.WindowSize"))
  .annotate({ identifier: "BrowserTunnel.WindowSize" })
export type WindowSize = typeof WindowSize.Type

export const FrameWindow = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))
  .pipe(Schema.brand("BrowserTunnel.FrameWindow"))
  .annotate({ identifier: "BrowserTunnel.FrameWindow" })
export type FrameWindow = typeof FrameWindow.Type

export interface Target extends Schema.Schema.Type<typeof Target> {}
export const Target = Schema.Struct({
  host: Host,
  port: Port,
}).annotate({ identifier: "BrowserTunnel.Target" })

export interface Open extends Schema.Schema.Type<typeof Open> {}
export const Open = Schema.Struct({
  type: Schema.Literal("browser.tunnel.open"),
  sessionID: Session.ID,
  leaseID: Browser.LeaseID,
  target: Target,
  receiveWindow: WindowSize,
  receiveFrames: FrameWindow,
}).annotate({ identifier: "BrowserTunnel.Open" })

export interface Ready extends Schema.Schema.Type<typeof Ready> {}
export const Ready = Schema.Struct({
  type: Schema.Literal("browser.tunnel.ready"),
}).annotate({ identifier: "BrowserTunnel.Ready" })

export interface Opened extends Schema.Schema.Type<typeof Opened> {}
export const Opened = Schema.Struct({
  type: Schema.Literal("browser.tunnel.opened"),
  receiveWindow: WindowSize,
  receiveFrames: FrameWindow,
}).annotate({ identifier: "BrowserTunnel.Opened" })

export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  type: Schema.Literal("browser.tunnel.window"),
  bytes: WindowBytes,
  frames: FrameWindow,
}).annotate({ identifier: "BrowserTunnel.Window" })

export const OpenErrorCode = Schema.Literals([
  "invalid_open",
  "not_attached",
  "stale_lease",
  "connect_failed",
  "connect_timeout",
]).annotate({ identifier: "BrowserTunnel.OpenErrorCode" })
export type OpenErrorCode = typeof OpenErrorCode.Type

export interface Rejected extends Schema.Schema.Type<typeof Rejected> {}
export const Rejected = Schema.Struct({
  type: Schema.Literal("browser.tunnel.rejected"),
  code: OpenErrorCode,
  message: Schema.String.check(Schema.isMaxLength(1_024)),
}).annotate({ identifier: "BrowserTunnel.Rejected" })

export interface End extends Schema.Schema.Type<typeof End> {}
export const End = Schema.Struct({
  type: Schema.Literal("browser.tunnel.end"),
}).annotate({ identifier: "BrowserTunnel.End" })

export const ResetCode = Schema.Literals([
  "cancelled",
  "lease_revoked",
  "message_too_large",
  "target_error",
  "protocol_error",
]).annotate({ identifier: "BrowserTunnel.ResetCode" })
export type ResetCode = typeof ResetCode.Type

export interface Reset extends Schema.Schema.Type<typeof Reset> {}
export const Reset = Schema.Struct({
  type: Schema.Literal("browser.tunnel.reset"),
  code: ResetCode,
}).annotate({ identifier: "BrowserTunnel.Reset" })

export const FromDesktop = Schema.Union([Open, Window, End, Reset])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "BrowserTunnel.FromDesktop" })
export type FromDesktop = typeof FromDesktop.Type

export const FromServer = Schema.Union([Ready, Opened, Rejected, Window, End, Reset])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "BrowserTunnel.FromServer" })
export type FromServer = typeof FromServer.Type
