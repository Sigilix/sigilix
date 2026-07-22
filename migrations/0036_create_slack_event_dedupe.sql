-- SIG-546: atomic Slack event_id dedupe. Replaces the KV GET-then-PUT claim
-- (which lacks compare-and-set) with a D1 unique-constraint claim so genuinely
-- concurrent deliveries of the same Slack event_id cannot both schedule work.
-- Forward-only; apply before the webhook change ships:
--   wrangler d1 migrations apply sigilix-platform
--
-- The claim is an INSERT ... ON CONFLICT(event_id) DO NOTHING: exactly one
-- delivery gets 1 row affected (the winner), every other gets 0 (a duplicate).
-- `event_id` stores the team-scoped key "<team_id>:<event_id>" to preserve the
-- prior KV claim's scoping. `created_at` is ISO-8601, used for TTL-style purge.

PRAGMA foreign_keys = ON;

CREATE TABLE slack_event_dedupe (
  event_id   TEXT NOT NULL PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Age-based cleanup of claimed events (the KV path used a 24h TTL). A scheduled
-- purge deletes rows older than a retention window; this index keeps it cheap.
CREATE INDEX idx_slack_event_dedupe_created_at ON slack_event_dedupe (created_at);
