-- SIG-343 PR C — platform store: tenant registry + repo registry + usage ledger.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply` (NOT auto on deploy).
CREATE TABLE tenant (
  installation_id  INTEGER PRIMARY KEY,
  tier             TEXT    NOT NULL DEFAULT 'default',
  concurrency_cap  INTEGER,
  daily_budget     INTEGER,
  account_login    TEXT,
  account_type     TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE TABLE repo (
  repo_id          INTEGER PRIMARY KEY,
  installation_id  INTEGER NOT NULL REFERENCES tenant(installation_id),
  full_name        TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX idx_repo_installation ON repo(installation_id);
CREATE TABLE usage_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id  INTEGER NOT NULL,
  repo_id          INTEGER NOT NULL,
  pr_number        INTEGER NOT NULL,
  head_sha         TEXT    NOT NULL,
  model_calls      INTEGER NOT NULL,
  tokens           INTEGER NOT NULL,
  author_login     TEXT,
  created_at       TEXT    NOT NULL,
  UNIQUE(installation_id, repo_id, pr_number, head_sha)
);
CREATE INDEX idx_usage_tenant_time ON usage_ledger(installation_id, created_at);
