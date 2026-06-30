// Linear webhook HMAC verification.
// Linear signs the raw request body with HMAC-SHA256 using the per-app
// signing secret, then sends the hex digest in the `linear-signature`
// header. We compute the same digest locally and compare in constant time.
//
// Reference: https://linear.app/developers/webhooks#securing-webhooks

const encoder = new TextEncoder()

export async function verifyLinearWebhook(
  rawBody: string,
  signature: string,
  secret: string,
  agentSecret?: string,
): Promise<boolean> {
  if (!signature) return false

  // SIG-144 cutover: accept a body signed by EITHER the legacy triage app's secret
  // (primary) OR the agent app's secret. Each comparison is constant-time; when
  // agentSecret is undefined this is byte-identical to the legacy single-secret check.
  if (await verifyOne(rawBody, signature, secret)) return true
  if (agentSecret && (await verifyOne(rawBody, signature, agentSecret))) return true
  return false
}

async function verifyOne(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!secret) return false

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody))
  const expected = bufferToHex(digest)

  return timingSafeEqual(expected, signature.toLowerCase())
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
