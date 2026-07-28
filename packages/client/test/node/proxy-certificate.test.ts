import { createHash, X509Certificate } from "node:crypto"
import { createSecureContext } from "node:tls"
import { describe, expect, test } from "bun:test"
import { createBrowserProxyCertificate } from "../../src/node/browser/proxy-certificate"

describe("browser proxy certificate", () => {
  test("creates a unique valid certificate pinned to its loopback names", () => {
    const hostname = "opencode-test.localhost"
    const first = createBrowserProxyCertificate(hostname)
    const second = createBrowserProxyCertificate(hostname)
    const certificate = new X509Certificate(first.certificate)
    const fingerprint = createHash("sha256").update(certificate.raw).digest("base64")

    expect(first.key.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true)
    expect(first.certificate.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true)
    expect(first.fingerprint).toBe(`sha256/${fingerprint}`)
    expect(certificate.subjectAltName).toContain(`DNS:${hostname}`)
    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1")
    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(() => createSecureContext({ key: first.key, cert: first.certificate })).not.toThrow()
  })
})
