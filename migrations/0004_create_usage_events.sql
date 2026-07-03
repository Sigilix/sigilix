-- SIG-303 full usage metering — the surface-agnostic usage event ledger.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only — does not touch 0001/0002/0003.
--
-- WHY a new table (vs a `kind` column on usage_ledger): usage_ledger's identity
-- columns (installation_id, repo_id, pr_number, head_sha) are GitHub-PR-shaped and
-- NOT NULL, with a UNIQUE keyed on those four. The new meters (coding_agent,
-- chatbot, slack, linear_triage) have no PR/repo/head_sha; their identity is
-- (meter, user_key/installation_id, optional event_id). Widening usage_ledger to
-- nullable would weaken the PR-review dedup constraint. A sibling table keeps each
-- meter's rolling-window counts independent without touching the PR-review schema.
--
-- TWO INDEPENDENT POOLS (SIG-303 model):
--   • ORG pool  (single shared org limit) — org AUTOMATION surfaces. Meters:
--       - pr_reviews   → READ from usage_ledger (0001); NOT written here.
--       - linear_triage→ written here (installation-keyed mirror; the team-keyed
--                         triage_usage_ledger (0002) stays the triage rate-limit
--                         source of truth — this row is the org-pool USAGE mirror,
--                         keyed by installation so the installation-scoped org read
--                         is uniform).
--       - slack        → written here.
--     ORG-pool events set installation_id (the org key). user_key records WHO
--     triggered it (per-person breakdown) but the event draws the ORG limit.
--   • SEAT pool (per-dev, independent) — a dev's DIRECT personal use. Meters:
--       - coding_agent → written here (CLI coding-agent runs via the gateway).
--       - chatbot      → written here (portal chat + deep-research).
--     SEAT-pool events set user_key (the seat key). installation_id is context
--     only; a seat event NEVER draws the org pool and vice versa.
--
-- installation_id = 0 means "no org context" (e.g. a portal-session seat event that
-- is not repo-scoped). user_key = NULL means the acting seat could not be attributed
-- (e.g. a per-installation CLI API key with no user link — a documented gap).
CREATE TABLE usage_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  meter            TEXT    NOT NULL,               -- 'coding_agent'|'chatbot'|'slack'|'linear_triage'
  installation_id  INTEGER NOT NULL DEFAULT 0,     -- org key (0 = no org context)
  user_key         TEXT,                           -- seat key ('gh:<id>' | 'slack:<id>'); NULL = unattributable
  surface          TEXT    NOT NULL,               -- 'cli'|'portal'|'slack'|'linear'
  event_id         TEXT,                           -- idempotency handle; NULL = no dedup
  created_at       TEXT    NOT NULL
);
-- ORG-pool rollups: WHERE meter = ? AND installation_id = ? AND created_at >= ?
CREATE INDEX idx_usage_events_org ON usage_events(meter, installation_id, created_at);
-- SEAT-pool rollups: WHERE meter = ? AND user_key = ? AND created_at >= ?
CREATE INDEX idx_usage_events_seat ON usage_events(meter, user_key, created_at);
-- Idempotent redelivery dedup on keyed events only (NULL event_id rows are never deduped).
CREATE UNIQUE INDEX idx_usage_events_dedup ON usage_events(meter, event_id) WHERE event_id IS NOT NULL;
