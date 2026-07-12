-- SIG — Linear cross-repo context. Lets one Linear team ground triage in
-- MULTIPLE GitHub repositories (or every repo in the installation) instead of
-- the single `linear_team_binding.github_repo_id` the SIG-242 model allowed.
--
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Applied with
-- `wrangler d1 migrations apply sigilix-platform` — NOT automatically on deploy.
-- Never edit migration 0016; this migration is additive and back-compatible:
-- the existing single `github_repo_id`/`github_repo_full_name` columns stay the
-- team's PRIMARY binding, and every current single binding is backfilled into
-- the new join table so no live tenant loses its mapping.

-- Per-team "all repositories in the installation" affordance. A flag (not a
-- sentinel repo row) so `github_repo_id > 0` keeps its "valid binding" meaning
-- everywhere and the choice maps 1:1 to a future portal checkbox. When set, the
-- effective repo set is expanded from the installation's `repo` table at read
-- time and any explicit `linear_team_repo` rows are ignored.
ALTER TABLE linear_team_binding
  ADD COLUMN use_all_repos INTEGER NOT NULL DEFAULT 0 CHECK (use_all_repos IN (0, 1));

-- Explicit multi-repo selection: many rows per team, one per chosen repo. The
-- team's PRIMARY repo continues to live on `linear_team_binding`; this table
-- holds the full chosen set (the primary is also stored here for a uniform read).
CREATE TABLE linear_team_repo (
  linear_organization_id TEXT    NOT NULL,
  team_id                TEXT    NOT NULL,
  installation_id        INTEGER NOT NULL,
  github_repo_id         INTEGER NOT NULL CHECK (github_repo_id > 0),
  github_repo_full_name  TEXT    NOT NULL,
  synced_at              TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  PRIMARY KEY (linear_organization_id, team_id, github_repo_id),
  FOREIGN KEY (linear_organization_id, team_id)
    REFERENCES linear_team_binding(linear_organization_id, team_id)
);
CREATE INDEX idx_linear_team_repo_installation
  ON linear_team_repo(installation_id, team_id);
CREATE INDEX idx_linear_team_repo_repo
  ON linear_team_repo(installation_id, lower(github_repo_full_name));

-- Backfill: every existing single binding becomes one explicit repo row so
-- reads are uniform (union of join table + primary) and back-compatible.
INSERT OR IGNORE INTO linear_team_repo
  (linear_organization_id, team_id, installation_id, github_repo_id, github_repo_full_name, synced_at, updated_at)
SELECT linear_organization_id, team_id, installation_id, github_repo_id, github_repo_full_name, synced_at, updated_at
FROM linear_team_binding
WHERE github_repo_id > 0;
