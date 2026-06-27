// Slack request signature verification.
// Slack signs every inbound request with HMAC-SHA256 of
// "v0:<timestamp>:<rawBody>" using the app signing secret, then sends the
// result as "v0=<hex>" in the X-Slack-Signature header and the Unix-second
// timestamp in X-Slack-Request-Timestamp.
//
// Reference: https://api.slack.com/authentication/verifying-requests-from-slack

const encoder = new TextEncoder()

export async function verifySlackSignature(args: {
  rawBody: string
  signature: string | null
  timestamp: string | null
  signingSecret: string
  nowMs: number
}): Promise<boolean> {
  try {
    const { rawBody, signature, timestamp, signingSecret, nowMs } = args

    if (signature === null || timestamp === null) return false

    const ts = Number(timestamp)
    if (Number.isNaN(ts)) return false

    const nowSec = Math.floor(nowMs / 1000)
    if (Math.abs(nowSec - ts) > 300) return false

    const basestring = `v0:${timestamp}:${rawBody}`
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring))
    const hex = bufferToHex(digest)
    const expected = `v0=${hex}`

    return timingSafeEqual(expected, signature.toLowerCase())
  } catch {
    return false
  }
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
