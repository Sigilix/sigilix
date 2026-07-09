-- sig-cost-based-metering — add per-event tokens + model COST (USD) to usage_events.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only.
--
-- Why: usage_events (the SIG-303 seat/org pools — coding_agent = CLI, chatbot =
-- deep-research/chat, slack, linear_triage) recorded ONLY that an event happened,
-- with no token or cost data. The CLI and chatbot are the EXPENSIVE surfaces, so
-- without these columns cost-based caps and credit-burn projection on those
-- surfaces are impossible. These columns let the write paths record the model
-- spend of each event and the read side SUM it per window (mirrors usage_ledger).
--
-- Both DEFAULT 0: a surface that has not yet been wired to report usage (or an
-- event whose usage is unknown, e.g. a torn stream) records 0 — a 0 never inflates
-- a window's spend against a budget, so it fails SAFE (can only under-count).
-- `tokens` is INTEGER (whole tokens); `cost_usd` is REAL (fractional USD).
ALTER TABLE usage_events ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
