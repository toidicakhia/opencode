import type { ServerProtocol } from "./utils/server-protocol"

export type BrowserPaneTarget = Readonly<{
  serverKey: string
  sessionID: string
}>

export type BrowserPaneEndpoint = Readonly<{
  url: string
  username?: string
  password?: string
}>

export type BrowserPaneBinding = BrowserPaneTarget &
  Readonly<{
    bindingID: string
    endpoint: BrowserPaneEndpoint
  }>

export type BrowserPaneBounds = { x: number; y: number; width: number; height: number }

export type BrowserPaneLayout = {
  attached: boolean
  visible: boolean
  destroy?: boolean
  background?: string
  bounds?: BrowserPaneBounds
}

export type BrowserPaneCommand =
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "stop" }

export type BrowserPaneState = {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export type BrowserPanePlatform = {
  setLayout(binding: BrowserPaneBinding, layout: BrowserPaneLayout): void
  command(binding: BrowserPaneBinding, command: BrowserPaneCommand): Promise<void>
  subscribe(binding: BrowserPaneBinding, cb: (state: BrowserPaneState) => void): Promise<() => void>
}

export function browserPaneAvailable(input: {
  platform: boolean
  enabled: boolean
  sessionID?: string
  protocol?: ServerProtocol
}) {
  return input.platform && input.enabled && !!input.sessionID && input.protocol === "v2"
}

export function createBrowserPaneBinding(input: BrowserPaneTarget & { endpoint: BrowserPaneEndpoint }) {
  const endpoint = Object.freeze({
    url: input.endpoint.url,
    username: input.endpoint.username,
    password: input.endpoint.password,
  })
  return Object.freeze({
    serverKey: input.serverKey,
    sessionID: input.sessionID,
    bindingID: globalThis.crypto.randomUUID(),
    endpoint,
  }) satisfies BrowserPaneBinding
}
