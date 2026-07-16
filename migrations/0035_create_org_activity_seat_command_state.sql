-- Mutable consumer ownership for immutable GitHub activity-seat commands.
-- Forward-only; apply before the live command consumer ships. The command
-- ledger remains immutable evidence. This table only records whether the
-- command scanner still owns a command or has resolved/delegated it.

PRAGMA foreign_keys = ON;

CREATE TABLE org_activity_seat_command_state (
  delivery_id                    TEXT    NOT NULL PRIMARY KEY,
  state                          TEXT    NOT NULL CHECK (
    state IN ('pending', 'delegated', 'applied', 'ignored')
  ),
  resolution                     TEXT    CHECK (
    resolution IS NULL OR resolution IN (
      'assigned', 'already_assigned',
      'pre_cutover', 'repository_not_authorized', 'manual_unassign'
    )
  ),
  operation_id                   TEXT    UNIQUE CHECK (
    operation_id IS NULL OR (
      length(trim(operation_id)) BETWEEN 1 AND 128
      AND instr(operation_id, char(0)) = 0
    )
  ),
  attempts                       INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attempts) = 'integer'
    AND attempts BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at_ms             INTEGER CHECK (
    next_attempt_at_ms IS NULL OR (
      typeof(next_attempt_at_ms) = 'integer'
      AND next_attempt_at_ms BETWEEN 0 AND 9007199254740991
    )
  ),
  last_error_code                TEXT    CHECK (
    last_error_code IS NULL OR (
      length(trim(last_error_code)) BETWEEN 1 AND 128
      AND instr(last_error_code, char(0)) = 0
    )
  ),
  repository_authorized_at_ms    INTEGER CHECK (
    repository_authorized_at_ms IS NULL OR (
      typeof(repository_authorized_at_ms) = 'integer'
      AND repository_authorized_at_ms BETWEEN 0 AND 9007199254740991
    )
  ),
  created_at_ms                  INTEGER NOT NULL CHECK (
    typeof(created_at_ms) = 'integer'
    AND created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms                  INTEGER NOT NULL CHECK (
    typeof(updated_at_ms) = 'integer'
    AND updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  terminal_at_ms                 INTEGER CHECK (
    terminal_at_ms IS NULL OR (
      typeof(terminal_at_ms) = 'integer'
      AND terminal_at_ms BETWEEN created_at_ms AND updated_at_ms
    )
  ),
  FOREIGN KEY (delivery_id) REFERENCES org_activity_seat_command(delivery_id),
  FOREIGN KEY (operation_id) REFERENCES org_seat_billing_operation(operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (state = 'pending'
      AND resolution IS NULL
      AND operation_id IS NULL
      AND next_attempt_at_ms IS NOT NULL
      AND repository_authorized_at_ms IS NULL
      AND terminal_at_ms IS NULL)
    OR
    (state = 'delegated'
      AND resolution IS NULL
      AND operation_id IS NOT NULL
      AND next_attempt_at_ms IS NULL
      AND last_error_code IS NULL
      AND repository_authorized_at_ms IS NOT NULL
      AND terminal_at_ms IS NOT NULL)
    OR
    (state = 'applied'
      AND resolution IN ('assigned', 'already_assigned')
      AND operation_id IS NULL
      AND next_attempt_at_ms IS NULL
      AND last_error_code IS NULL
      AND repository_authorized_at_ms IS NOT NULL
      AND terminal_at_ms IS NOT NULL)
    OR
    (state = 'ignored'
      AND resolution IN ('pre_cutover', 'repository_not_authorized', 'manual_unassign')
      AND operation_id IS NULL
      AND next_attempt_at_ms IS NULL
      AND last_error_code IS NULL
      AND terminal_at_ms IS NOT NULL
      AND (
        (resolution = 'manual_unassign' AND repository_authorized_at_ms IS NOT NULL)
        OR
        (resolution IN ('pre_cutover', 'repository_not_authorized')
          AND repository_authorized_at_ms IS NULL)
      ))
  ),
  CHECK (
    repository_authorized_at_ms IS NULL
    OR (
      repository_authorized_at_ms BETWEEN created_at_ms AND updated_at_ms
      AND (terminal_at_ms IS NULL OR repository_authorized_at_ms <= terminal_at_ms)
    )
  )
);

CREATE INDEX idx_org_activity_seat_command_state_due
  ON org_activity_seat_command_state(state, next_attempt_at_ms, delivery_id)
  WHERE state = 'pending';

CREATE INDEX idx_org_activity_seat_command_consumer_scope
  ON org_activity_seat_command(installation_id, repository_id, received_at_ms, delivery_id);

-- One row per ready installation and immutable GitHub identity. Assigned in
-- either source wins. Only an explicit zero with no assigned source is a
-- manual-unassign tombstone. Revoked managed access cannot remain assigned,
-- while an already-written managed zero remains an explicit operator choice.
CREATE VIEW org_activity_ready_effective_seat AS
WITH seat_source AS (
  SELECT assignment.installation_id, assignment.github_user_id, 1 AS assigned
    FROM org_workspace_seat_assignment AS assignment
    JOIN org_workspace_access AS access
      ON access.installation_id = assignment.installation_id
     AND access.github_user_id = assignment.github_user_id
     AND access.revoked_at IS NULL
    JOIN org_activity_seat_readiness AS readiness
      ON readiness.installation_id = assignment.installation_id
   WHERE assignment.assigned = 1
  UNION ALL
  SELECT assignment.installation_id, assignment.github_user_id, 0 AS assigned
    FROM org_workspace_seat_assignment AS assignment
    JOIN org_activity_seat_readiness AS readiness
      ON readiness.installation_id = assignment.installation_id
   WHERE assignment.assigned = 0
  UNION ALL
  SELECT assignment.installation_id, assignment.github_user_id, assignment.assigned
    FROM org_activity_seat_assignment AS assignment
    JOIN org_activity_seat_readiness AS readiness
      ON readiness.installation_id = assignment.installation_id
)
SELECT installation_id, github_user_id,
       MAX(assigned) AS effective_assigned,
       MAX(CASE WHEN assigned = 0 THEN 1 ELSE 0 END) AS has_explicit_zero,
       CASE WHEN MAX(assigned) = 1 THEN 'assigned' ELSE 'manual_unassign' END AS effective_status
  FROM seat_source
 GROUP BY installation_id, github_user_id;

-- Existing commands are rare dark-rollout evidence, but still receive the
-- same scanner-owned initial state as future commands. This is idempotent
-- inside the migration transaction and preserves every parent byte.
INSERT INTO org_activity_seat_command_state (
  delivery_id, state, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms
)
SELECT command.delivery_id, 'pending', 0, command.received_at_ms,
       command.received_at_ms, command.received_at_ms
  FROM org_activity_seat_command AS command
 WHERE NOT EXISTS (
   SELECT 1 FROM org_activity_seat_command_state AS state
    WHERE state.delivery_id = command.delivery_id
 );

-- The migration necessarily lands before the consumer. Seed state in the same
-- D1 transaction as every new immutable command so that deployment ordering
-- cannot create an unowned gap.
CREATE TRIGGER trg_org_activity_seat_command_state_seed
AFTER INSERT ON org_activity_seat_command
BEGIN
  INSERT INTO org_activity_seat_command_state (
    delivery_id, state, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms
  ) VALUES (
    NEW.delivery_id, 'pending', 0, NEW.received_at_ms, NEW.received_at_ms, NEW.received_at_ms
  );
END;

-- INSERT OR REPLACE must not reset a retry or transfer an operation link.
CREATE TRIGGER trg_org_activity_seat_command_state_no_reinsert
BEFORE INSERT ON org_activity_seat_command_state
WHEN EXISTS (
       SELECT 1 FROM org_activity_seat_command_state
        WHERE delivery_id = NEW.delivery_id
     )
  OR (NEW.operation_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM org_activity_seat_command_state
        WHERE operation_id = NEW.operation_id
     ))
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command state already exists');
END;

-- A pending command may retry or move exactly once to a terminal scanner
-- outcome. Retry evidence and authorization/link timestamps are monotonic.
CREATE TRIGGER trg_org_activity_seat_command_state_lifecycle
BEFORE UPDATE ON org_activity_seat_command_state
WHEN OLD.state = 'pending' AND (
     NEW.delivery_id <> OLD.delivery_id
  OR NEW.created_at_ms <> OLD.created_at_ms
  OR NEW.attempts < OLD.attempts
  OR NEW.updated_at_ms < OLD.updated_at_ms
  OR (OLD.repository_authorized_at_ms IS NOT NULL
      AND NEW.repository_authorized_at_ms IS NOT OLD.repository_authorized_at_ms)
  OR OLD.operation_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command state lifecycle is immutable');
END;

-- Resolution labels are permanent, so every locally-provable terminal outcome
-- must agree with the immutable command, readiness epoch, and effective seat
-- state at the transition. Repository authorization is live GitHub evidence
-- and therefore remains the one externally-proven resolution.
CREATE TRIGGER trg_org_activity_seat_command_state_terminal_outcome
BEFORE UPDATE ON org_activity_seat_command_state
WHEN OLD.state = 'pending' AND NEW.state IN ('applied', 'ignored') AND NOT (
  (NEW.state = 'ignored' AND NEW.resolution = 'pre_cutover'
    AND NEW.repository_authorized_at_ms IS NULL AND EXISTS (
    SELECT 1
      FROM org_activity_seat_command AS command
      JOIN org_activity_seat_readiness AS readiness
        ON readiness.installation_id = command.installation_id
     WHERE command.delivery_id = NEW.delivery_id
       AND command.received_at_ms <= readiness.cutover_at_ms
  ))
  OR
  (NEW.state = 'ignored' AND NEW.resolution = 'repository_not_authorized'
    AND NEW.repository_authorized_at_ms IS NULL AND EXISTS (
    SELECT 1
      FROM org_activity_seat_command AS command
      JOIN org_activity_seat_readiness AS readiness
        ON readiness.installation_id = command.installation_id
     WHERE command.delivery_id = NEW.delivery_id
       AND command.received_at_ms > readiness.cutover_at_ms
  ))
  OR
  (NEW.state = 'ignored' AND NEW.resolution = 'manual_unassign'
    AND NEW.repository_authorized_at_ms IS NOT NULL AND EXISTS (
    SELECT 1
      FROM org_activity_seat_command AS command
      JOIN org_activity_seat_readiness AS readiness
        ON readiness.installation_id = command.installation_id
      JOIN org_activity_ready_effective_seat AS effective
        ON effective.installation_id = command.installation_id
       AND effective.github_user_id = command.target_github_user_id
     WHERE command.delivery_id = NEW.delivery_id
       AND command.received_at_ms > readiness.cutover_at_ms
       AND effective.effective_assigned = 0
       AND effective.has_explicit_zero = 1
  ))
  OR
  (NEW.state = 'applied' AND NEW.resolution = 'assigned'
    AND NEW.repository_authorized_at_ms IS NOT NULL AND EXISTS (
    SELECT 1
      FROM org_activity_seat_command AS command
      JOIN org_activity_seat_readiness AS readiness
        ON readiness.installation_id = command.installation_id
      JOIN org_activity_seat_assignment AS assignment
        ON assignment.installation_id = command.installation_id
       AND assignment.github_user_id = command.target_github_user_id
       AND assignment.assigned = 1
     WHERE command.delivery_id = NEW.delivery_id
       AND command.received_at_ms > readiness.cutover_at_ms
  ))
  OR
  (NEW.state = 'applied' AND NEW.resolution = 'already_assigned'
    AND NEW.repository_authorized_at_ms IS NOT NULL AND EXISTS (
    SELECT 1
      FROM org_activity_seat_command AS command
      JOIN org_activity_seat_readiness AS readiness
        ON readiness.installation_id = command.installation_id
      JOIN org_activity_ready_effective_seat AS effective
        ON effective.installation_id = command.installation_id
       AND effective.github_user_id = command.target_github_user_id
     WHERE command.delivery_id = NEW.delivery_id
       AND command.received_at_ms > readiness.cutover_at_ms
       AND effective.effective_assigned = 1
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'activity command terminal outcome lacks exact command proof');
END;

-- SQLite's OR REPLACE conflict mode must not delete a command's already-linked
-- terminal state and transfer its operation to another delivery.
CREATE TRIGGER trg_org_activity_seat_command_state_operation_no_transfer
BEFORE UPDATE ON org_activity_seat_command_state
WHEN NEW.operation_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM org_activity_seat_command_state AS existing
   WHERE existing.operation_id = NEW.operation_id
     AND existing.delivery_id <> OLD.delivery_id
)
BEGIN
  SELECT RAISE(ABORT, 'activity command operation link cannot be transferred');
END;

CREATE TRIGGER trg_org_activity_seat_command_state_terminal_immutable
BEFORE UPDATE ON org_activity_seat_command_state
WHEN OLD.state IN ('delegated', 'applied', 'ignored')
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command terminal state is immutable');
END;

CREATE TRIGGER trg_org_activity_seat_command_state_no_delete
BEFORE DELETE ON org_activity_seat_command_state
BEGIN
  SELECT RAISE(ABORT, 'org activity seat command state cannot be deleted');
END;

-- Operation authority is immutable even though provider-recovery lifecycle
-- fields remain mutable. This keeps a linked command pinned to one tenant,
-- actor, target, revision, quantity, and Stripe subscription item.
CREATE TRIGGER trg_org_activity_seat_billing_operation_collision_update
BEFORE UPDATE ON org_seat_billing_operation
WHEN EXISTS (
  SELECT 1 FROM org_seat_billing_operation AS existing
   WHERE existing.operation_id <> OLD.operation_id
     AND (
       existing.target_identity_kind = 'activity_github'
       OR OLD.target_identity_kind = 'activity_github'
       OR NEW.target_identity_kind = 'activity_github'
     )
     AND (
       existing.operation_id = NEW.operation_id
       OR existing.idempotency_key = NEW.idempotency_key
       OR (
         existing.installation_id = NEW.installation_id
         AND existing.revision = NEW.revision
       )
       OR (
         existing.installation_id = NEW.installation_id
         AND existing.state IN ('pending', 'stripe_applied')
         AND NEW.state IN ('pending', 'stripe_applied')
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'activity seat billing operation unique authority cannot be replaced');
END;

CREATE TRIGGER trg_org_activity_seat_billing_operation_authority_immutable
BEFORE UPDATE ON org_seat_billing_operation
WHEN OLD.target_identity_kind = 'activity_github' AND (
     NEW.operation_id <> OLD.operation_id
  OR NEW.installation_id <> OLD.installation_id
  OR NEW.revision <> OLD.revision
  OR NEW.login <> OLD.login
  OR NEW.actor_login IS NOT OLD.actor_login
  OR NEW.target_is_admin IS NOT OLD.target_is_admin
  OR NEW.target_identity_kind <> OLD.target_identity_kind
  OR NEW.target_github_user_id IS NOT OLD.target_github_user_id
  OR NEW.activity_actor_github_user_id IS NOT OLD.activity_actor_github_user_id
  OR NEW.requested_assigned <> OLD.requested_assigned
  OR NEW.previous_assigned <> OLD.previous_assigned
  OR NEW.desired_quantity <> OLD.desired_quantity
  OR NEW.stripe_subscription_id <> OLD.stripe_subscription_id
  OR NEW.stripe_subscription_item_id <> OLD.stripe_subscription_item_id
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.created_at_ms <> OLD.created_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'activity seat billing operation authority is immutable');
END;

-- Preserve idempotent INSERT OR IGNORE retries while making INSERT OR REPLACE
-- a no-op for an existing activity operation. A replacement would bypass the
-- UPDATE trigger and could rewrite an unlinked operation's authority fields.
CREATE TRIGGER trg_org_activity_seat_billing_operation_no_reinsert
BEFORE INSERT ON org_seat_billing_operation
WHEN EXISTS (
  SELECT 1 FROM org_seat_billing_operation AS existing
   WHERE (
       existing.target_identity_kind = 'activity_github'
       OR NEW.target_identity_kind = 'activity_github'
     )
     AND (
       existing.operation_id = NEW.operation_id
       OR existing.idempotency_key = NEW.idempotency_key
       OR (
         existing.installation_id = NEW.installation_id
         AND existing.revision = NEW.revision
       )
       OR (
         existing.installation_id = NEW.installation_id
         AND existing.state IN ('pending', 'stripe_applied')
         AND NEW.state IN ('pending', 'stripe_applied')
       )
     )
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER trg_org_activity_seat_billing_operation_no_delete
BEFORE DELETE ON org_seat_billing_operation
WHEN OLD.target_identity_kind = 'activity_github'
BEGIN
  SELECT RAISE(ABORT, 'activity seat billing operation cannot be deleted');
END;

-- Delegation is the exact ownership boundary. The command scanner can hand off
-- only a post-cutover, live-repository-authorized, previously-unassigned
-- activity identity to one matching durable operation. The operation scheduler
-- then exclusively owns provider recovery. Every command state is seeded or
-- backfilled as pending and cannot be deleted, so delegation has one reachable
-- path: updating that exact scanner-owned row.
CREATE TRIGGER trg_org_activity_seat_command_state_operation_link_update
BEFORE UPDATE ON org_activity_seat_command_state
WHEN NEW.state = 'delegated' AND NOT EXISTS (
  SELECT 1
    FROM org_activity_seat_command AS command
    JOIN org_activity_seat_readiness AS readiness
      ON readiness.installation_id = command.installation_id
    JOIN org_seat_billing_operation AS operation
      ON operation.operation_id = NEW.operation_id
    JOIN stripe_seat_subscription AS snapshot
      ON snapshot.installation_id = command.installation_id
     AND snapshot.stripe_subscription_id = operation.stripe_subscription_id
     AND snapshot.stripe_subscription_item_id = operation.stripe_subscription_item_id
   WHERE command.delivery_id = NEW.delivery_id
     AND command.received_at_ms > readiness.cutover_at_ms
     AND operation.installation_id = command.installation_id
     AND operation.target_identity_kind = 'activity_github'
     AND operation.target_github_user_id = command.target_github_user_id
     AND operation.activity_actor_github_user_id = command.actor_github_user_id
     AND operation.requested_assigned = 1
     AND operation.previous_assigned = 0
     AND operation.target_is_admin = 0
     AND operation.state = 'pending'
     AND operation.attempts = 0
     AND operation.error_code IS NULL
     AND operation.updated_at_ms = operation.created_at_ms
     AND operation.created_at_ms BETWEEN NEW.repository_authorized_at_ms AND NEW.terminal_at_ms
     AND operation.revision > snapshot.revision
     AND operation.stripe_observed_quantity = snapshot.observed_quantity
     AND operation.desired_quantity = snapshot.observed_quantity + 1
     AND snapshot.subscription_status IN ('active', 'trialing')
     AND snapshot.snapshot_state = 'ready'
     AND snapshot.observed_quantity IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM org_activity_ready_effective_seat AS effective
        WHERE effective.installation_id = command.installation_id
          AND effective.github_user_id = command.target_github_user_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'activity operation link is outside exact command authority');
END;
