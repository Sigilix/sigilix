// Shared credential / secret NAME matcher — the FP-safety gate for the
// deterministic security floors that key off a binding's NAME (CWE-338 weak
// randomness, CWE-798 hardcoded secret). Extracted from no-insecure-random-token
// so every name-gated floor shares ONE curated, tested matcher: a silent
// divergence between two copies of a security FP gate is itself a hazard.
//
// The contract: fire ONLY when a normalized (lowercased, non-alphanumeric-
// stripped) name reads unambiguously like a credential, so `api_key`/`apiKey`/
// `reset_token`/`WEBHOOK_SECRET` all match while generic `key`/`id`/`index`/
// `nextToken`/`seaSalt` do NOT. The name is the whole signal — keep it tight.

// STRONG, low-ambiguity credential suffixes — a name ending in one is always a
// secret (`clientSecret`, `apiKey`, `resetPassword`, `csrfNonce`, `sessionId`).
const STRONG_CREDENTIAL_SUFFIX_RE =
  /(?:secret|password|passwd|pwd|apikey|privatekey|accesskey|csrf|otp|nonce|verificationcode|sessionid)$/
// "token" is AMBIGUOUS — a credential (`authToken`, `resetToken`) OR a non-secret
// cursor (`nextToken`, `cancelToken`, `pageToken`). Treat `…token` as a secret
// UNLESS prefixed by a known non-secret qualifier (parser/stream/cancel/paging).
const NON_SECRET_TOKEN_PREFIX_RE =
  /(?:cancel|cancellation|next|prev|previous|peek|match|page|continuation|pagination|stream|parse|lex|scan|sync|abort|design|css)$/
// "salt" is AMBIGUOUS — a crypto salt vs chemistry/culinary words that merely
// END in "salt" (`basalt`, `seaSalt`, `rockSalt`). Match only the crypto sense.
const CRYPTO_SALT_RE = /(?:password|passwd|pw|hash|crypto|bcrypt|scrypt|pbkdf2|auth)salt$/

/** Does a normalized identifier name a credential / secret? (CWE-338/CWE-798 sink.) */
export function isCredentialName(name: string | null | undefined): boolean {
  if (!name) return false
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (STRONG_CREDENTIAL_SUFFIX_RE.test(n)) return true
  // …token: secret unless qualified by a non-secret cursor/paging/cancel prefix.
  if (n.endsWith("token")) {
    return !NON_SECRET_TOKEN_PREFIX_RE.test(n.slice(0, -"token".length))
  }
  // …salt: only the crypto sense, or the bare word `salt`.
  if (n === "salt" || CRYPTO_SALT_RE.test(n)) return true
  return false
}
