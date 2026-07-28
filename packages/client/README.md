# @opencode-ai/client

Promise and Effect clients derived from OpenCode's authoritative Effect `HttpApi`, plus handwritten Node transports.

## Entrypoints

- `@opencode-ai/client`: zero-Effect Promise client using `fetch`.
- `@opencode-ai/client/node`: Promise client plus Node-hosted browser attachments.
- `@opencode-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@opencode-ai/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@opencode-ai/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core, Effect, Schema, Protocol, or WebSocket runtime dependency. `/node` adds Effect, Schema, Protocol, and `ws`, but never Core or Server. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce these import graphs.

## Node browser attachments

The Node entrypoint owns the control connection, Session lease, authenticated proxy, and network tunnels. Consumers provide a browser adapter once with `BrowserDriver.define`; normal attachment calls only provide a Session ID and that descriptor.

```ts
import { BrowserDriver, BrowserDriverError, OpenCode } from "@opencode-ai/client/node"

const driver = BrowserDriver.define(async ({ proxy, signal }) => {
  const browser = await launchBrowser({ proxy, signal })
  return {
    resource: browser,
    state: () => browser.state(),
    subscribe: (listener) => browser.subscribe(listener),
    execute: async (command, options) => {
      try {
        return await browser.execute(command, options)
      } catch (cause) {
        throw new BrowserDriverError("internal", "Browser command failed", { cause })
      }
    },
    dispose: () => browser.close(),
  }
})

const client = OpenCode.make({
  baseUrl: "https://opencode.example",
  headers: { authorization: `Basic ${credentials}` },
})
const attachment = await client.browser.attach({ sessionID, driver })

await attachment.close()
```

`attach` resolves only after the server acknowledges the exact Session lease. Each attachment has its own proxy and driver resource; `close()` and `Symbol.asyncDispose` are idempotent. A single Node client multiplexes up to 16 distinct Sessions over one lazily opened control WebSocket.

Driver factories should return after configuring their resource rather than await a proxied navigation: tunnel dialing is deliberately held behind the first lease acknowledgement, which is published after the driver supplies its initial state.

`BrowserDriver` descriptors are structural factory functions, so adapters remain compatible across duplicate client package instances. The Node entrypoint also re-exports canonical `Browser` contracts. Throw `BrowserDriverError` for typed command failures; structurally equivalent errors are accepted only when their `code` is a valid `Browser.ErrorCode`.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, OpenCode, Prompt } from "@opencode-ai/client/effect"

const client = yield * OpenCode.make({ baseUrl: "https://opencode.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```
