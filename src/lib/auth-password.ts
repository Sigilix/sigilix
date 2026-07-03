// Email/password credential hashing (launch P0 — sig-user-identity).
//
// AUTH-CRITICAL. Never stores, logs, or returns a plaintext password. Only the
// self-describing hash string produced by `hashPassword` is ever persisted (in
// user_credential.password_hash, migrations/0006).
//
// Algorithm choice — PBKDF2-HMAC-SHA256 via WebCrypto:
//   The founder asked for argon2id/bcrypt. Neither runs natively in a
//   Cloudflare Worker (both need a native/WASM module — a heavy new
//   dependency this repo deliberately avoids; `deps` in package.json is
//   intentionally minimal). PBKDF2 is the algorithm Cloudflare's own docs
//   recommend for password hashing on Workers and is available through the
//   platform WebCrypto (crypto.subtle) with zero new dependencies. It is a
//   NIST-approved KDF; at 210,000 SHA-256 iterations it meets the OWASP 2023
//   password-storage floor.
//
//   The stored hash is a PHC-style string that RECORDS its own work factor:
//     pbkdf2-sha256$<iterations>$<saltB64url>$<hashB64url>
//   so `needsRehash` can detect an out-of-date factor and the login path can
//   transparently upgrade the stored hash. If we later add argon2id (via a
//   WASM lib), it slots in as a new `argon2id$...` prefix and old PBKDF2 hashes
//   upgrade on next login — no migration needed. See the identity report for
//   the exact upgrade steps.

import { base64urlDecode, base64urlEncode } from "@/src/lib/auth-session"

const ALGO_PREFIX = "pbkdf2-sha256"
// OWASP 2023 floor for PBKDF2-HMAC-SHA256. Bump this constant to raise the work
// factor; old hashes then report `needsRehash === true` and upgrade on login.
const DEFAULT_ITERATIONS = 210_000
const SALT_BYTES = 16
const KEY_BITS = 256 // 32-byte derived key

/**
 * Minimum acceptable password. Kept deliberately simple (length-only) — length
 * is the dominant strength factor and a composition-rule gauntlet mostly annoys
 * users. The portal shows a strength hint; this is the server-side floor.
 */
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 256 // guard against DoS-via-huge-input to the KDF

export function isAcceptablePassword(password: string): boolean {
  return (
    typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH
  )
}

async function deriveBits(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(password)
  const material = new Uint8Array(new ArrayBuffer(enc.length))
  material.set(enc)
  const keyMaterial = await crypto.subtle.importKey("raw", material, { name: "PBKDF2" }, false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

/**
 * Hash a plaintext password into a self-describing PHC-style string. A fresh
 * random salt is generated per call, so the same password hashes differently
 * every time. The plaintext is never returned or logged.
 */
export async function hashPassword(password: string, iterations: number = DEFAULT_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)))
  const hash = await deriveBits(password, salt, iterations)
  return `${ALGO_PREFIX}$${iterations}$${base64urlEncode(salt)}$${base64urlEncode(hash)}`
}

/**
 * Constant-time verify of `password` against a stored PHC hash. Returns false
 * (never throws) on any malformed/unknown hash so a corrupt row can't crash the
 * login path — it just fails closed (denies). Re-derives with the SAME salt +
 * iterations recorded in the stored string, then compares in constant time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$")
    if (parts.length !== 4) return false
    const [algo, iterStr, saltB64, hashB64] = parts
    if (algo !== ALGO_PREFIX) return false
    const iterations = Number(iterStr)
    if (!Number.isSafeInteger(iterations) || iterations < 1) return false
    const salt = base64urlDecode(saltB64!)
    const expected = base64urlDecode(hashB64!)
    const actual = await deriveBits(password, salt, iterations)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** True when a stored hash was produced with fewer iterations than the current default. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$")
  if (parts.length !== 4 || parts[0] !== ALGO_PREFIX) return true
  const iterations = Number(parts[1])
  return !Number.isSafeInteger(iterations) || iterations < DEFAULT_ITERATIONS
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
