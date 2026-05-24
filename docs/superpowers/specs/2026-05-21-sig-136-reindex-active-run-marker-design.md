# SIG-136 — Fix indexer re-index via an active-run marker

**Status:** Design approved (founder approved fix approach 2026-05-21).
**Ticket:** [SIG-136](https://linear.app/sigilix/issue/SIG-136) (High, Bug, Sigilix Engine).
**Found by:** Codex design review of SIG-131, verified by tracing the bootstrap path.
**Unblocks:** SIG-131 (its flag→`CHUNKER_VERSION`→re-index rollout depends on re-index working).

## Problem

The codebase indexer (live in prod since 2026-05-21) **cannot re-index a repo
after its first successful index**. Traced root cause:

1. Bootstrap reads the manifest + `isManifestFresh` (`indexer.ts:457-459`). On a
   new push (new `headSha` → new `runId`) the manifest is **not** fresh → the
   bootstrap proceeds to re-index.
2. `persistVectorIds` (`:536`) runs **before** the new manifest is written
   (`persistManifest` at `:565` / chain end). It reads the manifest (`:997`) →
   `currentManifestRunId` = the **old** run's id.
3. `computeMerge` (`repo-index-vectors.ts:236`): existing vectors are the old
   run (`cur.runId !== runId`), and `currentManifestRunId(old) !== runId(new)` →
   `stale-skip`.
4. `indexer.ts:540` returns without re-indexing (`index-job-skip-stale-bootstrap`).

The freshness gate says "re-index" but the merge tiebreaker says "stale, skip,"
because the merge expects the manifest to already name the current run — yet the
manifest is only updated to the new run **after** `persistVectorIds`.

Latent because SIG-132 (key→`owner/repo`, 2026-05-20) made the *first* index
under the new key look `missing`→`created`; the bug fires on the **next** push
to any already-indexed repo.

## Fix: a per-repo run LEASE, claimed before persisting

A new lightweight KV record is a **lease** on the in-progress run, claimed
**before** `persistVectorIds`. `computeMerge` and the chain's side-effect steps
(enqueue-next-shard, manifest-write) all consult it, so a re-index is recognized
as authoritative and a stale/redelivered/superseded run is rejected at every
write point — not just the vector merge. Chunking, embedding, manifest
schema/totals, and freshness semantics are untouched.

**Lease semantics (per Codex concurrency review):** claim-required (throws →
queue-retry on KV failure), **never explicitly cleared** (a slow old run must
not delete a newer run's lease), refreshed each shard, and validated before
every persist/enqueue. TTL is the only reclaim mechanism. This is best-effort KV
coordination — sufficient here because the queue's per-repo dedup already makes
truly-concurrent index runs rare; the lease closes the clobber window rather
than providing DO-grade serialization.

### Approaches considered

| Approach | Verdict |
|---|---|
| **Active-run marker KV key** (chosen) | Robust for re-index + redelivery + concurrency; doesn't perturb manifest freshness/totals; reusable for SIG-131's multi-shard run-config. Codex-recommended. |
| Claim via early manifest write | Rejected — entangles run-claim with the manifest's totals/freshness; a mid-chain failure leaves a "claims-indexed" manifest with stale totals. |
| Pass freshness verdict into computeMerge | Rejected — can't distinguish a redelivered old bootstrap from a genuinely-new run without a persisted claim (fragile vs the concurrency criterion). |

## Components

### 1. New module `src/lib/repo-index-active-run.ts`

Mirrors `repo-index-manifest.ts`'s serdes style. Key
`repo-index-active-run:${indexNamespace(owner, repo)}` (reuse `indexNamespace`).

```typescript
interface RepoIndexActiveRunV1 { v: 1; runId: string; startedAt: string }

// Claim/refresh the lease. THROWS on KV write failure so the caller can
// distinguish "couldn't claim → retry" from "yielded to newer run → ack-skip".
writeActiveRun(env, owner, repo, runId): Promise<void>
readActiveRunId(env, owner, repo): Promise<string | null>   // null on missing/invalid/parse-fail
activeRunKey(owner, repo): string                            // exported for the delete path
// NOTE: no clearActiveRun — see §5 (Codex HIGH). The lease expires by TTL only.
```

- **TTL** ~1h, refreshed on every shard (a multi-shard chain mustn't lose the
  lease mid-run). A marker older than TTL is from a crashed run; the next
  bootstrap **overwrites** it. TTL is the *only* reclaim path.
- `readActiveRunId` returns `null` for missing / invalid-JSON / wrong-version
  (fail safe → treated as "no claim" → conservative `stale-skip`).

### 2. Bootstrap claim + per-shard refresh (`indexer.ts`)

- **Bootstrap** (`:536`, before `persistVectorIds`): `await writeActiveRun(env,
  owner, repo, runId)`. **NOT best-effort** — `writeActiveRun` throws on KV
  failure, so the bootstrap throws → the queue retries the job. (A silent
  `stale-skip` would `ack` the message and lose the run — see Error handling.)
- **Continuation shard** (`:680`, before `persistVectorIds`): first read the
  lease. If owned by a *different* run → **abort** (this chain was superseded).
  Else **refresh** it (`writeActiveRun(runId)` extends the TTL) and proceed. A
  shard only ever refreshes a lease it still owns (or that's absent).

### 3. `computeMerge` — lease-gated merge (`repo-index-vectors.ts`)

`MergeArgs.currentManifestRunId` → `activeRunId: string | null`. **The lease
mismatch is checked FIRST** (Codex MED) so a stale run can't `create` /
`invalid-overwrite` when a newer run owns the lease:

```text
if activeRunId !== null && activeRunId !== runId → stale-skip   (a different run owns the lease)
existing missing  → created
existing invalid  → invalid-overwrite
cur.runId === runId → extended                                  (continuation shard of THIS run)
activeRunId === runId → superseded                              (this run owns the lease — FIXES re-index)
else → stale-skip                                               (no claim + different stored run — conservative)
```

`persistVectorIds` (`:994`) reads `activeRunId` via `readActiveRunId` instead of
the manifest runId (the `:997-999` `currentManifestRunId` read is removed) and
passes it to `computeMerge`.

### 4. Finalization guard — gate enqueue + manifest on the lease (Codex HIGH)

The lease must gate the chain's *side effects*, not only the vector merge.
Before **`enqueueNextShard`** (`:551`, `:700`) and before **`persistManifest`**
(single-shard `:565` + the multi-shard final write), re-read the lease and
**abort (write nothing, enqueue nothing) unless it is absent or equals this
`runId`.** Without this, run1 could merge, run2 could claim+complete, and run1
could still enqueue a stale shard or overwrite the manifest with a stale run.

### 5. No explicit clear; uninstall delete

- **Never `clearActiveRun`** (Codex HIGH): a slow old run finishing after run2
  claimed could delete run2's lease → run2 reads `null` → stale-skips against
  run1's vectors. Reclaim is by **overwrite (next bootstrap) + TTL** only.
- **Uninstall delete (`index-delete.ts`):** add `activeRunKey(owner, repo)` to
  the delete set. **No legacy bare-repo shape** (Codex LOW — the key is brand
  new; no pre-existing bare-key markers exist to strand).

## Data flow

```text
bootstrap (freshness=stale) → writeActiveRun(runId=NEW) [throws→retry on fail] → persistVectorIds
  computeMerge: cur.runId(OLD) !== NEW; activeRunId(NEW) === NEW → SUPERSEDED ✅ (was stale-skip ✗)
  → finalization guard (lease === NEW) → enqueue next shard / persistManifest
continuation shard → read lease; owned by other → ABORT; else refresh → cur.runId === runId → extended
chain end → persistManifest (lease still NEW) → NO clear (TTL reclaims)
redelivered OLD bootstrap → lease=NEWER ≠ oldRunId → stale-skip + finalization-guard abort ✅
concurrent run2 → writeActiveRun(run2) overwrites lease → run1's later merges AND its
  enqueue/manifest writes all abort (lease=run2 ≠ run1) ✅
```

## Error handling / edge cases

- **`writeActiveRun` fails → THROWS** → the shard throws → the queue **retries**
  (distinct from `stale-skip`, which `ack`s and would lose the run). Claim
  failure must never silently `stale-skip`.
- `readActiveRunId` missing/invalid → `null` → conservative `stale-skip` /
  finalization-guard proceeds only when lease is absent-or-mine.
- **Lease never cleared** → no risk of an old finalizer deleting a newer lease.
  A crashed run's lease is reclaimed by the next bootstrap's overwrite + TTL.
- **Lease refreshed per shard** → a long multi-shard chain won't lose its lease
  to TTL mid-run; a shard refreshes only a lease it still owns (else it aborts).
- First re-index after deploy: lease key starts absent. The bootstrap writes it
  before `persistVectorIds`, so the very first re-index reads its own claim →
  `superseded`. **No migration needed.**

## Testing

- **Repro test (the bug):** `computeMerge` with `existing` = ok/old-runId,
  incoming new `runId`, `activeRunId = newRunId` → asserts `superseded`. (Under
  the pre-fix `currentManifestRunId`-tiebreaker this path returned `stale-skip`,
  so the test reproduces the bug and passes only after the fix.)
- `computeMerge`: lease-mismatch (`activeRunId` set & ≠ runId) → stale-skip even
  when `existing` is missing/invalid (gates create/overwrite); `activeRunId ===
  runId` + ok/old → superseded; `+ missing` → created; `cur.runId === runId` →
  extended; `activeRunId = null` + different stored run → stale-skip.
- active-run serdes: write/read round-trip (+TTL), missing → null, invalid-JSON
  → null, wrong-version → null, key shape. (No `clearActiveRun` exists.)
- **Finalization guard** (pure helper): `shouldFinalize(activeRunId, runId)` —
  true when `activeRunId` is null or === runId; false otherwise. Unit-tested,
  then asserted at the enqueue + manifest call sites.
- `index-delete`: the active-run key (new shape only) is in the delete set.
- Build gate: `npm run build` (tsc + eslint + full vitest).

## Scope boundaries

- **Worker indexer only.** The retired off-Worker CLI path is out of scope.
- No manifest schema change, no chunker change, no embedding change.
- Does not implement SIG-131's multi-shard chunker-config capture — but the
  active-run marker is the primitive SIG-131 will extend (it can later carry
  `chunkerVersion`).
