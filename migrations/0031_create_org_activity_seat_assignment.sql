-- Immutable GitHub identity for rollout-off organization activity seats.
-- Forward-only; apply before any Worker or portal code reads or writes this
-- table. This is a dark schema foundation only: activation requires a later
-- installation readiness state and a bilingual legacy-operation drain.
--
-- Activity-derived seats cannot reuse org_workspace_seat_assignment because
-- that table intentionally requires managed org_workspace_access. Logins here
-- are display-only metadata; they never authorize, identify, merge, or backfill
-- a seat. Every mutation pins the immutable GitHub id of its acting user; the
-- actor id is audit evidence, not a relational foreign key.

PRAGMA foreign_keys = ON;

CREATE TABLE org_activity_seat_assignment (
  installation_id                 INTEGER NOT NULL CHECK (
    installation_id BETWEEN 1 AND 9007199254740991
  ),
  github_user_id                  TEXT    NOT NULL CHECK (
    github_user_id GLOB '[1-9]*'
    AND github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(github_user_id AS INTEGER) AS TEXT) = github_user_id
  ),
  assigned                        INTEGER NOT NULL DEFAULT 1 CHECK (assigned IN (0, 1)),
  is_admin                        INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  last_known_login                TEXT    CHECK (
    last_known_login IS NULL OR (
      length(trim(last_known_login)) BETWEEN 1 AND 256
      AND instr(last_known_login, char(0)) = 0
    )
  ),
  created_at                      TEXT    NOT NULL CHECK (
    length(trim(created_at)) BETWEEN 1 AND 64 AND instr(created_at, char(0)) = 0
  ),
  updated_at                      TEXT    NOT NULL CHECK (
    length(trim(updated_at)) BETWEEN 1 AND 64 AND instr(updated_at, char(0)) = 0
  ),
  updated_by_actor_github_user_id TEXT    NOT NULL CHECK (
    updated_by_actor_github_user_id GLOB '[1-9]*'
    AND updated_by_actor_github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(updated_by_actor_github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(updated_by_actor_github_user_id AS INTEGER) AS TEXT)
      = updated_by_actor_github_user_id
  ),
  updated_by_actor_login          TEXT    CHECK (
    updated_by_actor_login IS NULL OR (
      length(trim(updated_by_actor_login)) BETWEEN 1 AND 256
      AND instr(updated_by_actor_login, char(0)) = 0
    )
  ),
  PRIMARY KEY (installation_id, github_user_id),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id)
);

CREATE INDEX idx_org_activity_seat_assignment_scan
  ON org_activity_seat_assignment(installation_id, assigned, is_admin);

CREATE TRIGGER trg_org_activity_seat_assignment_identity_immutable
BEFORE UPDATE ON org_activity_seat_assignment
WHEN NEW.installation_id <> OLD.installation_id
  OR NEW.github_user_id <> OLD.github_user_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'org activity seat assignment identity is immutable');
END;
