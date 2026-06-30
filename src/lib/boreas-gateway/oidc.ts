// SIG-545 (Boreas CLI gateway) — self-bootstrapping OIDC issuer.
//
// The gateway federates into GCP via Workload Identity Federation (no SA key —
// org policy blocks those). For GCP to trust the assertion JWT, the worker must
// publish an OIDC discovery doc + JWKS the GCP provider's issuer-uri points at.
// We generate the signing keypair ONCE, on first need, and persist the PRIVATE
// JWK in KV — no human ever handles a key.
//
// Security contract:
//   - The PRIVATE JWK lives under a dedicated KV key (OIDC_PRIVKEY_KV_KEY). It is
//     NEVER returned by any route and NEVER logged. The CryptoKey is imported as
//     non-extractable so it can't be re-exported out of the worker.
//   - Only the PUBLIC half (kty/n/e + kid/alg/use) is ever served (via JWKS).
//
// Reuse note: the WebCrypto RSASSA-PKCS1-v1_5 / SHA-256 shape mirrors
// github-app.ts (signing) + runner-oidc/verify.ts (jwk import). This is the
// key-MANAGEMENT side; signing of the assertion lives in vertex-token.ts.

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

// Per-isolate cache + single-flight. The keypair is stable once bootstrapped, so a
// plain module-global suffices (the jwks-cache.ts pattern). `pending` collapses
// concurrent cold bootstraps within one isolate into a single keygen.
let cached: SigningKey | null = null
let pending: Promise<SigningKey> | null = null

/**
 * Return the gateway's signing key, generating + persisting it on first need.
 *
 * - Cached in-isolate after the first call.
 * - On a cold isolate: read the PRIVATE JWK from KV; if absent, generate a fresh
 *   RSA-2048 keypair, persist the private JWK, then re-read KV and adopt whatever
 *   is stored. The re-read converges two cold isolates that bootstrap at the same
 *   instant onto the single KV winner (last-write-wins), avoiding a split where a
 *   token signed by one isolate's kid fails JWKS lookup against the other's.
 */
export async function getOrCreateSigningKey(kv: KVNamespace): Promise<SigningKey> {
  if (cached) return cached
  if (pending) return pending
  pending = bootstrap(kv).finally(() => {
    pending = null
  })
  return pending
}

async function bootstrap(kv: KVNamespace): Promise<SigningKey> {
  let jwk = await readPrivateJwk(kv)
  if (!jwk) {
    jwk = await generatePrivateJwk()
    await kv.put(OIDC_PRIVKEY_KV_KEY, JSON.stringify(jwk))
    // Converge concurrent cold bootstraps onto the KV winner (see fn doc).
    const after = await readPrivateJwk(kv)
    if (after) jwk = after
  }
  const sk = await materialize(jwk)
  cached = sk
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

/** Read + shape-validate the stored private JWK. Returns null on absent / corrupt. */
async function readPrivateJwk(kv: KVNamespace): Promise<StoredPrivateJwk | null> {
  const raw = await kv.get(OIDC_PRIVKEY_KV_KEY)
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as StoredPrivateJwk
    return j && typeof j.n === "string" && typeof j.e === "string" && typeof j.kid === "string" ? j : null
  } catch {
    return null
  }
}

/**
 * Import the private JWK (NON-extractable, sign-only) + derive the public JWK from
 * its n/e. Importing non-extractable means the resulting CryptoKey can never be
 * exported back out — the private material exists only inside KV (at rest) and the
 * opaque key handle (in memory).
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

/** Test-only: reset the module-global signing-key cache + single-flight slot. */
export function __resetSigningKeyCacheForTests(): void {
  cached = null
  pending = null
}
