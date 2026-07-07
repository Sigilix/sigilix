// SIG-41 (Stripe paid tier): PURE parsing + comparison helpers for Stripe's
// webhook signature scheme. Stripe signs `${timestamp}.${rawBody}` with
// HMAC-SHA256 using the endpoint's signing secret and sends the result in the
// `Stripe-Signature` header as `t=<unix>,v1=<hex>[,v1=<hex>...]` (a secret
// rotation window can carry multiple v1 signatures). The async HMAC itself
// lives in the adapter (verify-stripe-signature.ts) because it needs Web
// Crypto; everything provable without IO lives here so it is unit-testable in
// isolation.
//
// Reference: https://stripe.com/docs/webhooks#verify-manually

/** The default replay-tolerance window: reject a timestamp older/newer than this. */
export const DEFAULT_STRIPE_TOLERANCE_SECONDS = 300

/** Parsed `Stripe-Signature` header: the signed unix timestamp + every v1 hex digest. */
export interface ParsedStripeSignature {
  timestamp: number
  v1: string[]
}

/**
 * Parse a `Stripe-Signature` header (`t=...,v1=...,v1=...`). Returns null when the
 * header is missing, malformed, has no integer `t`, or carries no `v1` digest — every
 * one of which the caller treats as an invalid signature (never processed).
 */
export function parseStripeSignatureHeader(header: string | null | undefined): ParsedStripeSignature | null {
  if (!header) return null
  let timestamp: number | null = null
  const v1: string[] = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t") {
      // Strict integer only — Number.parseInt would accept trailing garbage.
      if (/^\d+$/.test(value)) timestamp = Number.parseInt(value, 10)
    } else if (key === "v1" && value.length > 0) {
      v1.push(value.toLowerCase())
    }
  }
  if (timestamp === null || v1.length === 0) return null
  return { timestamp, v1 }
}

/** The exact byte string Stripe signs: `${timestamp}.${rawBody}`. */
export function stripeSignedPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`
}

/**
 * Constant-time hex-string comparison. Length-mismatch short-circuits (hex digests of
 * the same hash are always equal length; a length diff is never a valid match), then
 * every remaining char is XOR-accumulated so the loop can't leak via early exit.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * True when `timestamp` is within `toleranceSeconds` of `nowSeconds` in EITHER
 * direction (an old replay OR a clock-skewed future timestamp). Guards against replay
 * of a captured-but-valid signature.
 */
export function isWithinTolerance(timestamp: number, nowSeconds: number, toleranceSeconds: number): boolean {
  return Math.abs(nowSeconds - timestamp) <= toleranceSeconds
}
