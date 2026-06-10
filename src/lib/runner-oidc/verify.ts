// SIG-184 — verify a GitHub Actions OIDC token (RS256 against GitHub's JWKS),
// then validate the standard claims. Mirrors the App's RS256 signing in
// github-app.ts, inverted to the public-key verify side. The JWKS fetch is
// injectable so the core is unit-testable without network.

import {
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URL,
  type GitHubOidcClaims,
  type Jwk,
  type OidcVerifyResult,
} from "./types"

/** base64url → bytes (JWT segments are base64url, no padding). */
export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")
  const bin = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64urlToString(s: string): string {
  return new TextDecoder().decode(base64urlToBytes(s))
}

/**
 * A decoded JWT header/payload MUST be a plain JSON object. `JSON.parse` happily
 * returns `null`, arrays, and primitives (all valid JSON + valid base64url, fully
 * attacker-controlled). `null` is the one shape where the later property reads
 * (`header.alg`, `claims.iss`) THROW instead of yielding `undefined` — which would
 * escape the function uncaught and break the "never throws" contract. Reject every
 * non-object shape so the contract is total, not just signature-segment-scoped.
 */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Default JWKS-fetch deadline — a stalled endpoint must not hang verification. */
const DEFAULT_JWKS_TIMEOUT_MS = 3000

export interface VerifyOpts {
  /** The token's `aud` must include this (the Sigilix-configured ingest audience). */
  expectedAudience: string
  /** Injectable JWKS source (default: fetch GitHub's well-known JWKS). */
  fetchJwks?: () => Promise<Jwk[]>
  /** Now in epoch ms for exp/nbf checks (default Date.now()). */
  nowMs?: number
  /** Clock-skew tolerance in seconds (default 60). */
  clockSkewSec?: number
  /** Deadline (ms) for the DEFAULT JWKS fetch (default 3000). Ignored when `fetchJwks` is injected. */
  jwksTimeoutMs?: number
}

async function defaultFetchJwks(timeoutMs: number): Promise<Jwk[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(GITHUB_OIDC_JWKS_URL, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`jwks ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    return Array.isArray(body.keys) ? body.keys : []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Verify a GitHub Actions OIDC JWT: RS256 signature against the matching JWKS
 * key, then issuer / audience / expiry / not-before. Returns the decoded
 * claims on success, or a typed failure. Never throws (JWKS/crypto failures
 * map to a failure result). Provenance (`job_workflow_ref` etc.) is a SEPARATE
 * gate — see provenance.ts — run only after this succeeds.
 */
export async function verifyGitHubOidcToken(token: string, opts: VerifyOpts): Promise<OidcVerifyResult> {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed-token" }
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  let rawHeader: unknown
  let rawClaims: unknown
  let sigBytes: Uint8Array<ArrayBuffer>
  try {
    rawHeader = JSON.parse(base64urlToString(headerB64))
    rawClaims = JSON.parse(base64urlToString(payloadB64))
    // Decode the signature HERE (inside the try) so a malformed signature
    // segment (atob throws on illegal chars) is a typed failure, not an
    // uncaught throw — preserving the "never throws" contract (an attacker
    // fully controls this segment).
    sigBytes = base64urlToBytes(sigB64)
  } catch {
    return { ok: false, reason: "malformed-token" }
  }
  // Parsed JWT segments MUST be plain objects. `null` (and arrays/primitives) are
  // valid JSON the attacker can supply; a `null` header would throw on the
  // `header.alg` read below, escaping the function uncaught. Reject here so the
  // never-throws contract holds for the whole function, not just the signature.
  if (!isJsonObject(rawHeader) || !isJsonObject(rawClaims)) {
    return { ok: false, reason: "malformed-token" }
  }
  const header = rawHeader as { alg?: string; kid?: string }
  const claims = rawClaims as GitHubOidcClaims
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported-alg" }
  if (!header.kid) return { ok: false, reason: "no-kid" }

  let keys: Jwk[]
  try {
    keys = await (opts.fetchJwks ?? (() => defaultFetchJwks(opts.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS)))()
  } catch {
    return { ok: false, reason: "jwks-fetch-failed" }
  }
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return { ok: false, reason: "unknown-kid" }

  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
  } catch {
    return { ok: false, reason: "unknown-kid" }
  }

  const encoded = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  // Copy into a freshly-allocated ArrayBuffer so the value is typed
  // `Uint8Array<ArrayBuffer>` (a valid BufferSource) under both the Workers and
  // Node lib type worlds; `TextEncoder.encode()` alone yields
  // `Uint8Array<ArrayBufferLike>`, which the DOM/Workers `BufferSource` rejects.
  // Type-level only — runtime bytes are identical.
  const signingInput = new Uint8Array(new ArrayBuffer(encoded.length))
  signingInput.set(encoded)
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, signingInput)
  if (!valid) return { ok: false, reason: "bad-signature" }

  // Signature is proven; now the standard claims.
  if (claims.iss !== GITHUB_OIDC_ISSUER) return { ok: false, reason: "wrong-issuer" }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!auds.includes(opts.expectedAudience)) return { ok: false, reason: "wrong-audience" }

  const nowSec = (opts.nowMs ?? Date.now()) / 1000
  const skew = opts.clockSkewSec ?? 60
  // exp is REQUIRED + must be numeric — fail closed. A missing/string exp
  // silently skipping the check would make a captured token a permanent
  // credential (the whole point of a ~minutes-short OIDC token is fast death).
  if (typeof claims.exp !== "number" || claims.exp + skew < nowSec) return { ok: false, reason: "expired" }
  // nbf is optional, but if present it must be numeric (a non-numeric nbf must
  // not silently pass).
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > nowSec)) {
    return { ok: false, reason: "not-yet-valid" }
  }

  return { ok: true, claims }
}
