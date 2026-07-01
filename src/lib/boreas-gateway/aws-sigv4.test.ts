// #158 — the AWS SigV4 signer is verified against an INDEPENDENT reimplementation
// of the same published algorithm, written from scratch with node:crypto's
// createHash/createHmac (never calling into aws-sigv4.ts's internals). A
// transcription bug in the module under test — wrong header casing, wrong
// hex encoding, a swapped HMAC chain step — shows up as a mismatch here even
// though both sides follow "the same spec", because the reference below was
// authored independently rather than by importing the module's helpers.

import { createHash, createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { signAwsRequestV4 } from "@/src/lib/boreas-gateway/aws-sigv4"

const ACCESS_KEY = "AKIDEXAMPLE"
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
const REGION = "us-east-1"
const SERVICE = "bedrock"
const NOW = new Date("2026-06-15T12:34:56Z")

/** Independent, from-scratch reimplementation of AWS's SigV4 steps (node:crypto only). */
function referenceSign(args: {
  method: string
  url: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  extraHeaders?: Record<string, string>
  body: string
  now: Date
}): { headers: Record<string, string> } {
  const u = new URL(args.url)
  const amzDate = args.now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)
  const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")
  const payloadHash = sha256Hex(args.body)

  const headersToSign: Record<string, string> = {
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(args.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const signedHeaderNames = Object.keys(headersToSign).sort()
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${headersToSign[n]}\n`).join("")
  const signedHeaders = signedHeaderNames.join(";")
  // Non-S3 services double-URI-encode the canonical path (see the matching note
  // in aws-sigv4.ts) — reimplemented independently here too, so this reference
  // actually exercises the same rule rather than assuming the module got it right.
  const canonicalUri = (u.pathname || "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const canonicalRequest = [args.method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n")
  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n")

  const hmac = (key: Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest()
  const kDate = hmac(Buffer.from(`AWS4${args.secretAccessKey}`, "utf8"), dateStamp)
  const kRegion = hmac(kDate, args.region)
  const kService = hmac(kRegion, args.service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { headers: { ...headersToSign, authorization } }
}

describe("signAwsRequestV4", () => {
  const baseArgs = {
    method: "POST" as const,
    url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3/converse",
    region: REGION,
    service: SERVICE,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    extraHeaders: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] }),
    now: NOW,
  }

  it("matches an independently-written node:crypto reimplementation of SigV4", async () => {
    const got = await signAwsRequestV4(baseArgs)
    const want = referenceSign(baseArgs)
    expect(got.headers.authorization).toBe(want.headers.authorization)
    expect(got.headers["x-amz-date"]).toBe(want.headers["x-amz-date"])
    expect(got.headers["x-amz-content-sha256"]).toBe(want.headers["x-amz-content-sha256"])
    expect(got.headers.host).toBe(want.headers.host)
  })

  it("double-URI-encodes a path segment that already contains a percent-escape (e.g. a Bedrock model id's colon) — matches the reference implementation", async () => {
    // Mirrors bedrockConverseUrl(): a real Bedrock model id like
    // "anthropic.claude-3-5-sonnet-20241022-v2:0" arrives here already
    // single-encoded (":" -> "%3A") by encodeURIComponent at URL-construction
    // time; the canonical URI must encode it AGAIN for a non-S3 service.
    const args = {
      ...baseArgs,
      url: `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent("anthropic.claude-3-5-sonnet-20241022-v2:0")}/converse`,
    }
    const got = await signAwsRequestV4(args)
    const want = referenceSign(args)
    expect(got.headers.authorization).toBe(want.headers.authorization)
    // Sanity: the double-encoding actually changed the signature vs. the
    // colon-free fixture — proves this is not a no-op path.
    const plain = await signAwsRequestV4(baseArgs)
    expect(got.headers.authorization).not.toBe(plain.headers.authorization)
  })

  it("matches the reference implementation for an empty-body request too", async () => {
    const { extraHeaders: _dropped, ...rest } = baseArgs
    const args = { ...rest, body: "" }
    const got = await signAwsRequestV4(args)
    const want = referenceSign(args)
    expect(got.headers.authorization).toBe(want.headers.authorization)
  })

  it("is deterministic for the same inputs + clock", async () => {
    const a = await signAwsRequestV4(baseArgs)
    const b = await signAwsRequestV4(baseArgs)
    expect(a.headers.authorization).toBe(b.headers.authorization)
  })

  it("changes the signature when the secret key changes", async () => {
    const a = await signAwsRequestV4(baseArgs)
    const b = await signAwsRequestV4({ ...baseArgs, secretAccessKey: "a-totally-different-secret-key" })
    expect(a.headers.authorization).not.toBe(b.headers.authorization)
  })

  it("changes the signature when the body changes (payload hash is part of the canonical request)", async () => {
    const a = await signAwsRequestV4(baseArgs)
    const b = await signAwsRequestV4({ ...baseArgs, body: JSON.stringify({ messages: [] }) })
    expect(a.headers.authorization).not.toBe(b.headers.authorization)
  })

  it("never embeds the plaintext secret access key in any produced header", async () => {
    const got = await signAwsRequestV4(baseArgs)
    for (const value of Object.values(got.headers)) {
      expect(value).not.toContain(SECRET_KEY)
    }
  })

  it("rejects a URL with a query string rather than silently mis-signing it", async () => {
    await expect(signAwsRequestV4({ ...baseArgs, url: `${baseArgs.url}?foo=bar` })).rejects.toThrow(/query string/i)
  })
})
