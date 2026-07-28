import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto"

// Certificate construction follows VS Code's MIT-licensed tunnel proxy implementation.
// Copyright (c) Microsoft Corporation.

/** Creates the ephemeral certificate pinned by the browser proxy's host. */
export function createBrowserProxyCertificate(hostname: string) {
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const certificate = createCertificate(keys.privateKey, keys.publicKey, hostname)
  const fingerprint = `sha256/${createHash("sha256").update(pemToDer(certificate)).digest("base64")}`
  return { key: keys.privateKey, certificate, fingerprint }
}

function createCertificate(privateKey: string, publicKey: string, hostname: string) {
  const serial = randomBytes(8)
  serial[0] &= 0x7f
  if (serial.every((byte) => byte === 0)) serial[serial.length - 1] = 1
  const now = new Date(Date.now() - 60_000)
  const expires = new Date(now)
  expires.setUTCFullYear(expires.getUTCFullYear() + 1)
  const name = sequence([set([sequence([oid(Buffer.from([0x55, 0x04, 0x03])), utf8("OpenCode Browser Proxy")])])])
  const signatureAlgorithm = sequence([oid(Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))])
  const extensions = Buffer.concat([
    Buffer.from([0xa3]),
    lengthPrefix(
      sequence([
        sequence([
          oid(Buffer.from([0x55, 0x1d, 0x11])),
          octetString(
            sequence([tagged(0x82, Buffer.from(hostname, "ascii")), tagged(0x87, Buffer.from([127, 0, 0, 1]))]),
          ),
        ]),
      ]),
    ),
  ])
  const body = sequence([
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]),
    integer(serial),
    signatureAlgorithm,
    name,
    sequence([time(now), time(expires)]),
    name,
    pemToDer(publicKey),
    extensions,
  ])
  const signer = createSign("SHA256")
  signer.update(body)
  const signature = signer.sign(privateKey)
  const certificate = sequence([
    body,
    signatureAlgorithm,
    Buffer.concat([Buffer.from([0x03]), length(signature.length + 1), Buffer.from([0]), signature]),
  ])
  const encoded = certificate
    .toString("base64")
    .match(/.{1,64}/g)
    ?.join("\n")
  if (!encoded) throw new Error("Failed to encode browser proxy certificate")
  return `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`
}

function pemToDer(pem: string) {
  return Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replaceAll(/\s/g, ""), "base64")
}

function length(value: number) {
  if (value < 0x80) return Buffer.from([value])
  if (value < 0x100) return Buffer.from([0x81, value])
  if (value < 0x10000) return Buffer.from([0x82, value >> 8, value & 0xff])
  if (value < 0x1000000) return Buffer.from([0x83, value >> 16, (value >> 8) & 0xff, value & 0xff])
  throw new RangeError(`ASN.1 value is too large: ${value}`)
}

function lengthPrefix(value: Buffer) {
  return Buffer.concat([length(value.length), value])
}

function tagged(tag: number, value: Buffer) {
  return Buffer.concat([Buffer.from([tag]), lengthPrefix(value)])
}

function sequence(items: ReadonlyArray<Buffer>) {
  return tagged(0x30, Buffer.concat(items))
}

function set(items: ReadonlyArray<Buffer>) {
  return tagged(0x31, Buffer.concat(items))
}

function integer(value: Buffer) {
  const first = value.findIndex(
    (byte, index) => byte !== 0 || index === value.length - 1 || (value[index + 1] & 0x80) !== 0,
  )
  const canonical = value.subarray(first < 0 ? value.length - 1 : first)
  return tagged(0x02, canonical[0] & 0x80 ? Buffer.concat([Buffer.from([0]), canonical]) : canonical)
}

function oid(value: Buffer) {
  return tagged(0x06, value)
}

function utf8(value: string) {
  return tagged(0x0c, Buffer.from(value, "utf8"))
}

function octetString(value: Buffer) {
  return tagged(0x04, value)
}

function time(value: Date) {
  const encoded = value.toISOString().replaceAll(/[-:T]/g, "")
  if (value.getUTCFullYear() < 2050) return tagged(0x17, Buffer.from(encoded.slice(2, 14) + "Z", "ascii"))
  return tagged(0x18, Buffer.from(encoded.slice(0, 14) + "Z", "ascii"))
}
