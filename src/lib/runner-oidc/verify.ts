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
export function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64urlToString(s: string): string {
  return new TextDecoder().decode(base64urlToBytes(s))
}

export interface VerifyOpts {
  /** The token's `aud` must include this (the Sigilix-configured ingest audience). */
  expectedAudience: string
  /** Injectable JWKS source (default: fetch GitHub's well-known JWKS). */
  fetchJwks?: () => Promise<Jwk[]>
  /** Now in epoch ms for exp/nbf checks (default Date.now()). */
  nowMs?: number
  /** Clock-skew tolerance in seconds (default 60). */
  clockSkewSec?: number
}

async function defaultFetchJwks(): Promise<Jwk[]> {
  const res = await fetch(GITHUB_OIDC_JWKS_URL)
  if (!res.ok) throw new Error(`jwks ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  return Array.isArray(body.keys) ? body.keys : []
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

  let header: { alg?: string; kid?: string }
  let claims: GitHubOidcClaims
  let sigBytes: Uint8Array
  try {
    header = JSON.parse(base64urlToString(headerB64)) as { alg?: string; kid?: string }
    claims = JSON.parse(base64urlToString(payloadB64)) as GitHubOidcClaims
    // Decode the signature HERE (inside the try) so a malformed signature
    // segment (atob throws on illegal chars) is a typed failure, not an
    // uncaught throw — preserving the "never throws" contract (an attacker
    // fully controls this segment).
    sigBytes = base64urlToBytes(sigB64)
  } catch {
    return { ok: false, reason: "malformed-token" }
  }
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported-alg" }
  if (!header.kid) return { ok: false, reason: "no-kid" }

  let keys: Jwk[]
  try {
    keys = await (opts.fetchJwks ?? defaultFetchJwks)()
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

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
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
