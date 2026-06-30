-- SIG-38 free-launch caps — Linear-triage usage ledger.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply` (NOT auto on deploy).
--
-- A separate table from `usage_ledger` (0001) rather than a shared row with an
-- action/type discriminator: usage_ledger's identity columns (installation_id
-- INTEGER, repo_id, pr_number, head_sha) are GitHub-PR-shaped and NOT NULL, and
-- its UNIQUE constraint is keyed on those four columns. Linear triage has no
-- PR/repo/head_sha, and its tenant key (a Linear team id) is a UUID string, not
-- a GitHub installation_id integer. A parallel table keeps the PR-review and
-- Linear-triage rolling-window counts fully independent without weakening (or
-- widening to nullable) the existing usage_ledger schema.
CREATE TABLE triage_usage_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT    NOT NULL,
  issue_id   TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE(team_id, issue_id)
);
CREATE INDEX idx_triage_usage_team_time ON triage_usage_ledger(team_id, created_at);
