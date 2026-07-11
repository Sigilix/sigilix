-- SIG-561: installation-scoped, default-off governance for the static skill catalog.
-- Instructions and third-party content are compiled into the Worker; D1 stores
-- policy only, never package code, secrets, OAuth tokens, or customer prompts.
CREATE TABLE org_skill_policy (
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('installed', 'revoked')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  surfaces TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  installed_at_ms INTEGER NOT NULL CHECK (installed_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= 0),
  PRIMARY KEY (installation_id, skill_id)
);

CREATE INDEX idx_org_skill_policy_runtime
  ON org_skill_policy (installation_id, status, enabled, skill_id);
