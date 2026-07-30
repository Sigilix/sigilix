-- Repo-history ingestion lease — strongly-consistent coordinator for the one-time
-- history backfill (commit messages + human PR review discussion → `history:` corpus).
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`.
--
-- WHY D1 AND NOT THE KV GUARD PATTERN: the PR-corpus backfill guard (KV,
-- multi-corpus-backfill-guard.ts) is a binary run-once marker, and two independent
-- reviews converged on why that shape must NOT be copied here:
--   1. A history backfill spans MULTIPLE queue invocations (it is sharded), so a
--      binary claim with a stale window mis-fires on a legitimately long run. This
--      lease carries a PROGRESS CURSOR and is renewed per shard.
--   2. KV get-then-put has no CAS and is eventually consistent — acceptable when a
--      duplicate run costs cents, not for the biggest embed job in the system. D1
--      claims are atomic (`INSERT ... ON CONFLICT ... WHERE`, meta.changes = winner).
--   3. run-once-LOSSY is the wrong contract: a hole in commit history never refills
--      (there is no per-merge upsert for the past). This lease is RUN-UNTIL-COMPLETE:
--      a failed shard expires the lease and the retry RESUMES FROM THE CURSOR.
--
-- Keyed on lowercased owner/repo, NOT the immutable repo id — deliberately matching
-- the corpus namespace (`history:owner/repo`), which is name-keyed like `pr:`. A
-- renamed repo gets a new namespace and genuinely must re-backfill; an id-keyed
-- lease would wrongly block that.
--
-- ⚠️ Lease lifecycle is coupled to the corpus lifecycle: today neither the
-- `history:` vectors nor this row are purged on uninstall — the same accidentally-
-- consistent state as the pre-existing `pr:`/`issue:` GDPR gap. Fix BOTH together
-- (namespace purge + lease delete) in the GDPR ticket; fixing one without the other
-- leaves reinstall either re-billing or permanently skipping.
CREATE TABLE history_ingest_lease (
  owner               TEXT    NOT NULL,
  repo                TEXT    NOT NULL,
  installation_id     INTEGER NOT NULL CHECK (installation_id > 0),
  status              TEXT    NOT NULL CHECK (status IN ('running', 'complete')),
  -- Fencing token: every mutation is `WHERE lease_token = ?`, so a shard that lost
  -- its lease (isolate killed, expired, taken over) cannot clobber the successor.
  lease_token         TEXT    NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms >= 0),
  -- Progress cursor: merged-PR-list index already fully processed. A takeover
  -- RESUMES here rather than restarting the embed from the top.
  cursor              INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  docs_done           INTEGER NOT NULL DEFAULT 0 CHECK (docs_done >= 0),
  -- Embedding fingerprint: a deliberate model/dim migration legitimately restarts
  -- the backfill (old vectors are not interchangeable).
  model_id            TEXT    NOT NULL,
  embedding_dim       INTEGER NOT NULL CHECK (embedding_dim > 0),
  started_at_ms       INTEGER NOT NULL CHECK (started_at_ms >= 0),
  updated_at_ms       INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  completed_at_ms     INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  PRIMARY KEY (owner, repo)
);
