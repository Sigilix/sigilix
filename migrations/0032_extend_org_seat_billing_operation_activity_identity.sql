-- Extend durable seat-billing intent with immutable activity-seat identity.
-- Forward-only; apply before any Worker can create activity_github operations.
-- This remains a dark schema foundation: current Workers reject the new kind,
-- while the shared table keeps every seat mode on one Stripe quantity/revision
-- serialization boundary.

PRAGMA foreign_keys = ON;

-- SQLite cannot widen the target_identity_kind CHECK added by migration 0028.
-- Rebuild the table inside D1's migration transaction, preserving the exact
-- existing column order and appending the activity-only actor identity last so
-- every current explicit reader/writer remains compatible.
CREATE TABLE org_seat_billing_operation_0032_next (
  operation_id                    TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  installation_id                INTEGER NOT NULL CHECK (installation_id > 0),
  revision                       INTEGER NOT NULL CHECK (revision > 0),
  login                          TEXT NOT NULL CHECK (length(trim(login)) > 0),
  requested_assigned             INTEGER NOT NULL CHECK (requested_assigned IN (0, 1)),
  previous_assigned              INTEGER NOT NULL CHECK (previous_assigned IN (0, 1)),
  desired_quantity               INTEGER NOT NULL CHECK (desired_quantity >= 0),
  state                          TEXT NOT NULL CHECK
                                      (state IN ('pending', 'stripe_applied', 'committed', 'failed', 'canceled')),
  stripe_subscription_id         TEXT NOT NULL CHECK (length(stripe_subscription_id) > 0),
  stripe_subscription_item_id    TEXT NOT NULL CHECK (length(stripe_subscription_item_id) > 0),
  stripe_observed_quantity       INTEGER CHECK
                                      (stripe_observed_quantity IS NULL OR stripe_observed_quantity >= 0),
  idempotency_key                TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
  attempts                       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code                     TEXT CHECK (error_code IS NULL OR length(error_code) > 0),
  next_attempt_at_ms             INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0),
  created_at_ms                  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms                  INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  stripe_applied_at_ms           INTEGER CHECK (stripe_applied_at_ms IS NULL OR stripe_applied_at_ms >= 0),
  completed_at_ms                INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  actor_login                    TEXT CHECK (actor_login IS NULL OR length(trim(actor_login)) > 0),
  target_is_admin                INTEGER CHECK (target_is_admin IS NULL OR target_is_admin IN (0, 1)),
  target_identity_kind           TEXT NOT NULL DEFAULT 'legacy_login'
                                      CHECK (target_identity_kind IN
                                        ('legacy_login', 'managed_github', 'activity_github')),
  target_github_user_id          TEXT CHECK (
    target_github_user_id IS NULL OR (
      target_github_user_id GLOB '[1-9]*'
      AND target_github_user_id NOT GLOB '*[^0-9]*'
      AND CAST(target_github_user_id AS INTEGER) <= 9007199254740991
      AND CAST(CAST(target_github_user_id AS INTEGER) AS TEXT) = target_github_user_id
    )
  ),
  activity_actor_github_user_id  TEXT CHECK (
    activity_actor_github_user_id IS NULL OR (
      activity_actor_github_user_id GLOB '[1-9]*'
      AND activity_actor_github_user_id NOT GLOB '*[^0-9]*'
      AND CAST(activity_actor_github_user_id AS INTEGER) <= 9007199254740991
      AND CAST(CAST(activity_actor_github_user_id AS INTEGER) AS TEXT)
        = activity_actor_github_user_id
    )
  ),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id),
  CHECK (
    state <> 'pending' OR (
      stripe_observed_quantity IS NOT NULL
      AND next_attempt_at_ms IS NOT NULL
      AND stripe_applied_at_ms IS NULL
      AND completed_at_ms IS NULL
    )
  ),
  CHECK (
    state <> 'stripe_applied' OR (
      stripe_observed_quantity IS NOT NULL
      AND stripe_observed_quantity = desired_quantity
      AND stripe_applied_at_ms IS NOT NULL
      AND next_attempt_at_ms IS NOT NULL
      AND completed_at_ms IS NULL
    )
  ),
  CHECK (
    state <> 'committed' OR (
      stripe_observed_quantity IS NOT NULL
      AND stripe_observed_quantity = desired_quantity
      AND stripe_applied_at_ms IS NOT NULL
      AND completed_at_ms IS NOT NULL
      AND next_attempt_at_ms IS NULL
      AND error_code IS NULL
    )
  ),
  CHECK (
    state NOT IN ('failed', 'canceled') OR (
      error_code IS NOT NULL
      AND length(trim(error_code)) > 0
      AND completed_at_ms IS NOT NULL
      AND next_attempt_at_ms IS NULL
      AND stripe_applied_at_ms IS NULL
    )
  ),
  CHECK (
    (target_identity_kind = 'legacy_login'
      AND target_github_user_id IS NULL
      AND activity_actor_github_user_id IS NULL)
    OR (target_identity_kind = 'managed_github'
      AND target_github_user_id IS NOT NULL
      AND activity_actor_github_user_id IS NULL)
    OR (target_identity_kind = 'activity_github'
      AND target_github_user_id IS NOT NULL
      AND activity_actor_github_user_id IS NOT NULL)
  )
);

INSERT INTO org_seat_billing_operation_0032_next (
  operation_id, installation_id, revision, login, requested_assigned,
  previous_assigned, desired_quantity, state, stripe_subscription_id,
  stripe_subscription_item_id, stripe_observed_quantity, idempotency_key,
  attempts, error_code, next_attempt_at_ms, created_at_ms, updated_at_ms,
  stripe_applied_at_ms, completed_at_ms, actor_login, target_is_admin,
  target_identity_kind, target_github_user_id, activity_actor_github_user_id
)
SELECT
  operation_id, installation_id, revision, login, requested_assigned,
  previous_assigned, desired_quantity, state, stripe_subscription_id,
  stripe_subscription_item_id, stripe_observed_quantity, idempotency_key,
  attempts, error_code, next_attempt_at_ms, created_at_ms, updated_at_ms,
  stripe_applied_at_ms, completed_at_ms, actor_login, target_is_admin,
  target_identity_kind, target_github_user_id, NULL
FROM org_seat_billing_operation;

DROP TABLE org_seat_billing_operation;
ALTER TABLE org_seat_billing_operation_0032_next RENAME TO org_seat_billing_operation;

CREATE UNIQUE INDEX idx_org_seat_billing_operation_active
  ON org_seat_billing_operation(installation_id)
  WHERE state IN ('pending', 'stripe_applied');
CREATE INDEX idx_org_seat_billing_operation_history
  ON org_seat_billing_operation(installation_id, created_at_ms DESC);
CREATE INDEX idx_org_seat_billing_operation_recovery
  ON org_seat_billing_operation(state, next_attempt_at_ms)
  WHERE state IN ('pending', 'stripe_applied') AND next_attempt_at_ms IS NOT NULL;
CREATE UNIQUE INDEX idx_org_seat_billing_operation_revision
  ON org_seat_billing_operation(installation_id, revision);
CREATE INDEX idx_org_seat_billing_operation_managed_target
  ON org_seat_billing_operation(installation_id, target_github_user_id, state)
  WHERE target_identity_kind = 'managed_github';

CREATE TRIGGER trg_org_seat_billing_operation_active_context_insert
BEFORE INSERT ON org_seat_billing_operation
WHEN NEW.state IN ('pending', 'stripe_applied')
  AND (NEW.actor_login IS NULL OR length(trim(NEW.actor_login)) = 0 OR NEW.target_is_admin IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active seat billing operation requires authorization context');
END;

CREATE TRIGGER trg_org_seat_billing_operation_active_context_update
BEFORE UPDATE ON org_seat_billing_operation
WHEN NEW.state IN ('pending', 'stripe_applied')
  AND (NEW.actor_login IS NULL OR length(trim(NEW.actor_login)) = 0 OR NEW.target_is_admin IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active seat billing operation requires authorization context');
END;

CREATE TRIGGER trg_org_seat_billing_operation_target_identity_insert
BEFORE INSERT ON org_seat_billing_operation
WHEN (NEW.target_identity_kind = 'legacy_login'
    AND (NEW.target_github_user_id IS NOT NULL OR NEW.activity_actor_github_user_id IS NOT NULL))
  OR (NEW.target_identity_kind = 'managed_github'
    AND (NEW.target_github_user_id IS NULL OR NEW.activity_actor_github_user_id IS NOT NULL))
  OR (NEW.target_identity_kind = 'activity_github'
    AND (NEW.target_github_user_id IS NULL OR NEW.activity_actor_github_user_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'seat billing operation target identity is inconsistent');
END;

CREATE TRIGGER trg_org_seat_billing_operation_target_identity_update
BEFORE UPDATE ON org_seat_billing_operation
WHEN (NEW.target_identity_kind = 'legacy_login'
    AND (NEW.target_github_user_id IS NOT NULL OR NEW.activity_actor_github_user_id IS NOT NULL))
  OR (NEW.target_identity_kind = 'managed_github'
    AND (NEW.target_github_user_id IS NULL OR NEW.activity_actor_github_user_id IS NOT NULL))
  OR (NEW.target_identity_kind = 'activity_github'
    AND (NEW.target_github_user_id IS NULL OR NEW.activity_actor_github_user_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'seat billing operation target identity is inconsistent');
END;

CREATE TRIGGER trg_org_seat_billing_operation_target_immutable
BEFORE UPDATE ON org_seat_billing_operation
WHEN NEW.target_identity_kind <> OLD.target_identity_kind
  OR NEW.target_github_user_id IS NOT OLD.target_github_user_id
  OR NEW.activity_actor_github_user_id IS NOT OLD.activity_actor_github_user_id
  OR NEW.login <> OLD.login
  OR NEW.idempotency_key <> OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'seat billing operation target identity is immutable');
END;

CREATE INDEX idx_org_seat_billing_operation_activity_target
  ON org_seat_billing_operation(installation_id, target_github_user_id, state)
  WHERE target_identity_kind = 'activity_github';
