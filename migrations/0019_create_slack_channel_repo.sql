-- SIG — Slack customer self-serve. Links a Slack workspace install to the
-- Sigilix org (GitHub App installation) that initiated it, and lets that org
-- bind Slack channels to its GitHub repositories — the Slack counterpart of
-- the Linear team→repo model (migration 0018 / linear_team_repo). Before this,
-- channel→repo scope lived ONLY in the hardcoded SIGILIX_SLACK_SCOPE_MAP env
-- var, so a customer could install the Slack app but @sigilix stayed silent.
--
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Applied with
-- `wrangler d1 migrations apply sigilix-platform` — NOT automatically on deploy.
-- Back-compatible: resolveSlackScope reads these tables FIRST and falls back to
-- SIGILIX_SLACK_SCOPE_MAP when no row matches, so the founder's env-mapped beta
-- channel keeps working before AND after this migration is applied.

-- One row per installed Slack workspace: which Sigilix org owns the install.
-- The bot token itself stays in KV (slack-install.ts) — this table is the org
-- linkage only, written by the OAuth callback when the install was initiated
-- from the portal (installation id carried through the OAuth `state`).
CREATE TABLE slack_workspace (
  team_id         TEXT    NOT NULL PRIMARY KEY,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  installed_by    TEXT    NOT NULL,
  installed_at    TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_slack_workspace_installation
  ON slack_workspace(installation_id);

-- Per-channel "all repositories in the installation" affordance. A flag (not a
-- sentinel repo row) so `github_repo_id > 0` keeps its "valid binding" meaning
-- everywhere — same shape as linear_team_binding.use_all_repos. When set, the
-- effective repo set is expanded from the installation's `repo` table at read
-- time and any explicit `slack_channel_repo` rows are ignored.
CREATE TABLE slack_channel_binding (
  team_id         TEXT    NOT NULL,
  channel_id      TEXT    NOT NULL,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  use_all_repos   INTEGER NOT NULL DEFAULT 0 CHECK (use_all_repos IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  PRIMARY KEY (team_id, channel_id),
  FOREIGN KEY (team_id) REFERENCES slack_workspace(team_id)
);
CREATE INDEX idx_slack_channel_binding_installation
  ON slack_channel_binding(installation_id);

-- Explicit multi-repo selection: many rows per channel, one per chosen repo —
-- mirrors linear_team_repo exactly.
CREATE TABLE slack_channel_repo (
  team_id               TEXT    NOT NULL,
  channel_id            TEXT    NOT NULL,
  installation_id       INTEGER NOT NULL CHECK (installation_id > 0),
  github_repo_id        INTEGER NOT NULL CHECK (github_repo_id > 0),
  github_repo_full_name TEXT    NOT NULL,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  PRIMARY KEY (team_id, channel_id, github_repo_id),
  FOREIGN KEY (team_id, channel_id)
    REFERENCES slack_channel_binding(team_id, channel_id)
);
CREATE INDEX idx_slack_channel_repo_installation
  ON slack_channel_repo(installation_id, team_id, channel_id);
CREATE INDEX idx_slack_channel_repo_repo
  ON slack_channel_repo(installation_id, lower(github_repo_full_name));
