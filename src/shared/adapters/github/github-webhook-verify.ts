// GitHub webhook HMAC verification.
// GitHub signs the raw request body with HMAC-SHA256 using the per-App
// webhook secret, then sends `sha256=<hexdigest>` in the
// `X-Hub-Signature-256` header. We compute the same digest locally and
// compare in constant time.
//
// Reference: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
//
// The Linear verifier in webhook-verify.ts is similar but the header name
// and prefix differ — Linear's `linear-signature` is the raw hex digest
// without `sha256=`. Keep the two paths separate so a future header tweak
// on one provider doesn't accidentally break the other.

const encoder = new TextEncoder()

export async function verifyGitHubWebhook(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  if (!signatureHeader || !secret) return false
  if (!signatureHeader.startsWith("sha256=")) return false
  const provided = signatureHeader.slice("sha256=".length).toLowerCase()
  if (provided.length === 0) return false

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody))
  const expected = bufferToHex(digest)

  return timingSafeEqual(expected, provided)
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
