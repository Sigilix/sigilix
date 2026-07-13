-- SIG — Stripe seat reconciliation persistence foundation.
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Apply with
-- `wrangler d1 migrations apply sigilix-platform` before dependent code ships.
-- This migration records snapshots, durable operation intent, and short-lived
-- reconciliation leases. It does not schedule work or call Stripe.

CREATE TABLE stripe_seat_subscription (
  installation_id                 INTEGER PRIMARY KEY CHECK (installation_id > 0),
  stripe_customer_id              TEXT CHECK (stripe_customer_id IS NULL OR length(stripe_customer_id) > 0),
  stripe_subscription_id          TEXT CHECK (stripe_subscription_id IS NULL OR length(stripe_subscription_id) > 0),
  stripe_subscription_item_id     TEXT CHECK (stripe_subscription_item_id IS NULL OR length(stripe_subscription_item_id) > 0),
  stripe_price_id                 TEXT CHECK (stripe_price_id IS NULL OR length(stripe_price_id) > 0),
  -- Deliberately unconstrained: Stripe may add statuses without warning, and a
  -- new provider value must not make an otherwise valid snapshot write fail.
  subscription_status             TEXT,
  -- External truth is the last Stripe item quantity; internal truth is the
  -- latest quantity derived from Sigilix seat semantics.
  observed_quantity               INTEGER CHECK (observed_quantity IS NULL OR observed_quantity >= 0),
  derived_quantity                INTEGER NOT NULL DEFAULT 0 CHECK (derived_quantity >= 0),
  -- Local snapshot version. A future writer increments this only in a guarded
  -- UPDATE ... WHERE revision = expected_revision.
  revision                        INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  snapshot_state                  TEXT NOT NULL DEFAULT 'discovering'
                                      CHECK (snapshot_state IN
                                        ('discovering', 'ready', 'review_required', 'blocked', 'not_applicable')),
  block_reason                    TEXT,
  last_stripe_event_id            TEXT CHECK (last_stripe_event_id IS NULL OR length(last_stripe_event_id) > 0),
  last_stripe_event_created_at_ms INTEGER CHECK
                                      (last_stripe_event_created_at_ms IS NULL OR last_stripe_event_created_at_ms >= 0),
  last_stripe_event_received_at_ms INTEGER CHECK
                                      (last_stripe_event_received_at_ms IS NULL OR last_stripe_event_received_at_ms >= 0),
  last_refreshed_at_ms            INTEGER CHECK (last_refreshed_at_ms IS NULL OR last_refreshed_at_ms >= 0),
  refresh_due_at_ms               INTEGER CHECK (refresh_due_at_ms IS NULL OR refresh_due_at_ms >= 0),
  created_at_ms                   INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms                   INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id),
  CHECK (
    (snapshot_state = 'blocked' AND block_reason IS NOT NULL AND length(trim(block_reason)) > 0)
    OR (snapshot_state <> 'blocked' AND block_reason IS NULL)
  ),
  CHECK (
    snapshot_state NOT IN ('ready', 'review_required') OR (
      stripe_customer_id IS NOT NULL
      AND stripe_subscription_id IS NOT NULL
      AND stripe_subscription_item_id IS NOT NULL
      AND stripe_price_id IS NOT NULL
      AND subscription_status IS NOT NULL
      AND subscription_status IN ('active', 'trialing')
      AND observed_quantity IS NOT NULL
      AND last_refreshed_at_ms IS NOT NULL
    )
  ),
  CHECK (snapshot_state <> 'ready' OR observed_quantity = derived_quantity),
  CHECK (snapshot_state <> 'review_required' OR observed_quantity <> derived_quantity)
);

CREATE UNIQUE INDEX idx_stripe_seat_subscription_subscription
  ON stripe_seat_subscription(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX idx_stripe_seat_subscription_item
  ON stripe_seat_subscription(stripe_subscription_item_id)
  WHERE stripe_subscription_item_id IS NOT NULL;
CREATE UNIQUE INDEX idx_stripe_seat_subscription_customer
  ON stripe_seat_subscription(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_stripe_seat_subscription_refresh_due
  ON stripe_seat_subscription(snapshot_state, refresh_due_at_ms)
  WHERE refresh_due_at_ms IS NOT NULL;

CREATE TABLE org_seat_billing_operation (
  operation_id                    TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  installation_id                INTEGER NOT NULL CHECK (installation_id > 0),
  revision                       INTEGER NOT NULL CHECK (revision > 0),
  login                          TEXT NOT NULL CHECK (length(trim(login)) > 0),
  requested_assigned             INTEGER NOT NULL CHECK (requested_assigned IN (0, 1)),
  previous_assigned              INTEGER NOT NULL CHECK (previous_assigned IN (0, 1)),
  desired_quantity               INTEGER NOT NULL CHECK (desired_quantity >= 0),
  state                           TEXT NOT NULL CHECK
                                      (state IN ('pending', 'stripe_applied', 'committed', 'failed', 'canceled')),
  stripe_subscription_id          TEXT NOT NULL CHECK (length(stripe_subscription_id) > 0),
  stripe_subscription_item_id     TEXT NOT NULL CHECK (length(stripe_subscription_item_id) > 0),
  stripe_observed_quantity        INTEGER CHECK
                                      (stripe_observed_quantity IS NULL OR stripe_observed_quantity >= 0),
  idempotency_key                 TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
  attempts                        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code                      TEXT CHECK (error_code IS NULL OR length(error_code) > 0),
  next_attempt_at_ms              INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0),
  created_at_ms                   INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms                   INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  stripe_applied_at_ms            INTEGER CHECK (stripe_applied_at_ms IS NULL OR stripe_applied_at_ms >= 0),
  completed_at_ms                 INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
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
  )
);

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

CREATE TABLE org_seat_billing_lease (
  installation_id  INTEGER PRIMARY KEY CHECK (installation_id > 0),
  lease_token      TEXT NOT NULL CHECK (length(lease_token) > 0),
  acquired_at_ms   INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  expires_at_ms    INTEGER NOT NULL CHECK (expires_at_ms > acquired_at_ms),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id)
);

CREATE INDEX idx_org_seat_billing_lease_expiry
  ON org_seat_billing_lease(expires_at_ms);
