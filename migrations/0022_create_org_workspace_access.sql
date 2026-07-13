-- App-managed organization workspace access and immutable mutation audit.
-- Forward-only; apply before code that enables OPENCLAW_ORG_MEMBERSHIP_MODE=on.
--
-- Legacy account_tenant.role values are intentionally ignored: that field was
-- an onboarding placeholder and is not an authorization source. This dark
-- foundation does not copy legacy links; population begins only after the
-- rollout gate and account-lifecycle integration are ready.

CREATE TABLE org_workspace_access (
  installation_id  INTEGER NOT NULL CHECK (installation_id > 0),
  github_user_id   TEXT    NOT NULL CHECK (
    github_user_id GLOB '[1-9]*'
    AND github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(github_user_id AS INTEGER) AS TEXT) = github_user_id
  ),
  role             TEXT    NOT NULL CHECK (role IN ('admin', 'member')),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  revoked_at       TEXT,
  updated_by       TEXT    NOT NULL CHECK (length(trim(updated_by)) > 0),
  last_audit_id    TEXT    NOT NULL CHECK (length(trim(last_audit_id)) > 0),
  last_action      TEXT    NOT NULL CHECK (last_action IN (
    'bootstrap_admin',
    'member_added_or_regranted',
    'role_changed',
    'access_removed',
    'operator_recovery'
  )),
  PRIMARY KEY (installation_id, github_user_id)
);

CREATE INDEX idx_org_workspace_access_active_role
  ON org_workspace_access (installation_id, revoked_at, role);

CREATE TABLE org_workspace_access_audit (
  installation_id      INTEGER NOT NULL CHECK (installation_id > 0),
  audit_id              TEXT    NOT NULL CHECK (length(trim(audit_id)) > 0),
  target_github_user_id TEXT    NOT NULL CHECK (
    target_github_user_id GLOB '[1-9]*'
    AND target_github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(target_github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(target_github_user_id AS INTEGER) AS TEXT) = target_github_user_id
  ),
  action                TEXT    NOT NULL CHECK (action IN (
    'bootstrap_admin',
    'member_added_or_regranted',
    'role_changed',
    'access_removed',
    'operator_recovery'
  )),
  previous_role         TEXT    CHECK (previous_role IS NULL OR previous_role IN ('admin', 'member')),
  next_role             TEXT    CHECK (next_role IS NULL OR next_role IN ('admin', 'member')),
  actor_id              TEXT    NOT NULL CHECK (length(trim(actor_id)) > 0),
  created_at            TEXT    NOT NULL,
  PRIMARY KEY (installation_id, audit_id)
);

CREATE INDEX idx_org_workspace_access_audit_target_time
  ON org_workspace_access_audit (installation_id, target_github_user_id, created_at);

-- Triggers keep the access mutation and its audit event in the same SQLite
-- statement, including the single-statement first-admin bootstrap.
CREATE TRIGGER trg_org_workspace_access_audit_insert
AFTER INSERT ON org_workspace_access
BEGIN
  INSERT INTO org_workspace_access_audit (
    installation_id, audit_id, target_github_user_id, action,
    previous_role, next_role, actor_id, created_at
  ) VALUES (
    NEW.installation_id, NEW.last_audit_id, NEW.github_user_id, NEW.last_action,
    NULL, CASE WHEN NEW.revoked_at IS NULL THEN NEW.role ELSE NULL END,
    NEW.updated_by, NEW.updated_at
  );
END;

-- The workspace/user key and creation timestamp define the immutable access
-- identity. A role/revocation change must create a new row version instead of
-- rewriting that identity in place.
CREATE TRIGGER trg_org_workspace_access_identity_immutable
BEFORE UPDATE ON org_workspace_access
WHEN NEW.installation_id <> OLD.installation_id
  OR NEW.github_user_id <> OLD.github_user_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'org workspace access identity is immutable');
END;

-- Every update must rotate the audit id. This prevents a direct SQL write from
-- changing authorization state while bypassing the append-only audit trigger.
CREATE TRIGGER trg_org_workspace_access_update_requires_audit
BEFORE UPDATE ON org_workspace_access
WHEN NEW.last_audit_id = OLD.last_audit_id
BEGIN
  SELECT RAISE(ABORT, 'org workspace access update requires audit');
END;

CREATE TRIGGER trg_org_workspace_access_audit_update
AFTER UPDATE ON org_workspace_access
WHEN NEW.last_audit_id <> OLD.last_audit_id
BEGIN
  INSERT INTO org_workspace_access_audit (
    installation_id, audit_id, target_github_user_id, action,
    previous_role, next_role, actor_id, created_at
  ) VALUES (
    NEW.installation_id, NEW.last_audit_id, NEW.github_user_id, NEW.last_action,
    CASE WHEN OLD.revoked_at IS NULL THEN OLD.role ELSE NULL END,
    CASE WHEN NEW.revoked_at IS NULL THEN NEW.role ELSE NULL END,
    NEW.updated_by, NEW.updated_at
  );
END;

-- Access removal is always a tombstone, never a hard delete. Audit rows are
-- append-only evidence and cannot be rewritten or deleted by application code.
CREATE TRIGGER trg_org_workspace_access_no_delete
BEFORE DELETE ON org_workspace_access
BEGIN
  SELECT RAISE(ABORT, 'org_workspace_access rows must be tombstoned');
END;

CREATE TRIGGER trg_org_workspace_access_audit_no_update
BEFORE UPDATE ON org_workspace_access_audit
BEGIN
  SELECT RAISE(ABORT, 'org workspace audit rows are immutable');
END;

CREATE TRIGGER trg_org_workspace_access_audit_no_delete
BEFORE DELETE ON org_workspace_access_audit
BEGIN
  SELECT RAISE(ABORT, 'org workspace audit rows are immutable');
END;
