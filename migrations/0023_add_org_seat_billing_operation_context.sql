-- SIG — durable authorization context for recoverable seat-billing work.
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Apply with
-- `wrangler d1 migrations apply sigilix-platform` before dependent code ships.
--
-- Existing terminal history remains readable with NULL context. Any new or
-- updated recoverable operation must pin the verified actor and target role so
-- a later recovery worker never has to reconstruct authorization-sensitive
-- input from mutable membership state.

ALTER TABLE org_seat_billing_operation
  ADD COLUMN actor_login TEXT
    CHECK (actor_login IS NULL OR length(trim(actor_login)) > 0);

ALTER TABLE org_seat_billing_operation
  ADD COLUMN target_is_admin INTEGER
    CHECK (target_is_admin IS NULL OR target_is_admin IN (0, 1));

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
