// SIG-184 — unit tests for the GitHub OIDC verifier + provenance gate.
// Signs fixture tokens with a real generated RSA keypair (no network).

import { describe, expect, it } from "vitest"
import { verifyGitHubOidcToken } from "../src/lib/runner-oidc/verify"
import { validateRunnerProvenance } from "../src/lib/runner-oidc/provenance"
import type { GitHubOidcClaims, Jwk } from "../src/lib/runner-oidc/types"

const ISS = "https://token.actions.githubusercontent.com"
const AUD = "https://sigilix.example/runner-ingest"
const KID = "test-kid-1"
const NOW_MS = 1_999_999_500 * 1000

function b64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)))
}

async function genKey(): Promise<{ privateKey: CryptoKey; jwk: Jwk }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey
  return { privateKey: pair.privateKey, jwk: { kid: KID, kty: jwk.kty!, n: jwk.n!, e: jwk.e!, alg: "RS256", use: "sig" } }
}

async function signToken(
  claims: Partial<GitHubOidcClaims>,
  privateKey: CryptoKey,
  header: Record<string, unknown> = { alg: "RS256", kid: KID },
): Promise<string> {
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

const baseClaims: GitHubOidcClaims = {
  iss: ISS,
  aud: AUD,
  exp: 2_000_000_000,
  iat: 1_999_999_000,
  repository: "Sigilix/sigilix",
  sha: "deadbeef",
  job_workflow_ref: "sigilix/runner/.github/workflows/scan.yml@abc123",
  runner_environment: "github-hosted",
}

describe("verifyGitHubOidcToken", () => {
  it("accepts a correctly-signed, in-window token", async () => {
    const { privateKey, jwk } = await genKey()
    const token = await signToken(baseClaims, privateKey)
    const r = await verifyGitHubOidcToken(token, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.claims.repository).toBe("Sigilix/sigilix")
  })

  it("accepts an array audience that includes the expected value", async () => {
    const { privateKey, jwk } = await genKey()
    const token = await signToken({ ...baseClaims, aud: ["other", AUD] }, privateKey)
    const r = await verifyGitHubOidcToken(token, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })
    expect(r.ok).toBe(true)
  })

  it("rejects a tampered/wrong-key signature", async () => {
    const signer = await genKey()
    const other = await genKey() // different key, presented under the same kid
    const token = await signToken(baseClaims, signer.privateKey)
    const r = await verifyGitHubOidcToken(token, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [other.jwk] })
    expect(r).toEqual({ ok: false, reason: "bad-signature" })
  })

  it("rejects expired / not-yet-valid", async () => {
    const { privateKey, jwk } = await genKey()
    const expired = await signToken({ ...baseClaims, exp: 1_000_000_000 }, privateKey)
    expect(await verifyGitHubOidcToken(expired, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "expired" })
    const future = await signToken({ ...baseClaims, nbf: 2_100_000_000 }, privateKey)
    expect(await verifyGitHubOidcToken(future, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "not-yet-valid" })
  })

  it("rejects wrong issuer / wrong audience", async () => {
    const { privateKey, jwk } = await genKey()
    const wrongIss = await signToken({ ...baseClaims, iss: "https://evil.example" }, privateKey)
    expect(await verifyGitHubOidcToken(wrongIss, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "wrong-issuer" })
    const wrongAud = await signToken({ ...baseClaims, aud: "https://someone-else" }, privateKey)
    expect(await verifyGitHubOidcToken(wrongAud, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "wrong-audience" })
  })

  it("rejects non-RS256 alg, missing kid, unknown kid", async () => {
    const { privateKey, jwk } = await genKey()
    const hs = await signToken(baseClaims, privateKey, { alg: "HS256", kid: KID })
    expect((await verifyGitHubOidcToken(hs, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).ok).toBe(false)
    const noKid = await signToken(baseClaims, privateKey, { alg: "RS256" })
    expect(await verifyGitHubOidcToken(noKid, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "no-kid" })
    const token = await signToken(baseClaims, privateKey)
    expect(await verifyGitHubOidcToken(token, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [{ ...jwk, kid: "other-kid" }] })).toEqual({ ok: false, reason: "unknown-kid" })
  })

  it("rejects malformed token + maps a JWKS fetch failure to a typed reason", async () => {
    expect(await verifyGitHubOidcToken("not.a.jwt.x", { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [] })).toEqual({ ok: false, reason: "malformed-token" })
    expect(await verifyGitHubOidcToken("only-one-part", { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [] })).toEqual({ ok: false, reason: "malformed-token" })
    const { privateKey } = await genKey()
    const token = await signToken(baseClaims, privateKey)
    expect(await verifyGitHubOidcToken(token, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => { throw new Error("network") } })).toEqual({ ok: false, reason: "jwks-fetch-failed" })
  })

  it("fails CLOSED on a missing or non-numeric exp (no silent skip)", async () => {
    const { privateKey, jwk } = await genKey()
    const noExp = await signToken({ ...baseClaims, exp: undefined }, privateKey)
    expect(await verifyGitHubOidcToken(noExp, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "expired" })
    const strExp = await signToken({ ...baseClaims, exp: "2000000000" as unknown as number }, privateKey)
    expect(await verifyGitHubOidcToken(strExp, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })).toEqual({ ok: false, reason: "expired" })
  })

  it("does NOT throw on a malformed signature segment (never-throws contract)", async () => {
    const { privateKey, jwk } = await genKey()
    const valid = await signToken(baseClaims, privateKey)
    const badSig = `${valid.split(".").slice(0, 2).join(".")}.abc def!!` // illegal base64url chars
    const r = await verifyGitHubOidcToken(badSig, { expectedAudience: AUD, nowMs: NOW_MS, fetchJwks: async () => [jwk] })
    expect(r).toEqual({ ok: false, reason: "malformed-token" })
  })
})

describe("validateRunnerProvenance", () => {
  const WORKFLOW = "sigilix/runner/.github/workflows/scan.yml"
  it("accepts a token from the pinned reusable workflow on a github-hosted runner", () => {
    expect(validateRunnerProvenance(baseClaims, { workflowRef: WORKFLOW, repository: "Sigilix/sigilix", sha: "deadbeef" })).toEqual({ ok: true })
  })
  it("rejects a workflow-ref outside Sigilix's pinned workflow", () => {
    expect(validateRunnerProvenance({ ...baseClaims, job_workflow_ref: "attacker/repo/.github/workflows/x.yml@y" }, { workflowRef: WORKFLOW })).toEqual({ ok: false, reason: "workflow-ref-mismatch" })
  })
  it("rejects a SIBLING-repo prefix spoof (exact match, not startsWith)", () => {
    // `sigilix/runner-evil/...` would pass a naive startsWith on `sigilix/runner`.
    expect(validateRunnerProvenance({ ...baseClaims, job_workflow_ref: "sigilix/runner-evil/.github/workflows/scan.yml@x" }, { workflowRef: WORKFLOW })).toEqual({ ok: false, reason: "workflow-ref-mismatch" })
  })
  it("accepts any @ref of OUR workflow path", () => {
    expect(validateRunnerProvenance({ ...baseClaims, job_workflow_ref: `${WORKFLOW}@refs/heads/main` }, { workflowRef: WORKFLOW })).toEqual({ ok: true })
  })
  it("rejects a non-github-hosted runner unless self-host is allowed", () => {
    const selfHosted = { ...baseClaims, runner_environment: "self-hosted" }
    expect(validateRunnerProvenance(selfHosted, { workflowRef: WORKFLOW })).toEqual({ ok: false, reason: "non-github-hosted-runner" })
    expect(validateRunnerProvenance(selfHosted, { workflowRef: WORKFLOW, allowSelfHosted: true })).toEqual({ ok: true })
  })
  it("binds to the SARIF repo + sha", () => {
    expect(validateRunnerProvenance(baseClaims, { workflowRef: WORKFLOW, repository: "other/repo" })).toEqual({ ok: false, reason: "repository-mismatch" })
    expect(validateRunnerProvenance(baseClaims, { workflowRef: WORKFLOW, sha: "feedface" })).toEqual({ ok: false, reason: "sha-mismatch" })
  })
})
