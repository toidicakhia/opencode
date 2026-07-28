import { Buffer } from "node:buffer"

export type BrowserPaneBounds = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function allowedBrowserURL(input: string) {
  if (input === "about:blank") return true
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
}

export function browserDestinationOrigin(input: string) {
  if (input === "about:blank") return input
  if (!allowedBrowserURL(input)) return undefined
  return new URL(input).origin
}

export function browserHistoryDestinationOrigin(
  history: {
    readonly getActiveIndex: () => number
    readonly getAllEntries: () => ReadonlyArray<{ readonly url: string }>
  },
  offset: number,
) {
  const entry = history.getAllEntries()[history.getActiveIndex() + offset]
  return entry ? browserDestinationOrigin(entry.url) : undefined
}

export function allowedBrowserDestination(input: string, approvedOrigin?: string) {
  if (input === "about:blank") return true
  return approvedOrigin !== undefined && browserDestinationOrigin(input) === approvedOrigin
}

export function browserContextPartition(serverKey: string, sessionID: string, bindingID: string, contextID: string) {
  const encode = (value: string) => Buffer.from(value).toString("base64url")
  return `opencode-browser-${encode(serverKey)}-${encode(sessionID)}-${encode(bindingID)}-${encode(contextID)}`
}

export function normalizeBrowserBounds(input: BrowserPaneBounds, parent: BrowserPaneBounds) {
  if (![input.x, input.y, input.width, input.height].every(Number.isFinite)) return undefined
  const left = Math.max(0, Math.min(Math.round(input.x), parent.width))
  const top = Math.max(0, Math.min(Math.round(input.y), parent.height))
  const right = Math.max(left, Math.min(Math.round(input.x + input.width), parent.width))
  const bottom = Math.max(top, Math.min(Math.round(input.y + input.height), parent.height))
  if (right === left || bottom === top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Opaque corner masks cut only the bottom edge while the native view keeps square top corners. */
export function browserBottomMasks(bounds: BrowserPaneBounds) {
  if (bounds.width < 20 || bounds.height < 10) return []
  const segments = [
    { offset: 0, height: 2, width: 6 },
    { offset: 2, height: 2, width: 3 },
    { offset: 4, height: 2, width: 2 },
    { offset: 6, height: 4, width: 1 },
  ]
  return segments.flatMap((segment) => {
    const y = bounds.y + bounds.height - segment.offset - segment.height
    return [
      { x: bounds.x, y, width: segment.width, height: segment.height },
      { x: bounds.x + bounds.width - segment.width, y, width: segment.width, height: segment.height },
    ]
  })
}
