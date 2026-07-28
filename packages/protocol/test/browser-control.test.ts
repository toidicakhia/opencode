import { describe, expect, test } from "bun:test"
import { BrowserControlProtocol } from "../src/browser-control.js"
import { Effect } from "effect"

describe("BrowserControlProtocol", () => {
  test("decodes text and Bun-compatible UTF-8 byte messages", async () => {
    const message = '{"type":"browser.control.sync","revision":1,"attachments":[]}'
    expect(await Effect.runPromise(BrowserControlProtocol.decodeFromDesktop(message))).toEqual({
      type: "browser.control.sync",
      revision: 1,
      attachments: [],
    })
    expect(
      await Effect.runPromise(BrowserControlProtocol.decodeFromDesktop(new TextEncoder().encode(message))),
    ).toEqual({
      type: "browser.control.sync",
      revision: 1,
      attachments: [],
    })
  })

  test("round trips both control directions", async () => {
    const desktop = { type: "browser.control.sync" as const, revision: 1, attachments: [] }
    const server = { type: "browser.control.synced" as const, revision: 1 }
    expect(
      await Effect.runPromise(BrowserControlProtocol.decodeFromDesktop(BrowserControlProtocol.encodeFromDesktop(desktop))),
    ).toEqual(desktop)
    expect(
      await Effect.runPromise(BrowserControlProtocol.decodeFromServer(BrowserControlProtocol.encodeFromServer(server))),
    ).toEqual(server)
  })

  test("rejects excess properties and oversized messages", async () => {
    expect(
      await Effect.runPromise(
        BrowserControlProtocol.decodeFromDesktop(
          '{"type":"browser.control.sync","revision":1,"attachments":[],"extra":true}',
        ).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "BrowserControlProtocol.MessageError" } })

    expect(
      await Effect.runPromise(
        BrowserControlProtocol.decodeFromDesktop(new Uint8Array(BrowserControlProtocol.MaxMessageBytes + 1)).pipe(
          Effect.result,
        ),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BrowserControlProtocol.MessageError", kind: "too_large" },
    })
  })
})
