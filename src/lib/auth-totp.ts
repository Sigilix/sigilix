// TOTP (RFC 6238) primitives for org-wide MFA — sig-user-identity PHASE 1.
//
// This is the pure, tested crypto core (secret generation, otpauth URI, code
// verification with a ±1 step skew window). It is COMPLETE and safe to call,
// but MFA is NOT yet enforced anywhere: the enrollment/verify ENDPOINTS
// (auth-mfa-routes.ts) are stubbed behind SIGILIX_MFA_MODE and the login path
// does not yet challenge for a code. See the identity report ("MFA — remaining
// work") for the exact wiring that stays before this ships.
//
// HMAC-SHA1 is intentional — it is the RFC 6238 default that every authenticator
// app (Google Authenticator, 1Password, Authy) implements. It is used here only
// as the TOTP MAC, never for password/token hashing.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const DEFAULT_DIGITS = 6
const DEFAULT_PERIOD = 30

/** Generate a random base32 TOTP secret (default 160-bit / 32 chars, RFC 4226 recommended). */
export function generateTotpSecret(bytes = 20): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return base32Encode(raw)
}

/** Build the `otpauth://totp/...` URI an authenticator app scans as a QR code. */
export function buildOtpAuthUri(args: { secret: string; account: string; issuer?: string }): string {
  const issuer = args.issuer ?? "Sigilix"
  const label = encodeURIComponent(`${issuer}:${args.account}`)
  const params = new URLSearchParams({
    secret: args.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Verify a user-supplied TOTP `code` against `secret`, accepting the current
 * 30s step plus one step either side (±30s clock skew). Constant-time compare
 * per candidate. Returns false on any malformed input (never throws).
 */
export async function verifyTotp(
  secret: string,
  code: string,
  opts: { period?: number; digits?: number; window?: number; atMs?: number } = {},
): Promise<boolean> {
  const period = opts.period ?? DEFAULT_PERIOD
  const digits = opts.digits ?? DEFAULT_DIGITS
  const window = opts.window ?? 1
  const now = opts.atMs ?? Date.now()
  const normalized = code.replace(/\s/g, "")
  if (!/^\d+$/.test(normalized)) return false

  const counter = Math.floor(now / 1000 / period)
  const key = base32Decode(secret)
  if (!key) return false

  for (let offset = -window; offset <= window; offset++) {
    const expected = await hotp(key, counter + offset, digits)
    if (timingSafeStrEqual(expected, normalized)) return true
  }
  return false
}

async function hotp(key: Uint8Array, counter: number, digits: number): Promise<string> {
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  const keyBuf = new Uint8Array(new ArrayBuffer(key.length))
  keyBuf.set(key)
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
  const macBuf = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg))
  const offset = macBuf[macBuf.length - 1]! & 0x0f
  const bin =
    ((macBuf[offset]! & 0x7f) << 24) |
    ((macBuf[offset + 1]! & 0xff) << 16) |
    ((macBuf[offset + 2]! & 0xff) << 8) |
    (macBuf[offset + 3]! & 0xff)
  return (bin % 10 ** digits).toString().padStart(digits, "0")
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(input: string): Uint8Array | null {
  const clean = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
