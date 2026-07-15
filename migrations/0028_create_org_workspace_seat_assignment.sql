-- SIG — immutable managed-member identity for organization seat assignment.
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Apply with
-- `wrangler d1 migrations apply sigilix-platform` before dependent code ships.
--
-- Managed seats are keyed by the exact GitHub user id already authorized in
-- org_workspace_access. Logins remain display-only metadata and may change
-- without moving a seat or its recoverable Stripe operation to another user.
-- Access does not imply a billable seat: absent/new assignment state defaults
-- to unassigned until an explicit backfill or admin action grants the seat.

PRAGMA foreign_keys = ON;

CREATE TABLE org_workspace_seat_assignment (
  installation_id  INTEGER NOT NULL CHECK (installation_id > 0),
  github_user_id   TEXT    NOT NULL CHECK (
    github_user_id GLOB '[1-9]*'
    AND github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(github_user_id AS INTEGER) AS TEXT) = github_user_id
  ),
  assigned         INTEGER NOT NULL DEFAULT 0 CHECK (assigned IN (0, 1)),
  last_known_login TEXT    CHECK (
    last_known_login IS NULL OR (
      length(trim(last_known_login)) BETWEEN 1 AND 256
      AND instr(last_known_login, char(0)) = 0
    )
  ),
  created_at       TEXT    NOT NULL CHECK (
    length(trim(created_at)) BETWEEN 1 AND 64 AND instr(created_at, char(0)) = 0
  ),
  updated_at       TEXT    NOT NULL CHECK (
    length(trim(updated_at)) BETWEEN 1 AND 64 AND instr(updated_at, char(0)) = 0
  ),
  updated_by       TEXT    NOT NULL CHECK (
    length(trim(updated_by)) BETWEEN 1 AND 256 AND instr(updated_by, char(0)) = 0
  ),
  PRIMARY KEY (installation_id, github_user_id),
  FOREIGN KEY (installation_id, github_user_id)
    REFERENCES org_workspace_access(installation_id, github_user_id)
);

CREATE INDEX idx_org_workspace_seat_assignment_scan
  ON org_workspace_seat_assignment(installation_id, assigned);

CREATE TRIGGER trg_org_workspace_seat_assignment_identity_immutable
BEFORE UPDATE ON org_workspace_seat_assignment
WHEN NEW.installation_id <> OLD.installation_id
  OR NEW.github_user_id <> OLD.github_user_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'org workspace seat assignment identity is immutable');
END;

ALTER TABLE org_seat_billing_operation
  ADD COLUMN target_identity_kind TEXT NOT NULL DEFAULT 'legacy_login'
    CHECK (target_identity_kind IN ('legacy_login', 'managed_github'));

ALTER TABLE org_seat_billing_operation
  ADD COLUMN target_github_user_id TEXT CHECK (
    target_github_user_id IS NULL OR (
      target_github_user_id GLOB '[1-9]*'
      AND target_github_user_id NOT GLOB '*[^0-9]*'
      AND CAST(target_github_user_id AS INTEGER) <= 9007199254740991
      AND CAST(CAST(target_github_user_id AS INTEGER) AS TEXT) = target_github_user_id
    )
  );

CREATE TRIGGER trg_org_seat_billing_operation_target_identity_insert
BEFORE INSERT ON org_seat_billing_operation
WHEN (NEW.target_identity_kind = 'legacy_login' AND NEW.target_github_user_id IS NOT NULL)
  OR (NEW.target_identity_kind = 'managed_github' AND NEW.target_github_user_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'seat billing operation target identity is inconsistent');
END;

CREATE TRIGGER trg_org_seat_billing_operation_target_identity_update
BEFORE UPDATE ON org_seat_billing_operation
WHEN (NEW.target_identity_kind = 'legacy_login' AND NEW.target_github_user_id IS NOT NULL)
  OR (NEW.target_identity_kind = 'managed_github' AND NEW.target_github_user_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'seat billing operation target identity is inconsistent');
END;

CREATE TRIGGER trg_org_seat_billing_operation_target_immutable
BEFORE UPDATE ON org_seat_billing_operation
WHEN NEW.target_identity_kind <> OLD.target_identity_kind
  OR NEW.target_github_user_id IS NOT OLD.target_github_user_id
  OR NEW.login <> OLD.login
  OR NEW.idempotency_key <> OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'seat billing operation target identity is immutable');
END;

CREATE INDEX idx_org_seat_billing_operation_managed_target
  ON org_seat_billing_operation(installation_id, target_github_user_id, state)
  WHERE target_identity_kind = 'managed_github';
