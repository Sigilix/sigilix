# Phase 5 — Worker user-OAuth + session (spec v2 LOCKED)

**Status:** LOCKED 2026-05-05 after dual-sign-off + integration of all catches.

| Reviewer | Round | Verdict | Catches integrated in v2 |
|---|---|---|---|
| Codex | r1 | **do not ship** | (1) AAD binding on AES-GCM, (2) browser-bound state cookie, (3) KV eventual-consistency caveat documented, (4) redirectAfter URL-parse instead of regex, (5) tests for all of the above |
| Kimi K2.6 | r1 | ship with 4 tweaks | (6) `/welcome` → `/auth/welcome`, (7) `SIGILIX_BASE_URL` → `OPENCLAW_BASE_URL`, (8) KV prefixes use underscores (`auth_session:`, `auth_event:`), (9) GitHub scope adds `user:email` |

v1 lives at `arc-phase5-auth-spec-v1.md` for audit. **This document is the source of truth for implementation.**

---

## Routes (final)

| Method | Path | Behavior |
|---|---|---|
| GET | `/auth/github` | Mint state nonce. Write to KV (`auth_state:<nonce>` TTL 10m) + set browser-bound state cookie `__Host-sigilix_oauth_state` (HttpOnly, Secure, SameSite=Lax, Max-Age=600). 302 to GitHub authorize URL with `state=<nonce>`. |
| GET | `/auth/github/callback` | Validate (state in KV) AND (state matches state cookie value). Read-then-delete KV nonce. Clear state cookie. Exchange `code` for token. Fetch `GET /user` for profile. Encrypt token with AES-GCM + AAD=sessionId. Create session in KV. Set session cookie. 302 to `/auth/welcome` (or `redirectAfter` if validated). |
| GET | `/auth/welcome` | Read session cookie. If valid, render minimal HTML (login + installation link + logout button). If invalid, 302 to `/`. |
| POST | `/auth/logout` | Delete KV session record. Clear session cookie. 302 to `/`. |
| GET | `/auth/me` | JSON `{ login, githubUserId }`. **Drops `githubInstallations` from v1** (Kimi pre-ship check) — adding it requires verifying the user OAuth scope grants installation visibility. Defer to a follow-up after pre-ship check passes. |
| GET | `/auth/google`, `/auth/email`, `/auth/gitlab`, `/auth/bitbucket`, `/auth/azure` | 501 Not Implemented stubs |

---

## Storage (final)

KV namespace: `OPENCLAW_STATE` (existing).

| Key prefix | Value | TTL |
|---|---|---|
| `auth_state:<nonce>` | `{ createdAt, redirectAfter? }` | 600s |
| `auth_session:<sessionId>` | `{ login, githubUserId, encryptedAccessToken, iv, createdAt, lastSeenAt }` | 30 days, sliding |
| `auth_event:<timestamp>:<sessionIdOrEmpty>` | `AuthEvent` (see Telemetry below) | 24h |

---

## Browser-bound OAuth state (Codex blocker #2)

The state nonce alone proves only that *Sigilix* minted it — it doesn't prove the same browser that started auth is the one that completed it. Without browser binding, an attacker can:

1. Start OAuth in their own session → receive `state_attacker`
2. Stop before the callback
3. Phish a victim into visiting `https://app.sigilix.ai/auth/github/callback?code=ATTACKER_CODE&state=state_attacker`
4. Sigilix accepts the callback, exchanges the attacker's code, creates a Sigilix session in the **victim's browser** logged in as the **attacker's GitHub account**
5. Victim's browser now writes data into the attacker's account

Defense (final):

```
GET /auth/github
  nonce = base64url(crypto.getRandomValues(16))
  await KV.put(`auth_state:${nonce}`, {createdAt, redirectAfter}, expirationTtl=600)
  set-cookie: __Host-sigilix_oauth_state=<nonce>; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/
  302 to GitHub authorize?state=<nonce>...

GET /auth/github/callback?code=...&state=...
  cookieNonce = parse __Host-sigilix_oauth_state from request
  if (!cookieNonce || cookieNonce !== queryState) → 400 state_mismatch
  kvRecord = await KV.get(`auth_state:${queryState}`)
  if (!kvRecord) → 400 state_invalid (expired or already used)
  await KV.delete(`auth_state:${queryState}`)   ← single-use, best-effort under KV eventual consistency
  clear-cookie __Host-sigilix_oauth_state
  ... exchange code, fetch user, encrypt token (AAD=sessionId), create session ...
```

Both checks together: cookie binds the browser; KV nonce binds the server-side mint. Either one alone is insufficient.

---

## AES-GCM with AAD (Codex blocker #1)

Encrypt the GitHub access token before storing in `auth_session:<sessionId>`:

```ts
async function encryptAccessToken(
  plaintext: string,
  sessionId: string,
  keyB64: string,
): Promise<{ ciphertextB64: string; ivB64: string }> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64urlDecode(keyB64),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))    // 96-bit IV per NIST SP 800-38D
  const aad = new TextEncoder().encode(`auth_session:${sessionId}`)
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext),
  )
  return {
    ciphertextB64: base64urlEncode(new Uint8Array(ct)),
    ivB64: base64urlEncode(iv),
  }
}

async function decryptAccessToken(
  record: { encryptedAccessToken: string; iv: string },
  sessionId: string,
  keyB64: string,
): Promise<string> {
  // ... mirror image, AAD = `auth_session:${sessionId}`
}
```

**Why AAD = `auth_session:<sessionId>`:** binds ciphertext to its KV record. If a faulty migration / bug ever swaps Alice's `encryptedAccessToken` into Bob's session record, decrypt fails with `OperationError` — Bob can't accidentally use Alice's bearer token. Test #2 enforces this.

**IV reuse concern:** AES-GCM is catastrophic on IV reuse with the same key. Per-encryption random 96-bit IVs from `crypto.getRandomValues` give 2^48 encryptions before collision risk reaches 2^-32 (NIST guidance). At our scale (≤millions of sessions/year) this is fine.

**Key rotation:** v1 has none. Documented as risk; users re-login on rotation.

---

## redirectAfter — strict same-origin (Codex blocker #4)

The v1 regex `^/[a-z0-9/_-]*$` matches `//evil.com` — browsers parse `//evil.com` as a scheme-relative URL and follow to `https://evil.com`. Open redirect.

Fix:

```ts
function safeRedirectAfter(raw: string | undefined, baseUrl: string): string {
  const fallback = "/auth/welcome"
  if (!raw) return fallback
  // Reject absolute URLs, scheme-relative URLs, backslashes, anything
  // that isn't a simple in-app path. Parse against baseUrl and require
  // same origin AS A SECOND CHECK.
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("\0")) return fallback
  if (!raw.startsWith("/")) return fallback
  let parsed: URL
  try {
    parsed = new URL(raw, baseUrl)
  } catch {
    return fallback
  }
  if (parsed.origin !== new URL(baseUrl).origin) return fallback
  return parsed.pathname + parsed.search + parsed.hash
}
```

Test #4 covers `//evil.com`, `/%2f%2fevil.com`, `/\\evil.com`, `/path?q=ok`, `/path#fragment`, plain `/welcome`.

---

## Cookie attributes (final)

Both auth cookies use `__Host-` prefix.

| Cookie | Lifetime | Attributes | Purpose |
|---|---|---|---|
| `__Host-sigilix_oauth_state` | 600s | HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=600 | Browser-binds OAuth callback. Cleared on callback. |
| `__Host-sigilix_session` | 30d (sliding) | HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=2592000 | Authenticated session. |

`SameSite=Lax` is correct for both — GitHub's callback is a top-level GET; Lax sends the cookie on top-level navigation; `None` would unnecessarily widen the surface.

---

## OAuth scope (final)

`read:user user:email` — Kimi's catch.

Justification:
- `read:user` reads profile (login, id, name, avatar)
- `user:email` reads the verified email address. Adding now avoids a re-consent later when billing wants the email
- Still minimum viable; we explicitly do NOT request `repo`, `admin:org`, etc. The GitHub *App* (server-to-server JWT) handles repo access on the App's permissions

Codex argued against `user:email` ("don't pre-consent for hypothetical billing"); Kimi argued for it ("avoid future re-consent UX"). Kimi's UX argument wins because we've already locked per-seat billing in the marketing pricing — billing is decided, not hypothetical.

---

## Env vars / secrets (final)

| Name | Type | Source |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | secret | GitHub App's OAuth client_id (same App as the existing GITHUB_APP_ID) |
| `GITHUB_OAUTH_CLIENT_SECRET` | secret | GitHub App's OAuth client_secret |
| `OPENCLAW_SESSION_ENCRYPTION_KEY` | secret | 32 random bytes, base64url. `crypto.getRandomValues(new Uint8Array(32))` then base64url-encode |
| `OPENCLAW_BASE_URL` | env | `https://app.sigilix.ai` for prod; `http://localhost:8787` for local dev. Default to prod if unset. (Kimi: prefix coherence with existing OPENCLAW_*) |

GitHub App's "Callback URL" must include `https://app.sigilix.ai/auth/github/callback`.

---

## KV eventual consistency caveat (Codex blocker #3)

The `auth_state:<nonce>` read-then-delete sequence is best-effort single-use. Cloudflare KV is eventually consistent across regions, with up to ~60s of read-after-write window. In theory two near-simultaneous callbacks could each see the nonce as present and proceed.

Practical impact:
- Same `code` in both: GitHub's one-time code redemption invalidates the second exchange → second callback fails with `code_exchange_failed` after the first succeeds
- Different `code` (attacker-controlled, paired with stolen state): browser-binding cookie blocks this — even if both nonces validate, the browser without the matching state cookie fails the cookie check

So the cookie binding compensates for KV's lack of true single-use semantics. If we need stricter single-use later, migrate `auth_state` to a Durable Object or D1 table (separate spec).

---

## Tests (final)

Add to v1's 16 tests:

17. **AAD binding**: encrypt with `aad = "auth_session:alice"`, decrypt with `aad = "auth_session:bob"` → throws `OperationError`
18. **Cookie-state mismatch**: callback with valid KV state but missing or different `__Host-sigilix_oauth_state` cookie → 400 `state_mismatch` + cleared session cookie
19. **Cookie-state present, KV missing**: 400 `state_invalid` (TTL expired or already-deleted)
20. **redirectAfter open-redirect blockers**: each of `//evil.com`, `/%2f%2fevil.com`, `/\\evil.com`, `https://evil.com`, `javascript:alert(1)`, `\\\\smb`, `/path?q=ok`, `/path#frag`, `/auth/welcome` — only the last 3 pass through; rest fall back to `/auth/welcome`
21. **Concurrent same-state callbacks**: simulate two callback Promises both reading same nonce; one wins (KV mocked to return value once then null) — second fails `state_invalid`
22. **`/auth/me` returns 401 without session, returns 200 with session, omits `githubInstallations` in v1**

Total: 16 (v1) + 6 (v2) = 22 tests.

---

## Files (unchanged from v1)

- `src/lib/auth-oauth-github.ts`
- `src/lib/auth-session.ts`
- `src/lib/auth-welcome.ts`
- `src/lib/auth-middleware.ts`
- `tests/auth-oauth-github.test.ts`
- `tests/auth-session.test.ts`
- `tests/auth-routing.test.ts`
- Modify: `src/index.ts`, `src/lib/env-validate.ts`, `wrangler.toml` (comment block)

---

## Implementation sequencing

1. Branch: `feat/phase5-auth-github-oauth`
2. Add Env interface fields (no runtime changes)
3. Implement `auth-session.ts` (AES-GCM helpers + cookie helpers + KV CRUD)
4. Implement `auth-oauth-github.ts` (kick-off, callback, redirect-validator)
5. Implement `auth-welcome.ts` (HTML render)
6. Implement `auth-middleware.ts` (`requireSession`)
7. Wire 5 routes in `src/index.ts`
8. Add 6 stub 501 routes
9. Add 22 tests
10. Run `npx tsc --noEmit && npm test`
11. Update `wrangler.toml` comment + `env-validate.ts`
12. PR with comprehensive description; CR + admin merge
13. Post-merge: operator manually adds the 4 secrets via `wrangler secret put` + adds the callback URL to the GitHub App settings
