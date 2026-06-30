-- #155 onboarding-backend FOUNDATION (slice 1 of 2) — account<->installation link
-- table + API key issuance table.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only -- does not touch 0001 or 0002.
--
-- account_tenant: M:N link between a signed-in GitHub user (session.githubUserId,
-- stored as TEXT -- see auth-session.ts's SessionRecord) and a GitHub App
-- installation_id. Written by the GET /setup handler when a user completes the
-- App install flow. No FK to `tenant` (0001): the PR webhook upserts that row
-- asynchronously, so a /setup hit can legitimately land before it exists -- a
-- benign race, not an integrity violation.
CREATE TABLE account_tenant (
  github_user_id   TEXT    NOT NULL,
  installation_id  INTEGER NOT NULL,
  role             TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  PRIMARY KEY (github_user_id, installation_id)
);
CREATE INDEX idx_account_tenant_installation ON account_tenant(installation_id);

-- api_key: per-installation API keys. Only the SHA-256 hash of the plaintext key
-- is ever persisted (key_hash) -- the plaintext is generated, returned to the
-- caller exactly once, and never stored or logged. revoked_at NULL = live key;
-- resolveApiKey (api-key-resolver.ts) filters `revoked_at IS NULL` on lookup.
CREATE TABLE api_key (
  id               TEXT    PRIMARY KEY,
  key_hash         TEXT    NOT NULL UNIQUE,
  installation_id  INTEGER NOT NULL,
  created_by       TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  last_used_at     TEXT,
  revoked_at       TEXT
);
CREATE INDEX idx_api_key_installation ON api_key(installation_id);
