-- SIG-606 — the finding event log: durable, APPEND-ONLY outcome instrumentation.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only.
--
-- ⚠️ APPEND-ONLY. NO TTL. NO UPDATE. Read this before touching it.
--
-- WHY this table exists at all: before it, NOTHING in this system durably recorded
-- a per-finding outcome. Every mechanism that could have accumulated was built as a
-- CACHE and self-deleted:
--   • Trust Ledger (verification-metrics DO) — daily_counts(day, verdict, category),
--     35-day retention. A COUNTER. No finding id, no PR, no anchor. And `verdict`
--     there is Sigilix's self-assessment of its own grounding, NOT an outcome.
--   • review-withdrawal-store (KV) — the richest artifact (a HUMAN dismissal, with
--     reason) and it self-deletes after 30 days; it is a suppression cache.
--   • precision-profile (KV) — folds outcomes into an EMA float per pattern hash,
--     destroying the individual events on write. 90-day TTL.
-- So the labels a review generates flowed through the system and evaporated. This
-- table is the fix, and the ONE rule that makes it work is that rows are only ever
-- INSERTed. An UPDATE of an outcome column would destroy the timeline — exactly the
-- mistake the precision-profile EMA already makes. Outcomes are APPENDED as new
-- rows. Do NOT add a TTL, a GC alarm, or an UPDATE path. Do NOT copy the KV cache
-- pattern here.
--
-- WHAT IT RECORDS: one row per CANDIDATE finding — posted AND suppressed. Logging
-- only the posted set would bake CENSORED SAMPLING in permanently: we could never
-- evaluate our own gates against outcomes, and any future model trained on it would
-- inherit today's gate blind spots as ground truth.
--
-- ⚠️ PRIVACY / SCOPE (deliberate, do not "improve" without counsel):
-- This table stores STRUCTURAL METADATA ONLY — category, score, anchor, gate,
-- reason, and content-derived hashes. It deliberately stores NO `headline`, NO
-- `body`, and NO diff hunk, because those are customer-source-derived. The R2
-- training store is intentionally unprovisioned and per-org training consent is
-- fail-closed (see src/features/training-consent/); this table is a different
-- system on a different legal basis: PRODUCT-QUALITY TELEMETRY over our own
-- structural metrics, in D1 — NOT a training corpus in object storage. It is NOT
-- wired to SIGILIX_TRAINING_RETENTION_MODE and must not be.
--
-- JOIN KEY: (installation_id, repo_id, pr_number, head_sha) matches usage_ledger's
-- UNIQUE, so per-review cost/tokens are JOINed, never duplicated here. Caveat:
-- usage_ledger is deduped per head_sha, so a re-review of the same head yields one
-- ledger row but N finding-event batches — cost granularity is per-REVIEW, not per-run.
CREATE TABLE finding_event (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- identity / join key (matches usage_ledger UNIQUE)
  installation_id     INTEGER NOT NULL,
  repo_id             INTEGER NOT NULL DEFAULT 0,   -- 0 = legacy message without repo.id
  pr_number           INTEGER NOT NULL,
  head_sha            TEXT    NOT NULL,
  -- finding identity. finding_key is computed at push time (sha over category+path+
  -- headline) so an early-stage candidate that never got a contentFingerprint is
  -- still joinable across stages. content_fingerprint is NULL when not yet assigned.
  finding_key         TEXT    NOT NULL,
  content_fingerprint TEXT,
  -- structural attributes (NO headline / NO body — see PRIVACY above)
  category            TEXT,
  score               INTEGER,                      -- severity 1-5
  confidence          INTEGER,                      -- model self-report 1-5
  gate_score          REAL,                         -- calibrated 0-1
  path                TEXT,
  line                INTEGER,
  start_line          INTEGER,
  source_specialists  TEXT,                         -- csv; NULL when unknown at this stage
  trust_tier          TEXT,                         -- NULL unless trust ledger on AND survived
  -- what happened
  -- CHECK constraints on the LABEL columns are deliberate here (usage_events has
  -- none). SQLite cannot ALTER TABLE ADD CONSTRAINT, so a CHECK is now-or-never:
  -- adding one later needs a 12-step table rebuild, which collides with both
  -- forward-only migrations and the append-only rule. A typo'd label ('posted_inline',
  -- 'dropped') would otherwise write silently and be indistinguishable from a real
  -- label on read — and mislabeling is precisely the failure this table exists to
  -- prevent. The writer's per-statement fallback means a rejected row costs one row,
  -- not the review's whole batch.
  stage               TEXT    NOT NULL               -- 'validator'|'render-prep'|'verification'|'publish'
                        CHECK (stage IN ('validator', 'render-prep', 'verification', 'publish')),
  gate                TEXT,                         -- e.g. 'diff-consistency'; NULL for a plain posted row
  reason              TEXT,                         -- per-gate reason string
  -- ⚠️ `enforced` is ENFORCE-vs-SHADOW (did the gate actually act), NOT
  -- posted-vs-suppressed. Most gates default to shadow, so a gate row with
  -- enforced=0 was still POSTED. `outcome` is the reconciled truth — it is derived
  -- against the FINAL posted set, never read off the gate callback. Reading
  -- `enforced` as suppression is the easiest way to corrupt this corpus.
  enforced            INTEGER NOT NULL DEFAULT 0    -- 0|1
                        CHECK (enforced IN (0, 1)),
  outcome             TEXT    NOT NULL               -- see CHECK; reconciled, never read off a gate flag
                        CHECK (outcome IN ('posted-inline', 'posted-body', 'suppressed', 'unknown')),
  -- provenance (unrecoverable if not captured at write time)
  model_id            TEXT,                         -- RESOLVED id post-fallback, not the tier alias
  prompt_version      TEXT,
  inline_comment_id   INTEGER,                      -- set on posted-inline rows once stamped
  created_at          TEXT    NOT NULL
);

-- Per-review lookup (and the usage_ledger join shape).
CREATE INDEX idx_finding_event_review ON finding_event (installation_id, repo_id, pr_number, head_sha);
-- Cross-review identity: follow one finding's fate over time (the label join).
CREATE INDEX idx_finding_event_key ON finding_event (finding_key);
CREATE INDEX idx_finding_event_fingerprint ON finding_event (content_fingerprint);
-- Corpus slicing by outcome + recency.
CREATE INDEX idx_finding_event_outcome_time ON finding_event (outcome, created_at);
