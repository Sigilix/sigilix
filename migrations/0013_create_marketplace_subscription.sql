-- sig-github-marketplace-billing — GitHub Marketplace subscription record, keyed by the
-- GitHub ACCOUNT (org/user) that bought the plan. Two jobs:
--   1. Purchase-before-install: a `marketplace_purchase` can arrive BEFORE the App is
--      installed, so there is no `tenant` row (no installation_id) to write a tier onto
--      yet. We stash the purchase here keyed by account, then reconcile it onto the
--      tenant when `installation.created` later fires for that same account.
--   2. Source of record: kept updated on every purchased/changed/cancelled event so the
--      account's current Marketplace plan is always recoverable independently of the
--      tenant row.
--
-- Forward-only; immutable once applied (COMPLIANCE.md §8). Applied via
-- `wrangler d1 migrations apply <db>` — NOT auto on deploy. Additive only (new table).
--
-- account_id  — GitHub's immutable numeric account id (PK; stable across account rename).
-- account_login — the account's login at the time of the event (mutable; indexed so the
--                 install-time reconcile, which only carries account.login, can find it).
-- tier        — the resolved Sigilix tier (free/pro/teams/max/ultra) for this plan.
-- seats       — unit_count from the purchase (relevant for the per-seat Teams plan); NULL
--               when the plan carries no unit count.
-- status      — 'active' (purchased/changed) | 'canceled' (cancelled).
-- updated_at  — ISO timestamp of the last event applied.
CREATE TABLE marketplace_subscription (
  account_id     INTEGER PRIMARY KEY,
  account_login  TEXT    NOT NULL,
  tier           TEXT    NOT NULL,
  seats          INTEGER,
  status         TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX idx_marketplace_subscription_login ON marketplace_subscription(account_login);
