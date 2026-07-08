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

-- Backfill EXISTING full-cap subscribers to 'active' so the trial cap does not silently
-- halve their volume the moment this migration lands. Any row already resolving to an
-- above-free cap in resolveRateLimitCap was set before trials existed (Checkout's
-- trial_period_days=14 is a separate follow-up), so it is genuinely `active` and keeps
-- FULL volume. The set + normalization here MIRROR resolveRateLimitCap EXACTLY —
-- `LOWER(TRIM(tier))` matches its `.trim().toLowerCase()` (so `MAX`/` Pro ` are covered)
-- and the list includes the legacy non-Stripe full-cap tiers (pro_plus/pro+/enterprise)
-- as well as the Stripe tiers (pro/teams/max/ultra) — otherwise those rows would fall to
-- NULL → the restrictive half cap (a regression). Still fail-safe: only rows that ALREADY
-- proved an above-free cap are marked active; free/oss/cli/default/unknown stay NULL
-- (they resolve to the Free floor either way). Idempotent + a no-op on a fresh DB.
UPDATE tenant SET subscription_status = 'active'
WHERE LOWER(TRIM(tier)) IN ('pro', 'teams', 'max', 'ultra', 'pro_plus', 'pro+', 'enterprise');
