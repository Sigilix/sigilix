// SIG-119: shared-secret bearer auth for machine-to-machine endpoints
// (the dogwatch curling /metrics/validation). Distinct from the browser
// session auth in auth-middleware.ts.

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

  const header = request.headers.get("authorization")
  if (!header) return false

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const presented = match?.[1]
  if (!presented) return false

  const [a, b] = await Promise.all([sha256(presented), sha256(expectedToken)])
  return timingSafeEqual(a, b)
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return new Uint8Array(digest)
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
