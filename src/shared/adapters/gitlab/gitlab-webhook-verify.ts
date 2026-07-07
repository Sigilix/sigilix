// GitLab webhook verification.
//
// Unlike GitHub (which HMAC-SHA256-signs the raw body and sends
// `sha256=<hex>` in `X-Hub-Signature-256`), GitLab sends the shared secret
// VERBATIM as a plaintext `X-Gitlab-Token` header. There is no signature to
// recompute — the check is a constant-time string equality between the header
// value and the configured secret.
//
// Kept separate from the GitHub verifier (github-webhook-verify.ts) so the two
// providers' header conventions never bleed into each other.
//
// Constant-time: length is compared first, then every character is XOR-folded
// into a single accumulator so the loop time does not depend on WHERE the first
// mismatch is. Empty inputs (unset secret / missing header) fail closed.

export function verifyGitLabWebhook(headerToken: string, secret: string): boolean {
  if (!headerToken || !secret) return false
  return timingSafeEqual(headerToken, secret)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
