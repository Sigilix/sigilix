-- SIG-242 — tenant-safe Linear connection registry, immutable team bindings,
-- revisioned settings, and webhook-delivery leases.
--
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Applied with
-- `wrangler d1 migrations apply sigilix-platform` — NOT automatically on deploy.
-- OAuth tokens never live in D1: each active organization owns the broker DO
-- named `linear-org:v1:<linear_organization_id>`.
CREATE TABLE linear_connection (
  installation_id             INTEGER PRIMARY KEY,
  linear_organization_id      TEXT    NOT NULL UNIQUE,
  organization_name           TEXT    NOT NULL,
  app_user_id                 TEXT    NOT NULL UNIQUE,
  status                      TEXT    NOT NULL CHECK (status IN ('active', 'revoked')),
  source                      TEXT    NOT NULL CHECK (source IN ('oauth', 'legacy-migration')),
  granted_scopes_json         TEXT    NOT NULL,
  can_access_all_public_teams INTEGER NOT NULL DEFAULT 0 CHECK (can_access_all_public_teams IN (0, 1)),
  installed_by_user_id        TEXT    NOT NULL,
  installed_by_login          TEXT    NOT NULL,
  installed_at                TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL,
  UNIQUE (installation_id, linear_organization_id)
);

CREATE TABLE linear_team_binding (
  linear_organization_id TEXT    NOT NULL,
  team_id                TEXT    NOT NULL,
  installation_id        INTEGER NOT NULL,
  team_key                TEXT    NOT NULL,
  team_name               TEXT    NOT NULL,
  access_state            TEXT    NOT NULL CHECK (access_state IN ('allowed', 'revoked')),
  selected                INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  github_repo_id          INTEGER NOT NULL,
  github_repo_full_name   TEXT    NOT NULL,
  synced_at               TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  PRIMARY KEY (linear_organization_id, team_id),
  FOREIGN KEY (installation_id, linear_organization_id)
    REFERENCES linear_connection(installation_id, linear_organization_id)
);
CREATE INDEX idx_linear_team_binding_installation
  ON linear_team_binding(installation_id, selected, access_state);
CREATE INDEX idx_linear_team_binding_repo
  ON linear_team_binding(installation_id, lower(github_repo_full_name));

CREATE TABLE linear_config (
  installation_id       INTEGER PRIMARY KEY,
  linear_organization_id TEXT    NOT NULL UNIQUE,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  context_mode          TEXT    NOT NULL DEFAULT 'auto' CHECK (context_mode IN ('auto', 'enabled', 'disabled')),
  scope_mode            TEXT    NOT NULL DEFAULT 'auto' CHECK (scope_mode IN ('auto', 'explicit')),
  pr_validation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pr_validation_enabled IN (0, 1)),
  create_issue_mode     TEXT    NOT NULL DEFAULT 'manual' CHECK (create_issue_mode IN ('manual', 'disabled', 'auto')),
  planning_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (planning_enabled IN (0, 1)),
  writeback_comments    INTEGER NOT NULL DEFAULT 1 CHECK (writeback_comments IN (0, 1)),
  writeback_status      INTEGER NOT NULL DEFAULT 0 CHECK (writeback_status IN (0, 1)),
  writeback_labels      INTEGER NOT NULL DEFAULT 1 CHECK (writeback_labels IN (0, 1)),
  updated_by            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  update_token          TEXT    NOT NULL,
  FOREIGN KEY (installation_id, linear_organization_id)
    REFERENCES linear_connection(installation_id, linear_organization_id)
);

-- Linear retries webhook deliveries. A producer atomically claims the unique
-- delivery id before Queue.send. A failed send releases the short lease; a
-- successful send marks `enqueued`, so every redelivery gets a plain 200 with
-- no second job.
CREATE TABLE linear_delivery_lease (
  delivery_id           TEXT    PRIMARY KEY,
  linear_organization_id TEXT    NOT NULL,
  event_type            TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('leased', 'enqueued')),
  lease_until_ms        INTEGER NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  received_at           TEXT    NOT NULL,
  enqueued_at           TEXT,
  updated_at            TEXT    NOT NULL,
  FOREIGN KEY (linear_organization_id)
    REFERENCES linear_connection(linear_organization_id)
);
CREATE INDEX idx_linear_delivery_lease_org
  ON linear_delivery_lease(linear_organization_id, status, lease_until_ms);
