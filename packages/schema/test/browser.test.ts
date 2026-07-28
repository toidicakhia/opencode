import { describe, expect, test } from "bun:test"
import { Browser } from "../src/browser.js"
import { BrowserControl } from "../src/browser-control.js"
import { BrowserTunnel } from "../src/browser-tunnel.js"
import { Session } from "../src/session.js"
import { Schema } from "effect"

const state: Browser.State = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}

describe("browser contracts", () => {
  test("creates exact-prefixed identifiers", () => {
    expect(Browser.LeaseID.create()).toStartWith("brl_")
    expect(BrowserControl.RequestID.create()).toStartWith("brr_")
    expect(() => Browser.LeaseID.make("lease_invalid")).toThrow()
    expect(() => BrowserControl.RequestID.make("request_invalid")).toThrow()
  })

  test("round trips browser control messages", () => {
    const codec = Schema.fromJsonString(BrowserControl.FromDesktop)
    const message: BrowserControl.FromDesktop = {
      type: "browser.control.sync",
      revision: 1,
      attachments: [
        {
          sessionID: Session.ID.make("ses_browser_contract"),
          leaseID: Browser.LeaseID.make("brl_contract"),
          state,
        },
      ],
    }
    const encoded = Schema.encodeSync(codec)(message)
    expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(message)
  })

  test("encodes screenshot bytes as base64", () => {
    const codec = Schema.fromJsonString(Browser.Outcome)
    const outcome: Browser.Outcome = {
      type: "success",
      result: {
        type: "screenshot",
        state,
        mediaType: "image/png",
        data: new Uint8Array([1, 2, 3]),
        width: 10,
        height: 20,
      },
    }
    const encoded = Schema.encodeSync(codec)(outcome)
    expect(encoded).toContain('"data":"AQID"')
    expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(outcome)
  })

  test("rejects invalid tunnel targets", () => {
    expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "", port: 3000 })).toThrow()
    expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "https://example.com", port: 443 })).toThrow()
    expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "local host", port: 3000 })).toThrow()
    expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "localhost", port: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "localhost", port: 65_536 })).toThrow()
  })
})
