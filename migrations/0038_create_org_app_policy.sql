-- Per-org APP on/off policy — the user's choice of which Sigilix surfaces they run.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`.
--
-- ⚠️ ABSENCE MEANS ENABLED. Read this before writing a query against it.
-- This table is SPARSE: a row exists only once an admin has explicitly changed an
-- app's state. No row = the app is ON. That is the opposite of org_skill_policy
-- (0017), which is an INSTALL model where absence means not-installed — and it is
-- deliberate: this table ships to orgs that already run these apps, so a
-- default-off reading would silently switch off every customer's PR reviews the
-- moment the migration lands. Any consumer that treats a missing row as "off" is
-- wrong. See resolveOrgAppPolicy for the single place that decision is encoded.
--
-- WHAT THIS IS NOT — three neighbouring concepts it must not be confused with:
--   1. ENTITLEMENT ("your tier doesn't include Slack"). That's features/entitlements,
--      keyed off tenant.tier, and it is OUR restriction. This table is the CUSTOMER's
--      choice. The UI has to tell those apart, so they stay separate columns of truth:
--      an org can be entitled-and-off, or unentitled-and-on (the latter still blocked).
--   2. CONNECTED ("Slack OAuth is installed"). Connection lives in slack_workspace /
--      linear_connection / the GitHub installation. Turning an app OFF here is
--      NON-DESTRUCTIVE by design — tokens are untouched and the org can flip it back
--      on without re-doing OAuth. Disconnecting remains a separate, destructive act.
--   3. Per-repo `sigilix.json` config and the per-PR `pr-paused:` KV switch. Those are
--      narrower scopes that already exist; this is the org-wide layer above them.
--
-- Stores policy only: no tokens, no customer prompts, no repo content.
CREATE TABLE org_app_policy (
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  -- Product-facing app id. Kept snake_case to match EntitledFeature naming
  -- ('ci_triage', 'cli_byok') so the two vocabularies read as siblings.
  -- ⚠️ This list duplicates ORG_APP_IDS in src/features/org-apps/domain/types.ts and
  -- SQLite cannot ALTER a CHECK. Adding a 7th app means a table-rebuild migration —
  -- and if you add it to the TS union only, writes fail with reason:"error", which
  -- looks exactly like a D1 outage. A drift test asserts the two lists stay equal.
  app_id          TEXT    NOT NULL CHECK (app_id IN ('pr_review', 'slack', 'linear', 'cli', 'chat', 'ci_triage')),
  enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  -- Optimistic concurrency, mirroring org_skill_policy + the MCP grant policy: a PUT
  -- carries the version it read, so two admins racing in the portal can't silently
  -- clobber each other.
  version         INTEGER NOT NULL CHECK (version > 0),
  updated_by      TEXT    NOT NULL,
  updated_at_ms   INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (installation_id, app_id)
);

-- NO extra index on purpose. The per-org read (`WHERE installation_id = ?`) is a
-- prefix of the PRIMARY KEY, so SQLite's implicit sqlite_autoindex already serves it
-- — verified with EXPLAIN QUERY PLAN. A separate index on (installation_id) would be
-- a second B-tree maintained on every write for zero read benefit. (org_skill_policy
-- DOES carry an explicit index because its shape is not a PK prefix.)
