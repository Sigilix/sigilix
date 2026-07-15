-- SIG — durable, installation-scoped Stripe Checkout attempt guard.
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Apply with
-- `wrangler d1 migrations apply sigilix-platform` before dependent code ships.
--
-- One current row per installation prevents concurrent upgrade requests from
-- minting multiple Stripe Checkout Sessions. The request body and idempotency
-- key are persisted byte-for-byte so a lease recovery replays the same provider
-- operation instead of creating a new one after an ambiguous response.

PRAGMA foreign_keys = ON;

CREATE TABLE stripe_checkout_attempt (
  installation_id       INTEGER PRIMARY KEY CHECK (installation_id > 0),
  attempt_id             TEXT NOT NULL UNIQUE
                              CHECK (length(attempt_id) BETWEEN 1 AND 128),
  intent_fingerprint     TEXT NOT NULL
                              CHECK (
                                length(intent_fingerprint) = 64
                                AND intent_fingerprint NOT GLOB '*[^0-9a-f]*'
                              ),
  request_body           TEXT NOT NULL CHECK (length(request_body) BETWEEN 1 AND 65536),
  idempotency_key        TEXT NOT NULL UNIQUE
                              CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  state                  TEXT NOT NULL CHECK (state IN ('creating', 'ready')),
  generation             INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  lease_token            TEXT CHECK (
                              lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128
                            ),
  lease_expires_at_ms    INTEGER CHECK (
                              lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0
                            ),
  stripe_expires_at_ms   INTEGER NOT NULL CHECK (stripe_expires_at_ms >= 0),
  replace_after_ms       INTEGER NOT NULL CHECK (replace_after_ms > stripe_expires_at_ms),
  stripe_session_id      TEXT UNIQUE CHECK (
                              stripe_session_id IS NULL OR length(stripe_session_id) > 0
                            ),
  checkout_url           TEXT CHECK (checkout_url IS NULL OR length(checkout_url) > 0),
  created_at_ms          INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms          INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  ready_at_ms            INTEGER CHECK (
                              ready_at_ms IS NULL OR ready_at_ms BETWEEN created_at_ms AND updated_at_ms
                            ),
  FOREIGN KEY (installation_id) REFERENCES tenant(installation_id),
  CHECK (
    (state = 'creating'
      AND lease_token IS NOT NULL
      AND lease_expires_at_ms IS NOT NULL
      AND lease_expires_at_ms > updated_at_ms
      AND lease_expires_at_ms <= replace_after_ms
      AND stripe_expires_at_ms > updated_at_ms
      AND stripe_session_id IS NULL
      AND checkout_url IS NULL
      AND ready_at_ms IS NULL)
    OR
    (state = 'ready'
      AND lease_token IS NULL
      AND lease_expires_at_ms IS NULL
      AND stripe_session_id IS NOT NULL
      AND checkout_url IS NOT NULL
      AND ready_at_ms IS NOT NULL
      AND ready_at_ms < stripe_expires_at_ms)
  )
);

CREATE INDEX idx_stripe_checkout_attempt_replacement
  ON stripe_checkout_attempt(state, replace_after_ms);
