-- sig-user-identity — the persistent USER IDENTITY layer (launch P0).
--
-- Forward-only; immutable once applied (COMPLIANCE.md §8). Applied via
-- `wrangler d1 migrations apply <db>` — NOT auto on deploy. Additive only:
-- does not touch 0001-0005. Runs AFTER 0005 (user_profile, applied in prod).
--
-- Before this, a login persisted nothing real about a person — only the
-- GitHub link in account_tenant (github_user_id <-> installation). This adds
-- a real, provider-agnostic user record: email, name, avatar, which login
-- providers are linked, and MFA-ready columns.
--
-- user_identity: one row per human. Keyed by a surrogate `user_id` (UUID) so a
-- single person can link MULTIPLE providers (GitHub + Google + email/password)
-- to ONE account. `github_user_id` is kept as a UNIQUE nullable column so the
-- existing account_tenant / api_key keying (github_user_id) still joins here.
-- Account-linking-by-email is enforced by the UNIQUE index on `email`.
CREATE TABLE user_identity (
  user_id         TEXT    PRIMARY KEY,          -- surrogate UUID; stable across provider links
  github_user_id  TEXT,                          -- GitHub numeric id as TEXT (aligns w/ account_tenant); NULL for google/password-only
  google_sub      TEXT,                          -- Google OIDC `sub`; NULL until a Google login links
  email           TEXT,                          -- normalized lowercase; NULL until captured (GitHub email can be private)
  email_verified  INTEGER NOT NULL DEFAULT 0,    -- 0/1; set 1 by a verified provider (Google) or the phase-1 verify flow
  name            TEXT,
  avatar_url      TEXT,
  providers       TEXT    NOT NULL DEFAULT '[]', -- JSON array of linked providers: ["github","google","password"]
  -- MFA-ready columns (phase 1 — enrollment/enforcement NOT shipped yet; see auth-mfa-routes.ts).
  mfa_enabled     INTEGER NOT NULL DEFAULT 0,    -- 0/1; org-admin policy may require it (phase 1)
  mfa_secret      TEXT,                          -- base32 TOTP secret; NULL until enrolled (phase 1)
  created_at      TEXT    NOT NULL,
  last_login_at   TEXT    NOT NULL
);

-- Case-normalized email is the account-linking key: a GitHub, Google, and
-- email/password login that share an email resolve to ONE row. Partial (only
-- when email is set) so multiple email-less rows can coexist.
CREATE UNIQUE INDEX idx_user_identity_email  ON user_identity(email)          WHERE email IS NOT NULL;
CREATE UNIQUE INDEX idx_user_identity_github ON user_identity(github_user_id) WHERE github_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_user_identity_google ON user_identity(google_sub)     WHERE google_sub IS NOT NULL;

-- user_credential: email/password sign-in secret. ONE row per password-enabled
-- user. Only a slow salted hash is ever stored (auth-password.ts) — never the
-- plaintext password, never a reversible form. `password_hash` is the
-- self-describing PHC-style string `pbkdf2-sha256$<iterations>$<salt>$<hash>`,
-- so the work factor can be raised later and re-hashed transparently on login.
CREATE TABLE user_credential (
  user_id        TEXT    PRIMARY KEY,  -- 1:1 with user_identity.user_id
  password_hash  TEXT    NOT NULL,     -- pbkdf2-sha256$<iter>$<saltB64url>$<hashB64url>
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
