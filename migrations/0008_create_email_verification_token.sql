-- sig-email-verification — single-use email-verification tokens (launch).
--
-- Forward-only; immutable once applied (COMPLIANCE.md §8). Applied via
-- `wrangler d1 migrations apply <db>` — NOT auto on deploy. Additive only:
-- does not touch 0001-0007. Runs AFTER 0006 (user_identity) + 0007.
--
-- One row per issued verify link. A token is minted on email/password signup
-- (and on an explicit resend) and is consumed exactly once by GET /auth/verify.
-- We store ONLY a SHA-256 hex of the opaque token — never the raw secret that
-- travels in the email link — so a DB read cannot forge a live verification
-- (parallels auth-rate-limit / api-key hashing).
--
-- Single-use is enforced atomically at consume time by
--   UPDATE ... SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
-- and asserting exactly one row changed — there is no read-then-delete race.
--
-- `email` is captured at mint time and re-checked on consume: a token only
-- verifies the address it was minted for, so a stale token cannot stamp a
-- later, different email as verified (that address would be a cross-provider
-- linking target — see user-identity-store.ts).
CREATE TABLE email_verification_token (
  token_hash  TEXT    PRIMARY KEY,          -- sha256 hex of the opaque token; raw token never stored
  user_id     TEXT    NOT NULL,             -- user_identity.user_id this token verifies
  email       TEXT    NOT NULL,             -- normalized lowercase email being verified (bound at mint)
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,             -- ISO8601; consume requires expires_at > now
  used_at     TEXT                          -- NULL until consumed; set once, single-use
);

-- Reads are by token_hash (PK) at consume. This index supports invalidating a
-- user's outstanding tokens when a fresh one is issued (resend) and any prune.
CREATE INDEX idx_email_verification_token_user ON email_verification_token(user_id);
