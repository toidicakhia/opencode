import { describe, expect, test } from "bun:test"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { Effect } from "effect"
import { BrowserTunnelProtocol } from "../src/browser-tunnel.js"

describe("BrowserTunnelProtocol", () => {
  test("round trips binary data without copying protocol semantics into it", async () => {
    const payload = new Uint8Array([0, 1, 2, 255])
    const decoded = await Effect.runPromise(BrowserTunnelProtocol.decodeFromServer(BrowserTunnelProtocol.data(payload)))
    expect(decoded).toEqual({ type: "data", data: payload })
    expect(Array.from(BrowserTunnelProtocol.data(new Uint8Array([1, 2])))).toEqual([0, 1, 2])
  })

  test("round trips typed control messages", async () => {
    const message: BrowserTunnel.FromDesktop = {
      type: "browser.tunnel.open",
      sessionID: Session.ID.make("ses_browser_tunnel"),
      leaseID: Browser.LeaseID.make("brl_browsertunnel"),
      target: { host: BrowserTunnel.Host.make("localhost"), port: BrowserTunnel.Port.make(5173) },
      receiveWindow: BrowserTunnel.WindowSize.make(BrowserTunnelProtocol.InitialWindowBytes),
      receiveFrames: BrowserTunnel.FrameWindow.make(BrowserTunnelProtocol.InitialFrameWindow),
    }
    const decoded = await Effect.runPromise(
      BrowserTunnelProtocol.decodeFromDesktop(BrowserTunnelProtocol.encodeFromDesktop(message)),
    )
    expect(decoded).toEqual({ type: "control", message })
  })

  test("rejects unframed, unknown, and malformed control payloads", async () => {
    for (const input of [
      "unframed",
      new Uint8Array([9, 0]),
      new Uint8Array([BrowserTunnelProtocol.FrameType.Control, 255]),
    ]) {
      expect(await Effect.runPromise(BrowserTunnelProtocol.decodeFromDesktop(input).pipe(Effect.result))).toMatchObject(
        {
          _tag: "Failure",
          failure: { _tag: "BrowserTunnelProtocol.FrameError" },
        },
      )
    }
  })

  test("pins control framing and public size limits", async () => {
    expect(Array.from(BrowserTunnelProtocol.encodeFromDesktop({ type: "browser.tunnel.end" }))).toEqual([
      BrowserTunnelProtocol.FrameType.Control,
      ...new TextEncoder().encode('{"type":"browser.tunnel.end"}'),
    ])
    expect(() => BrowserTunnelProtocol.data(new Uint8Array())).toThrow()
    expect(() => BrowserTunnelProtocol.data(new Uint8Array(BrowserTunnelProtocol.MaxDataBytes + 1))).toThrow()

    const extra = new TextEncoder().encode('{"type":"browser.tunnel.end","extra":true}')
    const frame = new Uint8Array(extra.byteLength + 1)
    frame[0] = BrowserTunnelProtocol.FrameType.Control
    frame.set(extra, 1)
    expect(await Effect.runPromise(BrowserTunnelProtocol.decodeFromDesktop(frame).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BrowserTunnelProtocol.FrameError" },
    })
  })
})
