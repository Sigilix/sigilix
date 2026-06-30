// SIG-545 (Boreas CLI gateway) — mint a Vertex (GCP) access token, keyless.
//
// The flow, per the WIF design (Codex review fixes are BINDING):
//   1. Sign a short-lived assertion JWT (RS256) with the self-bootstrapped OIDC
//      key — header { alg, typ, kid }, payload { iss, sub, aud, iat-60, exp+300 }.
//      iat is BACKDATED 60s to absorb clock skew. (Distinct from github-app.ts's
//      header, which has no kid/sub/aud — only the WebCrypto sign shape is shared.)
//   2. STS token-exchange the assertion → a short federated token. POST is
//      form-urlencoded with NO Authorization header (the subject_token JWT IS the
//      auth); audience = the full WIF provider resource name.
//   3. Impersonate the Vertex SA via iamcredentials generateAccessToken → a 1h SA
//      access token (+ its RFC3339 expireTime).
//
// The SA token is cached (KV, cross-isolate; + an in-isolate memo) and reused until
// `expireTime - 5min` (minus a small jitter to de-synchronize fleet refreshes). A
// per-isolate single-flight pending-promise collapses concurrent refreshes into one
// mint. NOTHING here logs or returns the assertion / federated / SA token.

import type { Env } from "@/src/shared/types/env"
import { getOrCreateSigningKey } from "./oidc"
import {
  ASSERTION_AUDIENCE,
  ASSERTION_SUBJECT,
  CLOUD_PLATFORM_SCOPE,
  GENERATE_ACCESS_TOKEN_URL,
  STS_AUDIENCE,
  STS_TOKEN_URL,
  VERTEX_TOKEN_KV_KEY,
} from "./constants"

/** Refresh this long before expiry so we never serve a token that's about to die. */
const REFRESH_BEFORE_MS = 5 * 60 * 1000
/** Upper bound on the random refresh jitter (de-synchronizes a fleet's refreshes). */
const MAX_REFRESH_JITTER_MS = 30 * 1000

interface CachedVertexToken {
  accessToken: string
  /** RFC3339 timestamp from iamcredentials (the SA token's expiry). */
  expireTime: string
}

/** Per-isolate memo + single-flight. Mirrors jwks-cache.ts. */
let memo: { accessToken: string; expireMs: number } | null = null
let pending: Promise<string> | null = null

/** Test seam so timing + jitter are deterministic. */
export interface VertexTokenOpts {
  now?: () => number
  /** Fixed refresh jitter in ms (default: random 0..MAX_REFRESH_JITTER_MS). */
  jitterMs?: number
}

/**
 * Sign the assertion JWT presented to GCP STS. Header carries the `kid` so the GCP
 * provider can select the matching JWKS key; payload is backdated + ~5min-lived.
 * Exported for token-mint use + direct testing (verify against the public JWK).
 */
export async function signAssertionJwt(args: {
  privateKey: CryptoKey
  kid: string
  issuer: string
  now?: number
}): Promise<string> {
  const now = args.now ?? Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT", kid: args.kid }
  const payload = {
    iss: args.issuer,
    sub: ASSERTION_SUBJECT,
    aud: ASSERTION_AUDIENCE,
    iat: now - 60, // backdate to absorb clock skew
    exp: now + 300, // ~5min lifetime
  }
  const enc = new TextEncoder()
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, args.privateKey, enc.encode(signingInput))
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

/**
 * Get a Vertex SA access token, minting + caching on miss. Reuses the cached token
 * until `expireTime - 5min - jitter`. Concurrent callers in one isolate collapse to
 * a single mint via the pending promise.
 */
export async function getVertexAccessToken(env: Env, ctx: ExecutionContext, opts?: VertexTokenOpts): Promise<string> {
  const now = opts?.now ?? Date.now
  const jitterMs = opts?.jitterMs ?? Math.floor(Math.random() * MAX_REFRESH_JITTER_MS)
  if (memo && isFresh(memo.expireMs, now(), jitterMs)) return memo.accessToken
  if (pending) return pending
  pending = refresh(env, ctx, now, jitterMs).finally(() => {
    pending = null
  })
  return pending
}

/** Cross-isolate cache check → mint. Single-flighted by getVertexAccessToken's `pending`. */
async function refresh(env: Env, ctx: ExecutionContext, now: () => number, jitterMs: number): Promise<string> {
  const cached = await readCachedToken(env)
  if (cached) {
    const expireMs = Date.parse(cached.expireTime)
    if (Number.isFinite(expireMs) && isFresh(expireMs, now(), jitterMs)) {
      memo = { accessToken: cached.accessToken, expireMs }
      return cached.accessToken
    }
  }
  const issuer = requireIssuer(env)
  const minted = await mint(env, issuer)
  const expireMs = Date.parse(minted.expireTime)
  memo = { accessToken: minted.accessToken, expireMs }
  // Persist for other isolates; best-effort + non-blocking. A stale TTL floor keeps
  // a non-finite expiry from writing a forever key.
  const ttlSeconds = Number.isFinite(expireMs) ? Math.max(60, Math.floor((expireMs - now()) / 1000)) : 60
  ctx.waitUntil(
    env.OPENCLAW_STATE.put(VERTEX_TOKEN_KV_KEY, JSON.stringify(minted), { expirationTtl: ttlSeconds }).catch(() => {}),
  )
  return minted.accessToken
}

function isFresh(expireMs: number, nowMs: number, jitterMs: number): boolean {
  return expireMs - REFRESH_BEFORE_MS - jitterMs > nowMs
}

function requireIssuer(env: Env): string {
  const issuer = env.OPENCLAW_GATEWAY_ISSUER
  if (!issuer) throw new Error("getVertexAccessToken: OPENCLAW_GATEWAY_ISSUER is unset")
  return issuer.replace(/\/$/, "")
}

/** Read + shape-validate the cached SA token. Returns null on absent / corrupt. */
async function readCachedToken(env: Env): Promise<CachedVertexToken | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(VERTEX_TOKEN_KV_KEY)
    if (!raw) return null
    const j = JSON.parse(raw) as CachedVertexToken
    return j && typeof j.accessToken === "string" && typeof j.expireTime === "string" ? j : null
  } catch {
    return null
  }
}

/** Sign assertion → STS exchange → SA impersonation. Throws on any GCP failure. */
async function mint(env: Env, issuer: string): Promise<CachedVertexToken> {
  const { privateKey, kid } = await getOrCreateSigningKey(env.OPENCLAW_STATE)
  const assertion = await signAssertionJwt({ privateKey, kid, issuer })
  const federated = await stsExchange(assertion)
  return impersonateServiceAccount(federated)
}

/** STS token-exchange: assertion JWT → federated access token. No Authorization header. */
async function stsExchange(assertion: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: STS_AUDIENCE,
    scope: CLOUD_PLATFORM_SCOPE,
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: assertion,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  })
  const res = await fetch(STS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    throw new Error(`STS token-exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { access_token?: string }
  if (typeof json.access_token !== "string" || json.access_token === "") {
    throw new Error("STS token-exchange response missing access_token")
  }
  return json.access_token
}

/** Impersonate the Vertex SA: federated token → 1h SA access token (+ expireTime). */
async function impersonateServiceAccount(federated: string): Promise<CachedVertexToken> {
  const res = await fetch(GENERATE_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${federated}`, "content-type": "application/json" },
    body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE], lifetime: "3600s" }),
  })
  if (!res.ok) {
    throw new Error(`generateAccessToken failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { accessToken?: string; expireTime?: string }
  if (typeof json.accessToken !== "string" || typeof json.expireTime !== "string") {
    throw new Error("generateAccessToken response missing accessToken/expireTime")
  }
  return { accessToken: json.accessToken, expireTime: json.expireTime }
}

/** base64url (no padding) — mirrors github-app.ts. */
function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

/** Test-only: reset the module-global token memo + single-flight slot. */
export function __resetVertexTokenCacheForTests(): void {
  memo = null
  pending = null
}
