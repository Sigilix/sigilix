-- sig-trial-cap — record the Stripe subscription STATUS on the tenant row so the
-- trial cap can halve a trialing subscriber's usage volume (while a fully paid
-- `active` subscriber keeps the full tier volume). Forward-only; immutable once
-- applied (COMPLIANCE.md §8). Applied via `wrangler d1 migrations apply <db>` —
-- NOT auto on deploy; run it BEFORE shipping the code that reads/writes the column.
--
-- Additive only: a single nullable column on the existing tenant table
-- (migrations/0001), so every existing row and the current tier UPSERT stay valid.
-- NULL = status unknown → treated RESTRICTIVELY (half volume, never full-paid) by
-- resolveRateLimitCap; the Stripe webhook overwrites it to 'active' / 'trialing' /
-- the terminal status on the next subscription.* event.
ALTER TABLE tenant ADD COLUMN subscription_status TEXT;

-- Backfill EXISTING paid subscribers to 'active' so the trial cap does not silently
-- halve their volume the moment this migration lands. A row already holding a paid tier
-- (pro/max/ultra — the only paid tiers the billing webhook writes) was set by the
-- pre-trial webhook, which granted a paid tier only for a live subscription. Trials do
-- not exist yet (Checkout's trial_period_days=14 is a separate follow-up), so every
-- current paid subscriber is genuinely `active` and keeps FULL volume. This is still
-- fail-safe: only rows that ALREADY proved a paid tier are marked active; every other
-- row (free/default/unknown) stays NULL → the restrictive half cap. Idempotent + a
-- no-op on a fresh DB.
UPDATE tenant SET subscription_status = 'active' WHERE tier IN ('pro', 'max', 'ultra');
