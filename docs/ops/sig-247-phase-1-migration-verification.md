# SIG-247 Phase 1 — review-memory migration verification

Post-migration runbook for `POST /admin/migrate-review-memory-to-repo-id`.
DeepSeek-v4-pro's algorithmic consult flagged Cloudflare KV's eventual
consistency: a single point-in-time read is NOT sufficient to assert
"no signal lost". Run the verification 3× with 30 s gaps and only
treat a mismatch as a true loss when it persists across all three.

## Pre-flight (do BEFORE invoking the migration)

1. **Take a legacy snapshot per install.** For each installation ID,
   list every `review-memory:*` key under the LEGACY prefix and sum
   `signals[]` lengths:
   ```bash
   wrangler kv key list --binding OPENCLAW_STATE --prefix 'review-memory:' \
     | jq -r '.[].name' \
     | grep -Ev '^review-memory:repo:' \
     | while read -r key; do
         wrangler kv key get --binding OPENCLAW_STATE "$key" \
           | jq '.signals | length'
       done | awk '{ sum += $1 } END { print "legacy_total_signals:", sum }'
   ```
   Record the total. This is the floor `new_total` must clear.

2. **Take a "commentId → legacy_key" sample for forensic checks.**
   For a few representative records (1–5 per category), record the
   set of `commentId` values present. After migration these must all
   appear in the new key's `signals[]`.

3. **Optional dry-run.** Invoke with `?dryRun=true` to confirm the
   migration's read-phase reports the expected counts without
   actually writing:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $OPENCLAW_ADMIN_TOKEN" \
     "$WORKER_URL/admin/migrate-review-memory-to-repo-id?installationId=N&dryRun=true"
   ```
   Expect `recordsWritten` ≈ legacy record count and `signalsCopied`
   ≈ `legacy_total_signals` minus any dual-write-already-landed
   duplicates.

## Migration

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_ADMIN_TOKEN" \
  "$WORKER_URL/admin/migrate-review-memory-to-repo-id?installationId=N"
```

Response is a JSON `MigrateMemoryInstallSummary`. Per-repo `outcomes[]`
carry one of:
- `migrated` — records written to the new keyspace
- `already-migrated` — every new-key record already carries `migratedAt`
- `no-legacy-records` — repo has no review-memory state at the legacy prefix
- `github-404` — repo deleted on GitHub between install snapshot and migration
- `github-no-id` — GitHub API responded without a positive integer `id`
- `github-error` — transient API failure; re-run on those repos
- `kv-error` — KV read/write failure mid-record; re-run safely

Per-repo errors do NOT abort the batch. Re-run on `failed` repos using
the same endpoint (idempotent).

## Post-migration verification (3× stable)

For each install where migration succeeded:

1. **Read both keyspaces.** Sum `signals[]` lengths across:
   - Legacy prefix `review-memory:<owner>/<repo>:*`
   - New prefix `review-memory:repo:<id>:*`

2. **Assert invariants.**
   - `new_total >= legacy_pre_migration_total` (because Phase 1 PR A
     dual-write keeps adding to new beyond the snapshot moment)
   - For every `commentId` in the pre-flight sample (step 2 above),
     confirm it appears in the corresponding new-key record's
     `signals[]`

3. **Repeat 3 times with 30 s gaps.** A single iteration is
   insufficient: Cloudflare KV is eventually consistent + dual-write
   captures continue landing. Treat a mismatch as a true loss ONLY if
   it persists across all three runs.

   ```bash
   for i in 1 2 3; do
     echo "iteration $i:"
     ./scripts/verify-review-memory-migration.sh "$INSTALLATION_ID"
     [ $i -lt 3 ] && sleep 30
   done
   ```

   *(verification script can be implemented when needed; the manual
   wrangler commands above suffice for first cutover.)*

## What "good" looks like

- `MigrateMemoryInstallSummary.failed === 0`
- `signalsCopied >= legacy_total_signals` from pre-flight
- Every per-repo outcome is `migrated`, `already-migrated`, or
  `no-legacy-records`
- 3× stable verification: `new_total` non-decreasing across the three
  iterations (it may INCREASE — that's just additional dual-write
  captures landing during the 60 s verification window)

## What "bad" looks like (action required)

- `failed > 0` → re-run; check the per-repo `outcomes` `detail` field
- Any `github-error` → wait 60 s for GitHub API to recover, re-run
- A specific `commentId` from the pre-flight sample missing from the
  new key after all 3 iterations → genuine signal loss; file as a
  follow-up incident with the install id + repo + commentId. Phase 5
  cleanup must NOT proceed until this is reconciled.

## Known minor race (low probability, low impact)

If a repo's UNIONED signal count exceeds `SIGNAL_FIFO_CAP=50` AND a
concurrent Phase 1 PR A capture lands a 51st-newest signal between
the migration's read and put, the migration's put will clobber it.
The cap means the OLDEST signal is the loss, not the freshest —
activation thresholds use the 90-day window, so the lost signal was
unlikely to be load-bearing. Re-running migration after the canary
window closes (zero `dual-write-partial` rate) absorbs any
accumulated divergence.

## Phase 5 prerequisites (out of scope for this runbook)

Phase 5 cleanup deletes the legacy `review-memory:<owner>/<repo>:*`
keys + drops the legacy-read path in `readMemory`. Do NOT run Phase 5
cleanup until:

1. This runbook's 3× stable verification has passed for EVERY install
2. The `review-memory-dual-write-partial` + `review-memory-dual-write-failed`
   telemetry rates are <1% over a 7-day window (see canary metrics
   from PR A's `review-memory-capture-written` event)
3. A final union-backfill (re-running this same endpoint) closes any
   accumulated divergence from partial-write outcomes

References:
- [SIG-247 EPIC](https://linear.app/sigilix/issue/SIG-247)
- [SIG-250 — Phase 1 sub-issue](https://linear.app/sigilix/issue/SIG-250)
- DeepSeek-v4-pro algorithmic consult Q5 (verification methodology)
