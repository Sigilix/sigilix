// SIG-41: async Stripe webhook signature verification for the Workers runtime.
//
// We deliberately do NOT use the Node `stripe` SDK's `constructEvent`, which is
// synchronous and needs Node's `crypto`. Cloudflare Workers only expose Web Crypto
// (`crypto.subtle`), whose HMAC is async — so we re-implement Stripe's documented
// scheme: HMAC-SHA256 over `${t}.${rawBody}`, constant-time compared against each
// `v1` digest in the header, with a replay-tolerance window on `t`.
//
// Reference: https://stripe.com/docs/webhooks#verify-manually

import {
  DEFAULT_STRIPE_TOLERANCE_SECONDS,
  isWithinTolerance,
  parseStripeSignatureHeader,
  stripeSignedPayload,
  timingSafeEqualHex,
} from "@/src/features/billing/domain/stripe-signature"

const encoder = new TextEncoder()

export interface VerifyStripeArgs {
  rawBody: string
  /** The raw `Stripe-Signature` header value. */
  signatureHeader: string | null | undefined
  secret: string
  /** Replay window; defaults to 300s. */
  toleranceSeconds?: number
  /** Injected for deterministic tests; defaults to the real clock (unix seconds). */
  nowSeconds?: number
}

/**
 * Verify a Stripe webhook signature. Returns false (never throws) for a missing/empty
 * secret, an unparseable header, an out-of-tolerance timestamp, or when no `v1` digest
 * matches. A true result proves the body was signed by the holder of `secret` recently.
 */
export async function verifyStripeSignature(args: VerifyStripeArgs): Promise<boolean> {
  const { rawBody, signatureHeader, secret } = args
  if (!secret) return false
  const parsed = parseStripeSignatureHeader(signatureHeader)
  if (!parsed) return false

  const tolerance = args.toleranceSeconds ?? DEFAULT_STRIPE_TOLERANCE_SECONDS
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!isWithinTolerance(parsed.timestamp, nowSeconds, tolerance)) return false

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(stripeSignedPayload(parsed.timestamp, rawBody)))
  const expected = bufferToHex(digest)

  // A rotation window can present multiple v1 digests; accept if ANY matches.
  for (const provided of parsed.v1) {
    if (timingSafeEqualHex(expected, provided)) return true
  }
  return false
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
