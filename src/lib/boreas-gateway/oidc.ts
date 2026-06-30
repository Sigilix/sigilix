// SIG-545 (Boreas CLI gateway) — self-bootstrapping OIDC issuer.
//
// The gateway federates into GCP via Workload Identity Federation (no SA key —
// org policy blocks those). For GCP to trust the assertion JWT, the worker must
// publish an OIDC discovery doc + JWKS the GCP provider's issuer-uri points at.
// We generate the signing keypair ONCE, on first need, and persist the PRIVATE
// JWK in KV — no human ever handles a key.
//
// Security contract:
//   - The PRIVATE JWK lives under a dedicated KV key (OIDC_PRIVKEY_KV_KEY),
//     ENCRYPTED at rest with AES-GCM (the auth-session.ts pattern, keyed by
//     OPENCLAW_SESSION_ENCRYPTION_KEY). It is NEVER returned by any route and
//     NEVER logged. If that encryption key is unavailable the gateway is INERT
//     (we fail closed — we never store the private JWK as plaintext).
//   - The CryptoKey is imported as non-extractable so it can't be re-exported.
//   - Only the PUBLIC half (kty/n/e + kid/alg/use) is ever served (via JWKS).
//
// Cross-isolate convergence (the WIF kid-miss guard):
//   KV is the SINGLE SOURCE OF TRUTH for the signing key. Every sign/JWKS path
//   loads the (decrypted) key from KV and only generates+persists one when KV is
//   absent. The in-isolate cache is a SHORT-LIVED memo (MEMO_TTL_MS): after it
//   expires the isolate re-reads KV, so all isolates across all colos converge on
//   the KV value within the memo window — there is no permanent per-isolate key
//   that could sign with a kid the served JWKS (loaded from KV elsewhere) doesn't
//   carry. Operational precondition: the deploy runbook curls /.well-known/jwks.json
//   ONCE after deploy to bootstrap the KV key, BEFORE the GCP WIF provider is
//   configured against it.
//
// Reuse note: the WebCrypto RSASSA-PKCS1-v1_5 / SHA-256 shape mirrors
// github-app.ts (signing) + runner-oidc/verify.ts (jwk import); the at-rest
// AES-GCM encrypt/decrypt is reused from auth-session.ts. This is the
// key-MANAGEMENT side; signing of the assertion lives in vertex-token.ts.

import { encryptAccessToken, decryptAccessToken } from "@/src/lib/auth-session"
import { OIDC_PRIVKEY_KV_KEY } from "./constants"

/** The public JWK shape served at /.well-known/jwks.json. */
export interface PublicJwk {
  kty: "RSA"
  n: string
  e: string
  alg: "RS256"
  use: "sig"
  kid: string
}

/**
 * The persisted private JWK shape. WebCrypto's `JsonWebKey` type doesn't declare
 * `kid` (it's an optional registered member we set ourselves), so we widen it here
 * to carry the stable kid alongside the key material.
 */
type StoredPrivateJwk = JsonWebKey & { kid: string }

/** A materialized signing key: the import-ready private CryptoKey + its kid + the public JWK. */
export interface SigningKey {
  /** Non-extractable RSASSA-PKCS1-v1_5 / SHA-256 private key (sign-only). */
  privateKey: CryptoKey
  /** Stable key id — matches the JWKS entry + the assertion JWT header `kid`. */
  kid: string
  /** Public half for JWKS (carries no private material). */
  publicJwk: PublicJwk
}

/** Test seam so the memo window is deterministic. */
export interface SigningKeyOpts {
  now?: () => number
}

/**
 * How long an isolate may serve a memoized key before re-reading KV. Short on
 * purpose: it bounds how long a fleet can disagree after a key changes in KV, so
 * every isolate converges on the KV value within the window.
 */
const MEMO_TTL_MS = 5 * 60 * 1000

/**
 * Stable AAD binding for the at-rest blob (auth-session.ts derives AAD =
 * `auth_session:${ctx}`). Pinning it to the KV key namespaces the OIDC blob's AAD
 * apart from any session record, so a misplaced ciphertext can't cross-decrypt.
 */
const OIDC_AAD_CONTEXT = OIDC_PRIVKEY_KV_KEY

// Per-isolate SHORT-TTL memo + single-flight. `memo` is re-validated against KV on
// expiry (see file header), so an isolate never serves a permanently-stale key.
// `pending` collapses concurrent loads within one isolate into a single read/keygen.
let memo: { key: SigningKey; expireMs: number } | null = null
let pending: Promise<SigningKey> | null = null

/**
 * Return the gateway's signing key — KV is the single source of truth.
 *
 * - Serves the in-isolate memo while it's fresh (< MEMO_TTL_MS old).
 * - Otherwise loads the (decrypted) key from KV; generates + persists one ONLY if
 *   KV is absent, then re-reads KV so concurrent cold bootstraps converge on the
 *   single KV winner (last-write-wins).
 * - Fails CLOSED if `encryptionKey` (OPENCLAW_SESSION_ENCRYPTION_KEY) is unset —
 *   we refuse to store the private JWK unencrypted.
 */
export async function getOrCreateSigningKey(
  kv: KVNamespace,
  encryptionKey: string | undefined,
  opts?: SigningKeyOpts,
): Promise<SigningKey> {
  const now = opts?.now ?? Date.now
  if (memo && memo.expireMs > now()) return memo.key
  if (pending) return pending
  pending = load(kv, encryptionKey, now).finally(() => {
    pending = null
  })
  return pending
}

async function load(kv: KVNamespace, encryptionKey: string | undefined, now: () => number): Promise<SigningKey> {
  if (!encryptionKey) {
    // Fail closed: without the at-rest key we will NOT persist a plaintext private JWK.
    throw new Error(
      "getOrCreateSigningKey: OPENCLAW_SESSION_ENCRYPTION_KEY is unset — gateway inert (refusing to store the OIDC private key unencrypted)",
    )
  }
  let jwk = await readPrivateJwk(kv, encryptionKey)
  if (!jwk) {
    jwk = await generatePrivateJwk()
    await putPrivateJwk(kv, jwk, encryptionKey)
    // Converge concurrent cold bootstraps onto the KV winner (see file header).
    const after = await readPrivateJwk(kv, encryptionKey)
    if (after) jwk = after
  }
  const sk = await materialize(jwk)
  memo = { key: sk, expireMs: now() + MEMO_TTL_MS }
  return sk
}

/** Generate a fresh, EXTRACTABLE RSA-2048 private JWK with a stable kid + RS256/use=sig tags. */
async function generatePrivateJwk(): Promise<StoredPrivateJwk> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // extractable: required so we can export + persist the private JWK
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
  return { ...jwk, kid: crypto.randomUUID(), alg: "RS256", use: "sig" }
}

/** Encrypt the private JWK (AES-GCM, OPENCLAW_SESSION_ENCRYPTION_KEY) + store `{ ciphertext, iv }`. */
async function putPrivateJwk(kv: KVNamespace, jwk: StoredPrivateJwk, encryptionKey: string): Promise<void> {
  const { ciphertext, iv } = await encryptAccessToken(JSON.stringify(jwk), OIDC_AAD_CONTEXT, encryptionKey)
  await kv.put(OIDC_PRIVKEY_KV_KEY, JSON.stringify({ ciphertext, iv }))
}

/**
 * Read + decrypt + shape-validate the stored private JWK. Returns null on absent /
 * corrupt / undecryptable (a key rotation that orphans the old blob → regenerate).
 */
async function readPrivateJwk(kv: KVNamespace, encryptionKey: string): Promise<StoredPrivateJwk | null> {
  const raw = await kv.get(OIDC_PRIVKEY_KV_KEY)
  if (!raw) return null
  try {
    const blob = JSON.parse(raw) as { ciphertext?: unknown; iv?: unknown }
    if (!blob || typeof blob.ciphertext !== "string" || typeof blob.iv !== "string") return null
    const plaintext = await decryptAccessToken(
      { encryptedAccessToken: blob.ciphertext, iv: blob.iv },
      OIDC_AAD_CONTEXT,
      encryptionKey,
    )
    const j = JSON.parse(plaintext) as StoredPrivateJwk
    return j && typeof j.n === "string" && typeof j.e === "string" && typeof j.kid === "string" ? j : null
  } catch {
    return null
  }
}

/**
 * Import the private JWK (NON-extractable, sign-only) + derive the public JWK from
 * its n/e. Importing non-extractable means the resulting CryptoKey can never be
 * exported back out — the private material exists only inside KV (encrypted at rest)
 * and the opaque key handle (in memory).
 */
async function materialize(jwk: StoredPrivateJwk): Promise<SigningKey> {
  const kid = jwk.kid
  if (!kid || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new Error("getOrCreateSigningKey: stored OIDC key missing kid/n/e")
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, // non-extractable: the imported key can never be re-exported
    ["sign"],
  )
  const publicJwk: PublicJwk = { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid }
  return { privateKey, kid, publicJwk }
}

/** Test-only: reset the module-global signing-key memo + single-flight slot. */
export function __resetSigningKeyCacheForTests(): void {
  memo = null
  pending = null
}
