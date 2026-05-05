# Phase 5 — Worker user-OAuth + session (spec v1)

**Status:** v1 draft — needs dual sign-off (Codex + Kimi K2.6) before implementation.

**Trigger:** ARC-163. The marketing CTAs on app.sigilix.ai send users to `/auth/github`, `/auth/google`, `/auth/email`. The Worker has no auth handlers yet; every click 404s. Users hit a dead end.

**Scope:** GitHub OAuth user-to-server flow only in v1. Google + email magic-link are explicitly deferred to v2 / Phase 5.5.

**Out of scope (v1):**
- User dashboard. Post-OAuth lands on a minimal `/welcome` page; the dashboard product is its own future spec.
- Org / team management. v1 captures the user identity only.
- Billing wiring. Stripe handshake is a separate spec.
- Email magic-link. Needs an email provider (Resend / Postmark) — separate decision.
- Google / Azure / Bitbucket / GitLab OAuth. Same OAuth pattern, but each provider adds a security review surface; v1 scope-limited to GitHub.

---

## What v1 delivers

A user can:
1. Click "Continue with GitHub" on `app.sigilix.ai/`
2. See GitHub's OAuth consent screen (App-name `Sigilix`, scopes listed below)
3. Approve → redirect back to `app.sigilix.ai/auth/github/callback?code=...&state=...`
4. Worker exchanges code for a user-to-server access token via `POST https://github.com/login/oauth/access_token`
5. Worker stores a session record in KV keyed by an opaque session ID
6. Worker sets a `__Host-sigilix_session` cookie (HttpOnly, Secure, SameSite=Lax)
7. Worker 302s to `/welcome` which renders a minimal authenticated page with the user's GitHub login + a "Manage installations" link to `https://github.com/settings/installations`

A second visit:
- `/welcome` reads the session cookie, looks up the KV record, renders the same page
- Cookie expires server-side after 30 days; client-side cookie has matching `Max-Age`

A signout:
- `POST /auth/logout` deletes the KV record and clears the cookie

---

## Routes (v1)

| Method | Path | Behavior |
|---|---|---|
| GET | `/auth/github` | Mint a CSRF state token, store nonce in KV (`oauth_state:<nonce>` TTL 10m), 302 to `https://github.com/login/oauth/authorize?client_id=$ID&state=$NONCE&scope=read:user&redirect_uri=https://app.sigilix.ai/auth/github/callback` |
| GET | `/auth/github/callback` | Validate `state` against KV nonce (single-use, deleted after read). Exchange `code` for token. Fetch `GET /user` from GitHub for login + id. Create session in KV. Set cookie. 302 to `/welcome` |
| GET | `/welcome` | Read session cookie. If valid, render minimal HTML (user login, installation link, logout button). If invalid, 302 to `/` |
| POST | `/auth/logout` | Delete KV session, clear cookie, 302 to `/` |
| GET | `/auth/me` | JSON `{ login, id, githubInstallations }` for the marketing site or a future dashboard's bootstrap fetch. Same cookie auth as `/welcome` |

Out-of-band:
- `/auth/google`, `/auth/email`, `/auth/gitlab`, `/auth/bitbucket`, `/auth/azure` return **501 Not Implemented** with a plain-text body pointing back to `/`. Marketing site already labels those buttons "Soon" — this matches.

---

## Storage

**KV namespace:** existing `OPENCLAW_STATE` (id `df689379ea6240f7808997a75ceaed7e` per `wrangler.toml`).

| Key prefix | Value | TTL |
|---|---|---|
| `oauth_state:<nonce>` | `{ createdAt, redirectAfter? }` | 600s (10 min) |
| `session:<sessionId>` | `{ login, githubUserId, accessToken (encrypted), createdAt, lastSeenAt }` | 30 days, sliding (refresh on `lastSeenAt` update) |

**Session ID format:** 32-byte CSPRNG random → base64url. Opaque to the user; never put login/email in the cookie itself.

**Access token encryption:** the GitHub user-to-server access token is a bearer credential. Encrypt at rest via AES-GCM with a key derived from a new secret `OPENCLAW_SESSION_ENCRYPTION_KEY` (32-byte random, set via `wrangler secret put`). The Worker never logs the plaintext.

**Nonce format:** 16-byte CSPRNG random → base64url. Single-use. Read-then-delete from KV in the callback (atomic-ish — KV doesn't have CAS, but the race window is small and consequence is just one rejected callback).

---

## CSRF + state token

GitHub's OAuth `state` parameter is the standard CSRF defense. v1 uses **server-side nonce-in-KV** rather than a signed-cookie state:

- KV stores the nonce + creation time + optional `redirectAfter` (where the marketing site wanted to land the user after auth, e.g. `/welcome` or a future deep link)
- The kick-off route writes the nonce; the callback reads-and-deletes it
- A stolen state value in a phishing email can't be reused — the KV entry is gone after first callback
- A re-submitted (refreshed) callback URL fails because the nonce is gone — surfaces as `state_invalid`

**Why not signed-cookie state:** simpler to reason about (KV is single source of truth), no JWT verification surface, no clock drift on cookie expiry. KV cost per auth = 1 PUT + 1 GET + 1 DELETE = trivial.

---

## Cookie

Name: `__Host-sigilix_session`

Reasons for `__Host-` prefix:
- Browser enforces `Secure`, no `Domain`, `Path=/` — strictest cookie semantics. Phishing subdomain (e.g. `evil.app.sigilix.ai`) cannot set or read it.

Attributes:
- `HttpOnly` — JS cannot read; only the Worker
- `Secure` — HTTPS only
- `SameSite=Lax` — sent on top-level navigation (needed because GitHub callback is a top-level GET); blocks CSRF on cross-site POSTs
- `Max-Age=2592000` (30 days)
- `Path=/`

Value: the session ID (random base64url). Never the access token, never the user identity.

---

## GitHub OAuth scope

`read:user` only in v1.

Justification:
- Read the authenticated user's profile (login, id, name, avatar) — sufficient for the welcome page
- We do NOT need `repo` for the user OAuth flow because Sigilix accesses repos via the GitHub *App* (server-to-server JWT auth), not user OAuth
- We do NOT need `admin:org`, `repo:write`, etc.
- Keeping the scope minimal reduces our attack surface if the access token is ever leaked

---

## Threat model

| Attack | Defense |
|---|---|
| **CSRF on auth callback** | `state` nonce required + single-use + 10m TTL |
| **Session fixation** | Session ID is server-minted CSPRNG; no client influence |
| **Cookie theft via XSS** | `HttpOnly` cookie cannot be read from JS; CSP locks down JS sources |
| **Cookie theft via subdomain hijack** | `__Host-` prefix ensures no `Domain` attribute; sibling subdomains can't set or read |
| **Replay of access token** | Token is encrypted at rest in KV; cookie carries only opaque session ID |
| **OAuth code interception** | Code expires in 10 minutes (GitHub's policy); we additionally require state match. Plus TLS-everywhere on app.sigilix.ai |
| **Open redirect on `redirectAfter`** | `redirectAfter` from KV must match `^/[a-z0-9/_-]*$` regex; never accept absolute URLs |
| **Token exfil via logging** | Access tokens are never logged. Worker logs only the session ID and userId |
| **Malicious GitHub user assumes others' identity** | GitHub's OAuth ensures the access token corresponds to the authenticating user. We trust GitHub's identity assertion |
| **Long-lived session abuse** | 30-day Max-Age + sliding `lastSeenAt`. After 30 days of inactivity the session record is deleted by KV TTL; new login required |

---

## Env vars / secrets (new)

| Name | Type | Source |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | secret | GitHub App's client ID (the existing Sigilix App has one — same App, OAuth + JWT both supported) |
| `GITHUB_OAUTH_CLIENT_SECRET` | secret | GitHub App's client secret. Generate at github.com/settings/apps/sigilix |
| `OPENCLAW_SESSION_ENCRYPTION_KEY` | secret | 32 random bytes, base64url. Used to AES-GCM-encrypt access tokens at rest |
| `SIGILIX_BASE_URL` | env (or hardcoded) | `https://app.sigilix.ai` for prod, `http://localhost:8787` for local dev. The OAuth callback URL needs to match exactly what's registered in the GitHub App settings. Default to the prod URL if unset |

The GitHub App's "Callback URL" must be set to `https://app.sigilix.ai/auth/github/callback` in GitHub App settings. Add this manually as a deploy step (not automatable via API short of a write-scope GitHub App management token).

---

## Files

**New:**
- `src/lib/auth-oauth-github.ts` — kick-off route, callback route, state nonce mgmt, code-for-token exchange
- `src/lib/auth-session.ts` — session create / read / delete, AES-GCM encrypt / decrypt of stored access tokens, cookie parse / set helpers
- `src/lib/auth-welcome.ts` — `/welcome` page renderer (small inline HTML, no framework)
- `src/lib/auth-middleware.ts` — `requireSession(request, env)` helper used by `/welcome`, `/auth/me`, future dashboard routes
- `tests/auth-oauth-github.test.ts` — kick-off + callback unit tests (mock GitHub HTTP)
- `tests/auth-session.test.ts` — encryption round-trip, KV mock, cookie parse / set
- `tests/auth-routing.test.ts` — `/auth/*` route surface, 501 stubs, 404 fallthrough

**Modified:**
- `src/index.ts` — add 5 new routes (`/auth/github`, `/auth/github/callback`, `/welcome`, `/auth/me`, `/auth/logout`) + 4 stub routes returning 501
- `src/index.ts` `Env` interface — add the 4 new env vars
- `wrangler.toml` — document the new secrets in the comment block; no actual config change (secrets are set via `wrangler secret put`)
- `src/lib/env-validate.ts` — assert presence of the new secrets in `strict` validation mode

---

## Telemetry

Each auth event writes one entry to a new KV prefix `auth-event:<timestamp>:<sessionId>`:

```ts
type AuthEvent =
  | { kind: "kickoff"; provider: "github"; ts: number }
  | { kind: "callback_success"; provider: "github"; githubUserId: number; sessionId: string; ts: number }
  | { kind: "callback_failed"; provider: "github"; reason: "state_invalid" | "code_exchange_failed" | "user_fetch_failed"; ts: number }
  | { kind: "logout"; sessionId: string; ts: number }
```

24h TTL on these events. Long-term retention is not needed for v1 (no compliance requirement until SOC 2). Goal: be able to debug auth flows on a live customer call.

**Never logged:** access token (plaintext or ciphertext), state nonce value (only the result), cookie value.

---

## Tests required

1. **Kick-off**: GET `/auth/github` writes a nonce to KV, returns 302 to GitHub with `client_id`, `state` matching the nonce, `redirect_uri`, `scope=read:user`
2. **Callback success**: GitHub returns valid `code` + matching `state` → exchange returns access token → `GET /user` returns profile → KV session created → cookie set → 302 to `/welcome`
3. **Callback rejects bad state**: `state` not in KV → 400 with `state_invalid` + cleared cookie
4. **Callback rejects expired state**: nonce TTL past → 400 with `state_invalid` (KV returns null)
5. **Callback rejects code exchange failure**: GitHub returns 401 on token exchange → 400 with `code_exchange_failed` + cleared cookie + telemetry event
6. **Callback rejects user fetch failure**: GitHub returns 5xx on `GET /user` → 502 with `user_fetch_failed`
7. **Welcome happy path**: valid cookie → reads session → renders HTML with user login
8. **Welcome rejects invalid cookie**: missing or unknown session → 302 to `/`
9. **Welcome rejects expired session**: KV TTL past → 302 to `/` (since KV returns null)
10. **Logout**: POST `/auth/logout` deletes session, clears cookie, 302 to `/`
11. **Encrypt/decrypt round-trip**: any 40-100 byte access token survives encrypt + decrypt with the same key
12. **Encrypt fails on key mismatch**: key change between encrypt and decrypt yields ciphertext-failure (Web Crypto throws)
13. **Open-redirect prevention**: `redirectAfter=https://evil.com` is rejected; `redirectAfter=/welcome` is honored
14. **`/auth/me` returns 401 without session, returns 200 with session**
15. **501 stub routes**: `/auth/google` `/auth/email` `/auth/gitlab` `/auth/bitbucket` `/auth/azure` all return 501 with a plain-text body
16. **Telemetry**: `kickoff`, `callback_success`, `callback_failed`, `logout` events written; verify shape

---

## Risk register

| Risk | Mitigation |
|---|---|
| Encryption key rotation breaks active sessions | v1 has no key rotation. Document that rotating the key invalidates all sessions; users re-login. Acceptable for early-access. |
| GitHub User-to-Server tokens have no expiry by default; if a user is malicious they keep the token forever | We can call `DELETE /applications/:client_id/grant` server-side on logout to actively revoke; v1 documents this as a follow-up |
| Single Cloudflare KV namespace shared between sessions and ensemble telemetry | Different prefixes; no operational concern but worth surfacing for future migration. |
| 30-day cookie window is long for a security-sensitive product | Acceptable trade-off for early-access UX; revisit at SOC 2 prep. |
| `/welcome` HTML inline; no CSP | Add a Content-Security-Policy header `default-src 'self'; script-src 'none'` since the page has no JS. Documented as part of v1 implementation. |
| Worker fetch handler has no rate limit on `/auth/github` kick-off | Cloudflare's WAF can rate-limit by IP. Document a follow-up rule + acceptance criterion: 100 kick-offs / IP / 5 min. Not blocking v1 but tracked. |

---

## Sign-off requested

- **Codex** — algorithm + correctness focus: encryption scheme, state nonce semantics, edge cases in the callback flow, anything in the threat-model table that's underspecified.
- **Kimi K2.6** — design coherence focus: route layout, env-var naming, scope minimization, whether the spec respects v3.1 LOCKED conventions for KV prefixes / telemetry shape.

Lock criterion: both reviewers say "ship" with catches integrated.

Implementation worktree: `.claude/worktrees/phase5-auth`. Branch: `feat/phase5-auth-github-oauth`. Single PR; ~400 LoC net + tests.
