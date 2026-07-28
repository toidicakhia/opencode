export * as BrowserNetwork from "./browser-network"

import type { BrowserProxy } from "@opencode-ai/client/node"

export async function installBrowserNetwork(input: {
  readonly proxy: BrowserProxy
  readonly session: Electron.Session
  readonly webContents: Electron.WebContents
}) {
  let disposed = false
  const onLogin = (
    event: Electron.Event,
    _details: Electron.LoginAuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => {
    if (
      !authInfo.isProxy ||
      authInfo.scheme !== "basic" ||
      authInfo.host !== input.proxy.host ||
      authInfo.port !== input.proxy.port ||
      authInfo.realm !== "OpenCode Browser Proxy"
    )
      return
    event.preventDefault()
    callback(input.proxy.credentials.username, input.proxy.credentials.password)
  }
  const cleanup = () => {
    if (disposed) return
    disposed = true
    input.webContents.off("login", onLogin)
    input.session.setCertificateVerifyProc(null)
    void input.session.closeAllConnections()
  }

  input.session.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== input.proxy.host) {
      callback(-3)
      return
    }
    callback(request.certificate.fingerprint === input.proxy.certificateFingerprint ? 0 : -2)
  })
  input.webContents.on("login", onLogin)
  input.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
  return input.session
    .setProxy({
      mode: "fixed_servers",
      proxyRules: input.proxy.url,
      proxyBypassRules: "<-loopback>",
    })
    .then(() => input.session.closeAllConnections())
    .then(
      () => cleanup,
      (error) => {
        cleanup()
        throw error
      },
    )
}
