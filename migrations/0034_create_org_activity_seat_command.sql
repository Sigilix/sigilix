-- Immutable GitHub webhook evidence for activity-derived organization seats.
-- Forward-only; apply before the Worker begins writing commands. This migration
-- intentionally records eligible signed activity while rollout is dark. A
-- later migration owns mutable consumer state and applies readiness/cutover
-- authority without rewriting this audit ledger. The exact installation/repo
-- pair from the verified body is immutable event-time evidence, not billing
-- authorization: consumers must scope by both IDs and re-check readiness plus
-- exact repository authority before creating any seat operation.

PRAGMA foreign_keys = ON;

CREATE TABLE org_activity_seat_command (
  delivery_id                  TEXT    NOT NULL PRIMARY KEY CHECK (
    length(trim(delivery_id)) BETWEEN 1 AND 128
    AND instr(delivery_id, char(0)) = 0
  ),
  payload_sha256               TEXT    NOT NULL UNIQUE CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  installation_id             INTEGER NOT NULL CHECK (
    typeof(installation_id) = 'integer'
    AND installation_id BETWEEN 1 AND 9007199254740991
  ),
  repository_id               INTEGER NOT NULL CHECK (
    typeof(repository_id) = 'integer'
    AND repository_id BETWEEN 1 AND 9007199254740991
  ),
  pr_number                    INTEGER NOT NULL CHECK (
    typeof(pr_number) = 'integer'
    AND pr_number BETWEEN 1 AND 9007199254740991
  ),
  head_sha                     TEXT    NOT NULL CHECK (
    length(trim(head_sha)) BETWEEN 1 AND 128
    AND instr(head_sha, char(0)) = 0
  ),
  action                       TEXT    NOT NULL CHECK (
    action IN ('opened', 'synchronize', 'ready_for_review')
  ),
  target_github_user_id        TEXT    NOT NULL CHECK (
    target_github_user_id GLOB '[1-9]*'
    AND target_github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(target_github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(target_github_user_id AS INTEGER) AS TEXT)
      = target_github_user_id
  ),
  target_login                 TEXT    CHECK (
    target_login IS NULL OR (
      length(trim(target_login)) BETWEEN 1 AND 256
      AND instr(target_login, char(0)) = 0
    )
  ),
  actor_github_user_id         TEXT    NOT NULL CHECK (
    actor_github_user_id GLOB '[1-9]*'
    AND actor_github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(actor_github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(actor_github_user_id AS INTEGER) AS TEXT)
      = actor_github_user_id
  ),
  actor_login                  TEXT    CHECK (
    actor_login IS NULL OR (
      length(trim(actor_login)) BETWEEN 1 AND 256
      AND instr(actor_login, char(0)) = 0
    )
  ),
  author_association           TEXT    NOT NULL CHECK (
    author_association IN ('OWNER', 'MEMBER')
  ),
  received_at_ms               INTEGER NOT NULL CHECK (
    typeof(received_at_ms) = 'integer'
    AND received_at_ms BETWEEN 0 AND 9007199254740991
  ),
  created_at                   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (
    length(trim(created_at)) BETWEEN 1 AND 64
    AND instr(created_at, char(0)) = 0
  ),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id)
);

CREATE INDEX idx_org_activity_seat_command_installation_received
  ON org_activity_seat_command(installation_id, received_at_ms, delivery_id);

CREATE INDEX idx_org_activity_seat_command_repository_pr
  ON org_activity_seat_command(repository_id, pr_number);

-- Reject REPLACE as well as a plain duplicate insert. SQLite conflict handling
-- runs after BEFORE INSERT triggers, so no caller can delete-and-recreate an
-- immutable event through INSERT OR REPLACE.
CREATE TRIGGER trg_org_activity_seat_command_no_reinsert
BEFORE INSERT ON org_activity_seat_command
WHEN EXISTS (
       SELECT 1 FROM org_activity_seat_command
        WHERE delivery_id = NEW.delivery_id
     )
  OR EXISTS (
       SELECT 1 FROM org_activity_seat_command
        WHERE payload_sha256 = NEW.payload_sha256
     )
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command already exists');
END;

CREATE TRIGGER trg_org_activity_seat_command_no_update
BEFORE UPDATE ON org_activity_seat_command
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command is immutable');
END;

CREATE TRIGGER trg_org_activity_seat_command_no_delete
BEFORE DELETE ON org_activity_seat_command
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command is immutable');
END;
