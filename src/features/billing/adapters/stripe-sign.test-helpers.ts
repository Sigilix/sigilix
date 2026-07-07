// Shared test helper (NOT a *.test.ts so the runner doesn't collect it): produce a
// valid `Stripe-Signature` header for a raw body by round-tripping the SAME crypto the
// verifier uses, so the production verify path is exercised end-to-end.

const encoder = new TextEncoder()

export async function signStripeBody(rawBody: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `t=${timestamp},v1=${hex}`
}
