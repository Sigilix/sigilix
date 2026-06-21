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
// SIG-486: `authz` + `bearer` are added — both low-ambiguity (no common non-secret
// compounds; `ringbearer`/`torchbearer` are negligible). `authorization` is NOT here:
// it's ambiguous (see below). `bearer` here also subsumes nothing `…token` already covers.
const STRONG_CREDENTIAL_SUFFIX_RE =
  /(?:secret|password|passwd|pwd|apikey|privatekey|accesskey|csrf|otp|nonce|verificationcode|sessionid|authz|bearer)$/
// "token" is AMBIGUOUS — a credential (`authToken`, `resetToken`) OR a non-secret
// cursor (`nextToken`, `cancelToken`, `pageToken`). Treat `…token` as a secret
// UNLESS prefixed by a known non-secret qualifier (parser/stream/cancel/paging).
const NON_SECRET_TOKEN_PREFIX_RE =
  /(?:cancel|cancellation|next|prev|previous|peek|match|page|continuation|pagination|stream|parse|lex|scan|sync|abort|design|css)$/
// SIG-486: "authorization" is AMBIGUOUS — the HTTP Authorization header value is a
// Bearer/Basic credential (`req.headers.authorization`), but `re/pre/de-authorization`
// are payment-hold / OAuth PROCESS names (an id/status, not the credential). Treat
// `…authorization` as a secret UNLESS prefixed by one of those.
const NON_SECRET_AUTHORIZATION_PREFIX_RE = /(?:re|pre|de)$/
// SIG-486: "cookie"/"cookies" is AMBIGUOUS — the Cookie/Set-Cookie header value + a
// session cookie are secrets (`req.headers.cookie`, `sessionCookie`), but the action /
// CRUD / flag prefixes name a FUNCTION or BOOLEAN, not the value (`parseCookie`,
// `secureCookie`, `hasCookie`). Treat `…cookie(s)` as a secret UNLESS so prefixed.
const NON_SECRET_COOKIE_PREFIX_RE =
  /(?:has|is|use|enable|disable|allow|accept|should|can|with|thirdparty|firstparty|party|no|set|get|read|write|delete|clear|create|remove|parse|serialize|check|validate|test|handle|process|manage|store|save|load|send|receive|block|filter|sanitize|escape|encode|decode|sign|verify|encrypt|decrypt|hash|secure|httponly|samesite|new|old|temp|tmp|default|current|active|valid|expired|initial|original|final|inactive|invalid)$/
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
  // SIG-486 …authorization: the auth-header credential, unless a re/pre/de process name.
  if (n.endsWith("authorization")) {
    return !NON_SECRET_AUTHORIZATION_PREFIX_RE.test(n.slice(0, -"authorization".length))
  }
  // SIG-486 …cookie(s): the cookie header / session value, unless an action/flag prefix.
  if (/cookies?$/.test(n)) {
    const prefix = n.replace(/cookies?$/, "")
    return prefix === "" ? true : !NON_SECRET_COOKIE_PREFIX_RE.test(prefix)
  }
  // …salt: only the crypto sense, or the bare word `salt`.
  if (n === "salt" || CRYPTO_SALT_RE.test(n)) return true
  return false
}
