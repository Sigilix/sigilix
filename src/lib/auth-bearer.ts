// SIG-119: shared-secret bearer auth for machine-to-machine endpoints
// (the dogwatch curling /metrics/validation). Distinct from the browser
// session auth in auth-middleware.ts.
//
// #155 onboarding-backend FOUNDATION (slice 1 of 2): `extractBearerToken` and
// `sha256Hex` are exported so api-key-resolver.ts can reuse the exact same
// header-parsing and digest logic — one definition for "what counts as a
// presented bearer token" and "how a token is hashed", no drift between the
// shared-secret path and the per-installation api_key path.

/**
 * Validate an `Authorization: Bearer <token>` header against `expectedToken`
 * using a constant-time comparison (SHA-256 digests of equal length, compared
 * with no early exit) so a wrong token can't be discovered byte-by-byte via
 * response timing.
 *
 * Returns false when the header is missing, not the Bearer scheme, the
 * expected token is empty, or the tokens differ.
 */
export async function requireBearerToken(request: Request, expectedToken: string): Promise<boolean> {
  if (!expectedToken) return false

  const presented = extractBearerToken(request)
  if (!presented) return false

  const [a, b] = await Promise.all([sha256(presented), sha256(expectedToken)])
  return timingSafeEqual(a, b)
}

/**
 * Extract the raw token from an `Authorization: Bearer <token>` header.
 * Returns null when the header is missing, malformed, or not the Bearer
 * scheme. Case-insensitive on the scheme keyword.
 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return new Uint8Array(digest)
}

/** SHA-256 digest of `value`, as a lowercase hex string (for D1 `key_hash` columns). */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = await sha256(value)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Constant-time equality over two equal-length byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // SHA-256 outputs are always 32 bytes, so lengths match; the loop never
  // short-circuits on a mismatch.
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
