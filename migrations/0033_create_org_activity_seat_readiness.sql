-- Immutable per-installation cutover boundary for activity-derived seats.
-- Forward-only; apply before any Worker reads this table. This migration does
-- not activate an installation. A later backfill must map immutable identities,
-- drain legacy assignments, and insert readiness in one lease-held D1 batch.
--
-- The database is authoritative for the epoch boundary. Once a readiness row
-- exists, no direct or future caller can create more login-keyed assignment or
-- billing work for that installation. Installations without a row remain on the
-- bilingual legacy recovery path.

PRAGMA foreign_keys = ON;

CREATE TABLE org_activity_seat_readiness (
  installation_id                    INTEGER PRIMARY KEY CHECK (
    installation_id BETWEEN 1 AND 9007199254740991
  ),
  activation_id                      TEXT    NOT NULL UNIQUE CHECK (
    length(trim(activation_id)) BETWEEN 1 AND 128
    AND instr(activation_id, char(0)) = 0
  ),
  activation_source                  TEXT    NOT NULL CHECK (
    activation_source = 'legacy_backfill_v1'
  ),
  -- Fixed schema provenance, not a mutable rollout revision.
  schema_version                     INTEGER NOT NULL CHECK (schema_version = 1),
  cutover_at_ms                      INTEGER NOT NULL CHECK (cutover_at_ms >= 0),
  cutover_at                         TEXT    NOT NULL CHECK (
    length(trim(cutover_at)) BETWEEN 1 AND 64
    AND instr(cutover_at, char(0)) = 0
  ),
  activated_by_actor_github_user_id  TEXT    NOT NULL CHECK (
    activated_by_actor_github_user_id GLOB '[1-9]*'
    AND activated_by_actor_github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(activated_by_actor_github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(activated_by_actor_github_user_id AS INTEGER) AS TEXT)
      = activated_by_actor_github_user_id
  ),
  stripe_snapshot_revision           INTEGER NOT NULL CHECK (stripe_snapshot_revision >= 0),
  billing_lease_acquired_at_ms       INTEGER NOT NULL CHECK (billing_lease_acquired_at_ms >= 0),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id)
);

-- The final cutover is permitted only while the exact installation lease is
-- live, its paid-seat snapshot is current, and every login-keyed assignment and
-- active operation has already drained. The later activator supplies one
-- Worker-clock cutover timestamp; an expired lease fails and is retried under a
-- fresh lease.
CREATE TRIGGER trg_org_activity_seat_readiness_guard_insert
BEFORE INSERT ON org_activity_seat_readiness
WHEN NOT EXISTS (
       SELECT 1 FROM tenant
        WHERE installation_id = NEW.installation_id
     )
  OR NOT EXISTS (
       SELECT 1 FROM org_seat_billing_lease
        WHERE installation_id = NEW.installation_id
          AND acquired_at_ms = NEW.billing_lease_acquired_at_ms
          AND acquired_at_ms <= NEW.cutover_at_ms
          AND expires_at_ms > NEW.cutover_at_ms
     )
  OR NOT EXISTS (
       SELECT 1 FROM stripe_seat_subscription
        WHERE installation_id = NEW.installation_id
          AND revision = NEW.stripe_snapshot_revision
          AND subscription_status IN ('active', 'trialing')
          AND snapshot_state = 'ready'
          AND observed_quantity IS NOT NULL
          AND observed_quantity = derived_quantity
     )
  OR EXISTS (
       SELECT 1 FROM org_seat_billing_operation
        WHERE installation_id = NEW.installation_id
          AND state IN ('pending', 'stripe_applied')
     )
  OR EXISTS (
       SELECT 1 FROM org_seat_assignment
        WHERE installation_id = NEW.installation_id AND assigned = 1
     )
BEGIN
  SELECT RAISE(ABORT, 'activity seat readiness requires a live drained billing checkpoint');
END;

CREATE TRIGGER trg_org_activity_seat_readiness_no_update
BEFORE UPDATE ON org_activity_seat_readiness
BEGIN
  SELECT RAISE(ABORT, 'activity seat readiness is immutable');
END;

CREATE TRIGGER trg_org_activity_seat_readiness_no_delete
BEFORE DELETE ON org_activity_seat_readiness
BEGIN
  SELECT RAISE(ABORT, 'activity seat readiness is immutable');
END;

-- Readiness is the one-way epoch switch. Even assigned=0 legacy rows become
-- immutable history after cutover; draining must finish before readiness.
CREATE TRIGGER trg_org_activity_readiness_closes_legacy_assignment_insert
BEFORE INSERT ON org_seat_assignment
WHEN EXISTS (
  SELECT 1 FROM org_activity_seat_readiness
   WHERE installation_id = NEW.installation_id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy seat assignment is closed for activity-ready installation');
END;

CREATE TRIGGER trg_org_activity_readiness_closes_legacy_assignment_update
BEFORE UPDATE ON org_seat_assignment
WHEN EXISTS (
  SELECT 1 FROM org_activity_seat_readiness
   WHERE installation_id = OLD.installation_id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy seat assignment is closed for activity-ready installation');
END;

CREATE TRIGGER trg_org_activity_readiness_closes_legacy_assignment_delete
BEFORE DELETE ON org_seat_assignment
WHEN EXISTS (
  SELECT 1 FROM org_activity_seat_readiness
   WHERE installation_id = OLD.installation_id
)
BEGIN
  SELECT RAISE(ABORT, 'legacy seat assignment is closed for activity-ready installation');
END;

CREATE TRIGGER trg_org_activity_readiness_closes_legacy_operation_insert
BEFORE INSERT ON org_seat_billing_operation
WHEN NEW.target_identity_kind = 'legacy_login'
 AND EXISTS (
   SELECT 1 FROM org_activity_seat_readiness
    WHERE installation_id = NEW.installation_id
 )
BEGIN
  SELECT RAISE(ABORT, 'legacy seat billing operation is closed for activity-ready installation');
END;

-- Readiness cannot coexist with an active operation, so no legitimate recovery
-- update is blocked. This closes direct terminal-history reactivation without
-- rewriting or deleting readable terminal history.
CREATE TRIGGER trg_org_activity_readiness_closes_legacy_operation_update
BEFORE UPDATE ON org_seat_billing_operation
WHEN NEW.target_identity_kind = 'legacy_login'
 AND NEW.state IN ('pending', 'stripe_applied')
 AND EXISTS (
   SELECT 1 FROM org_activity_seat_readiness
    WHERE installation_id = NEW.installation_id
 )
BEGIN
  SELECT RAISE(ABORT, 'legacy seat billing operation is closed for activity-ready installation');
END;
