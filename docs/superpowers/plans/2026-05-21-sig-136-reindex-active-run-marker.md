# SIG-136 Re-index Active-Run Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the indexer so a repo re-indexes on subsequent pushes (it currently `stale-skip`s after its first index), via a per-repo run lease claimed before persisting and validated at every write point.

**Architecture:** A new `repo-index-active-run.ts` KV lease (claim-required, never cleared, TTL-reclaimed). `computeMerge` gates on the lease (mismatch → stale-skip, checked first); the indexer claims the lease at bootstrap, refreshes it per shard, and re-checks it before enqueuing a shard or writing the manifest (the finalization guard).

**Tech Stack:** TypeScript, Cloudflare Workers (KV), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-sig-136-reindex-active-run-marker-design.md`

**Verified facts (do not re-derive):**
- `computeMerge(args: MergeArgs): MergeOutcome` at `repo-index-vectors.ts:202`. `MergeArgs.currentManifestRunId: string | null` (`:182`). `MergeOutcome` actions: `created | extended | superseded | stale-skip{existingRunId} | invalid-overwrite` (`:164-168`). `ReadResult` (from `repo-index-manifest.ts`) is `{kind:"ok",vectors}|{kind:"missing"}|{kind:"invalid",...}` for vectors (see `readRepoIndexVectors`).
- `persistVectorIds` at `indexer.ts:994`; reads the manifest at `:997-999` for `currentManifestRunId`; returns `{proceed:boolean}`. Called at `:536` (bootstrap, `isBootstrap:true`) and `:680` (continuation, `isBootstrap:false`).
- Bootstrap: `persistVectorIds` `:536` → if `!proceed` return `:540`; multi-shard `enqueueNextShard` `:551`; single-shard `persistManifest` `:565`. Continuation: `persistVectorIds` `:680` → if `!proceed` return `:686`; final-shard `persistManifest` `:700`; non-final `enqueueNextShard` (just after the `:697` `if (shard.hi >= shard.totalFiles)` block — re-anchor).
- `indexNamespace(owner, repo)` + the manifest serdes pattern live in `repo-index-manifest.ts` (KV via `env.OPENCLAW_STATE`, `expirationTtl`, V1 shape + `parse*` validators). Mirror it for the new module.
- `index-delete.ts` imports `repoIndexManifestKey`/`legacyRepoIndexManifestKey` etc. and deletes them per repo.
- Repo uses `noUncheckedIndexedAccess`. Tests in `tests/`, Vitest. Full gate: `npm run build` (tsc + eslint + vitest). There IS an existing `tests/repo-index-vectors.test.ts` that constructs `MergeArgs` — it must be updated when the field is renamed.

---

## File Structure

- **Create** `src/lib/repo-index-active-run.ts` — the lease: key, V1 shape, `writeActiveRun` (throws), `readActiveRunId`, `shouldFinalize`. Pure serdes + one KV write/read.
- **Create** `tests/repo-index-active-run.test.ts`.
- **Modify** `src/lib/repo-index-vectors.ts` — `MergeArgs.currentManifestRunId` → `activeRunId`; lease-gated branch order.
- **Modify** `tests/repo-index-vectors.test.ts` — rename field in fixtures + the repro + lease tests.
- **Modify** `src/lib/indexer.ts` — claim at bootstrap, refresh + pre-check per continuation shard, read lease in `persistVectorIds`, finalization guard at enqueue/manifest sites.
- **Modify** `src/lib/index-delete.ts` — delete the active-run key on uninstall.
- **Modify** `tests/index-delete.test.ts` (or wherever the delete is tested) — assert the key is deleted.

---

## Task 1: `repo-index-active-run.ts` lease module

**Files:** Create `src/lib/repo-index-active-run.ts`, `tests/repo-index-active-run.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest"
import {
  activeRunKey,
  writeActiveRun,
  readActiveRunId,
  shouldFinalize,
} from "../src/lib/repo-index-active-run"

function kvMock(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    OPENCLAW_STATE: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
      delete: vi.fn(async (k: string) => { store.delete(k) }),
    },
  } as any
}

describe("activeRunKey", () => {
  it("keys by lowercased owner/repo namespace", () => {
    expect(activeRunKey("Arc-and-Anchor", "Sigilix")).toBe("repo-index-active-run:arc-and-anchor/sigilix")
  })
})

describe("writeActiveRun / readActiveRunId", () => {
  it("round-trips the runId", async () => {
    const env = kvMock()
    await writeActiveRun(env, "o", "r", "run-1")
    expect(await readActiveRunId(env, "o", "r")).toBe("run-1")
  })
  it("readActiveRunId returns null on missing / invalid JSON / wrong version", async () => {
    expect(await readActiveRunId(kvMock(), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": "not json" }), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": JSON.stringify({ v: 2, runId: "x" }) }), "o", "r")).toBeNull()
  })
  it("writeActiveRun THROWS on KV put failure (so the caller can retry)", async () => {
    const env = kvMock()
    env.OPENCLAW_STATE.put = vi.fn(async () => { throw new Error("kv down") })
    await expect(writeActiveRun(env, "o", "r", "run-1")).rejects.toThrow()
  })
})

describe("shouldFinalize", () => {
  it("true when the lease is absent or equals this run; false when another run owns it", () => {
    expect(shouldFinalize(null, "run-1")).toBe(true)
    expect(shouldFinalize("run-1", "run-1")).toBe(true)
    expect(shouldFinalize("run-2", "run-1")).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/repo-index-active-run.test.ts`).

- [ ] **Step 3: Implement** — create `src/lib/repo-index-active-run.ts`:

```typescript
// SIG-136: per-repo run LEASE for the indexer. Claimed at bootstrap BEFORE
// persistVectorIds so a re-index (new runId) is recognized as authoritative
// instead of stale-skipped, and a redelivered/superseded run is rejected at
// every write point. Lease semantics: claim-required (writeActiveRun THROWS on
// KV failure → queue retry), NEVER explicitly cleared (a slow old run must not
// delete a newer run's lease), reclaimed by overwrite (next bootstrap) + TTL.

import type { Env } from "../index"
import { indexNamespace } from "./repo-index-manifest"

const KV_KEY_PREFIX = "repo-index-active-run:"
// A run is capped at the queue's 15-min wall-clock; 1h covers a multi-shard
// chain (refreshed per shard) and self-heals a crashed run via the next
// bootstrap's overwrite. TTL is the ONLY reclaim path.
const TTL_SECONDS = 60 * 60

export interface RepoIndexActiveRunV1 {
  v: 1
  runId: string
  startedAt: string
}

export function activeRunKey(owner: string, repo: string): string {
  return `${KV_KEY_PREFIX}${indexNamespace(owner, repo)}`
}

/**
 * Claim/refresh the lease. THROWS on KV write failure so the caller can
 * distinguish "couldn't claim → retry the job" from "yielded to a newer run →
 * ack-skip". Overwrites unconditionally (last-writer-at-claim wins); the
 * caller is responsible for only claiming when it still owns / is starting the
 * run.
 */
export async function writeActiveRun(
  env: Env,
  owner: string,
  repo: string,
  runId: string,
): Promise<void> {
  const record: RepoIndexActiveRunV1 = { v: 1, runId, startedAt: new Date().toISOString() }
  await env.OPENCLAW_STATE.put(activeRunKey(owner, repo), JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  })
}

/** The current lease holder's runId, or null (missing / invalid / wrong-version). */
export async function readActiveRunId(env: Env, owner: string, repo: string): Promise<string | null> {
  const raw = await env.OPENCLAW_STATE.get(activeRunKey(owner, repo))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (o.v !== 1 || typeof o.runId !== "string" || o.runId.length === 0) return null
  return o.runId
}

/**
 * The finalization-guard predicate: a run may persist its merge / write the
 * manifest / enqueue the next shard only when the lease is absent (TTL-expired,
 * treated as "no competing owner") or names this run. A lease owned by a
 * DIFFERENT run means this run was superseded → must abort.
 */
export function shouldFinalize(activeRunId: string | null, runId: string): boolean {
  return activeRunId === null || activeRunId === runId
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/lib/repo-index-active-run.ts tests/repo-index-active-run.test.ts
git commit -m "feat(sig-136): repo-index-active-run lease module (claim/read/shouldFinalize)"
```

---

## Task 2: `computeMerge` lease-gating

**Files:** Modify `src/lib/repo-index-vectors.ts`, `tests/repo-index-vectors.test.ts`.

- [ ] **Step 1: Write the failing test** — add to `tests/repo-index-vectors.test.ts` (and you will rename `currentManifestRunId` → `activeRunId` in the existing fixtures in Step 3):

```typescript
// SIG-136 repro: re-index (existing OLD run vectors, incoming NEW run) must
// SUPERSEDE when this run holds the lease — not stale-skip.
it("supersedes when the active-run lease names the incoming run (SIG-136 re-index)", () => {
  const existing = { kind: "ok", vectors: { v: 1, owner: "o", repo: "r", runId: "old", byPath: { "a.ts": ["id1"] } } } as const
  const out = computeMerge({
    existing, owner: "o", repo: "r", runId: "new",
    idsByPathSlice: { "a.ts": ["id2"] },
    activeRunId: "new",
  })
  expect(out.action).toBe("superseded")
})

it("stale-skips when a DIFFERENT run holds the lease (redelivery / superseded)", () => {
  const existing = { kind: "ok", vectors: { v: 1, owner: "o", repo: "r", runId: "old", byPath: { "a.ts": ["id1"] } } } as const
  const out = computeMerge({
    existing, owner: "o", repo: "r", runId: "old",
    idsByPathSlice: { "a.ts": ["id1"] },
    activeRunId: "newer",
  })
  expect(out.action).toBe("stale-skip")
})

it("lease mismatch stale-skips even when existing is MISSING (gates create)", () => {
  const out = computeMerge({
    existing: { kind: "missing" }, owner: "o", repo: "r", runId: "run-1",
    idsByPathSlice: { "a.ts": ["id1"] },
    activeRunId: "run-2",
  })
  expect(out.action).toBe("stale-skip")
})

it("creates when existing missing and the lease is ours (or absent)", () => {
  const out = computeMerge({
    existing: { kind: "missing" }, owner: "o", repo: "r", runId: "run-1",
    idsByPathSlice: { "a.ts": ["id1"] },
    activeRunId: "run-1",
  })
  expect(out.action).toBe("created")
})

it("extends a continuation shard of the same run regardless of lease", () => {
  const existing = { kind: "ok", vectors: { v: 1, owner: "o", repo: "r", runId: "run-1", byPath: { "a.ts": ["id1"] } } } as const
  const out = computeMerge({
    existing, owner: "o", repo: "r", runId: "run-1",
    idsByPathSlice: { "b.ts": ["id2"] },
    activeRunId: "run-1",
  })
  expect(out.action).toBe("extended")
})
```

- [ ] **Step 2: Run → FAIL** (`activeRunId` not on `MergeArgs`).

- [ ] **Step 3: Implement** in `src/lib/repo-index-vectors.ts`:

3a. Rename the `MergeArgs` field (`:176-182`): replace the `currentManifestRunId` field + its doc comment with:
```typescript
  /**
   * SIG-136: the current run-lease holder's runId (from `readActiveRunId`),
   * or null. Authoritative tiebreaker: a lease owned by a DIFFERENT run means
   * this slice is from a superseded/redelivered run and must be rejected.
   */
  activeRunId: string | null
```

3b. Replace the body of `computeMerge` (`:202-247`) — destructure `activeRunId` and check the lease mismatch FIRST:
```typescript
export function computeMerge(args: MergeArgs): MergeOutcome {
  const { existing, owner, repo, runId, idsByPathSlice, activeRunId } = args
  const sliceByPath = normalizeByPath(idsByPathSlice)

  // SIG-136: a lease owned by a DIFFERENT run supersedes this slice — reject
  // BEFORE create/overwrite so a stale run can't clobber a newer run's data.
  if (activeRunId !== null && activeRunId !== runId) {
    return { action: "stale-skip", existingRunId: existing.kind === "ok" ? existing.vectors.runId : "" }
  }

  if (existing.kind === "missing") {
    return { action: "created", vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: sliceByPath } }
  }
  if (existing.kind === "invalid") {
    return { action: "invalid-overwrite", vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: sliceByPath } }
  }

  const cur = existing.vectors
  if (cur.runId === runId) {
    // Same run — continuation shard extending the existing record.
    return {
      action: "extended",
      vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: setUnion(cur.byPath, sliceByPath) },
    }
  }
  // Different stored run. This run holds the lease (mismatch already rejected
  // above) ⇒ it is authoritative ⇒ supersede. If the lease is null (TTL gap)
  // and the stored run differs, stay conservative and skip.
  if (activeRunId === runId) {
    return { action: "superseded", vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: sliceByPath } }
  }
  return { action: "stale-skip", existingRunId: cur.runId }
}
```

- [ ] **Step 4: Keep the tree tsc-green.** Renaming the `MergeArgs` field breaks the one `computeMerge` call site in `indexer.ts` `persistVectorIds` (`:1001`, still passing `currentManifestRunId:`). In THIS task, rename only the **key** there (`currentManifestRunId: currentManifestRunId` → `activeRunId: currentManifestRunId`), leaving the value expression (the manifest read) unchanged — Task 3 swaps the value to `readActiveRunId`. Then update every `currentManifestRunId:` in `tests/repo-index-vectors.test.ts` to `activeRunId:` (semantics map directly — the old field WAS the would-be lease).

- [ ] **Step 5: Verify + Commit.** `npx vitest run tests/repo-index-vectors.test.ts` → PASS; `npx tsc --noEmit` → clean (the call-site rename keeps it green).

```bash
git add src/lib/repo-index-vectors.ts tests/repo-index-vectors.test.ts src/lib/indexer.ts
git commit -m "fix(sig-136): computeMerge gates on the run lease (mismatch-first; supersede when owned)"
```

---

## Task 3: Wire the lease into the indexer

**Files:** Modify `src/lib/indexer.ts`.

> Read `indexer.ts:404-720` and `:990-1050` first to re-anchor the bootstrap, continuation-shard, `persistVectorIds`, `persistManifest`, and `enqueueNextShard` call sites.

- [ ] **Step 1: Imports.** Add:
```typescript
import { writeActiveRun, readActiveRunId, shouldFinalize } from "./repo-index-active-run"
```

- [ ] **Step 2: A local finalization-guard helper.** Near the other indexer helpers, add:
```typescript
/** SIG-136: true iff this run still owns the lease (or it's absent) and may
 *  proceed to persist a manifest / enqueue the next shard. */
async function leaseAllows(env: Env, owner: string, repo: string, runId: string): Promise<boolean> {
  return shouldFinalize(await readActiveRunId(env, owner, repo), runId)
}
```

- [ ] **Step 3: `persistVectorIds` reads the lease.** In `persistVectorIds` (`:994`), replace the manifest read (`:997-999`):
```typescript
  const manifestRead = await readRepoIndexManifest(env, owner, repo)
  const currentManifestRunId =
    manifestRead.kind === "ok" ? manifestRead.manifest.runId : null
```
with:
```typescript
  const activeRunId = await readActiveRunId(env, owner, repo)
```
and update the `computeMerge({ ... })` call in this function to pass `activeRunId` instead of `currentManifestRunId`. Update the `repo-index-vectors-stale-skip` log field accordingly (`current_manifest_run_id` → `active_run_id: activeRunId`). Remove the now-unused `readRepoIndexManifest` import only if nothing else in the file uses it (it's used by the freshness gate at `:457`, so KEEP the import).

- [ ] **Step 4: Bootstrap claims the lease.** In the bootstrap, immediately BEFORE the `persistVectorIds(... isBootstrap:true)` call (`:536`), add:
```typescript
    // SIG-136: claim the run lease BEFORE persisting so computeMerge recognizes
    // this (re-)index as authoritative. Throws on KV failure → queue retries.
    await writeActiveRun(env, owner, repo, runId)
```

- [ ] **Step 5: Continuation shard checks + refreshes the lease.** In the continuation path, immediately BEFORE the `persistVectorIds(... isBootstrap:false)` call (`:680`), add:
```typescript
    // SIG-136: a continuation shard proceeds only if it still owns the lease
    // (or the lease is absent/TTL-expired and no newer run claimed it); then
    // refresh the TTL so a long chain doesn't lose the lease mid-run.
    if (!(await leaseAllows(env, owner, repo, shard.runId))) {
      console.warn(JSON.stringify({
        event: "index-job-skip-superseded-shard",
        owner, repo, run_id: shard.runId, lo: shard.lo, hi: shard.hi,
      }))
      return
    }
    await writeActiveRun(env, owner, repo, shard.runId)
```

- [ ] **Step 6: Finalization guard at the enqueue + manifest sites.** Before EACH of these, insert the guard (use the run's id — `runId` in the bootstrap, `shard.runId` in the continuation):
  - Bootstrap multi-shard `enqueueNextShard` (`:551`).
  - Bootstrap single-shard `persistManifest` (`:565`).
  - Continuation final-shard `persistManifest` (`:700`).
  - Continuation non-final `enqueueNextShard` (just after the `if (shard.hi >= shard.totalFiles)` block).

  The guard (bootstrap variant shown; use `shard.runId` in continuation):
```typescript
    if (!(await leaseAllows(env, owner, repo, runId))) {
      console.warn(JSON.stringify({
        event: "index-job-skip-superseded-finalize",
        owner, repo, run_id: runId,
      }))
      return
    }
```
  Place it so a `return` cleanly abandons the chain (no manifest write, no enqueue). Do NOT guard the warmup-rerun fan-out — that's best-effort post-success.

- [ ] **Step 7: Verify.** `npx tsc --noEmit` → clean. `npm run build` → PASS (tsc + eslint + full vitest; existing indexer tests must stay green — if any construct `computeMerge` args or stub `persistVectorIds`'s manifest read, update them to the lease).

- [ ] **Step 8: Commit**
```bash
git add src/lib/indexer.ts
git commit -m "fix(sig-136): claim+refresh run lease; gate merge, enqueue, and manifest on it"
```

---

## Task 4: Delete the lease on uninstall

**Files:** Modify `src/lib/index-delete.ts`, its test file.

- [ ] **Step 1: Write the failing test.** In the index-delete test, after a `deleteRepoIndex(owner, repo, ...)`, assert the active-run key was deleted:
```typescript
it("deletes the active-run lease key on uninstall", async () => {
  const env = makeEnv({ /* seed with an active-run key — match the test's existing env builder */ })
  await env.OPENCLAW_STATE.put("repo-index-active-run:o/r", JSON.stringify({ v: 1, runId: "x", startedAt: "t" }))
  await deleteRepoIndex(env, "o", "r", "install-deleted") // match the real signature
  expect(await env.OPENCLAW_STATE.get("repo-index-active-run:o/r")).toBeNull()
})
```
(Adapt the env builder + `deleteRepoIndex` signature to the existing test's helpers.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In `src/lib/index-delete.ts`: import `activeRunKey` from `./repo-index-active-run`, and in `deleteRepoIndex` add a best-effort delete of `activeRunKey(owner, repo)` alongside the manifest/vectors key deletes (new shape only — no legacy bare key, the marker is brand new):
```typescript
  await env.OPENCLAW_STATE.delete(activeRunKey(owner, repo))
```
Place it with the other KV key deletes; it's idempotent (missing key = no-op).

- [ ] **Step 4: Run → PASS; then `npm run build` → PASS.**
- [ ] **Step 5: Commit**
```bash
git add src/lib/index-delete.ts tests/index-delete.test.ts
git commit -m "fix(sig-136): delete the active-run lease key on uninstall"
```

---

## Post-implementation (not part of the TDD loop)

- **Code review:** `code-reviewer` + `typescript-pro`; the `computeMerge` lease state-machine + the indexer guard wiring → `verify-algo` + a Codex conformance pass (Codex designed the lease — confirm the implementation matches: no clear, mismatch-first, throw-on-claim-fail, guard at all 4 enqueue/manifest sites + the continuation pre-check).
- **CodeRabbit** at phase end before the PR.
- **Rollout:** ships always-on (it's a correctness fix, not flag-gated — the broken re-index is strictly worse than the fixed one). No migration: the lease key starts absent and is written on the next bootstrap.
- **Verify in prod after merge:** push twice to an indexed repo (or re-push) and confirm via `wrangler tail` that the second push logs `repo-index-vectors-write-ok action=superseded` (not `index-job-skip-stale-bootstrap`).
- **Unblocks SIG-131.** The lease is the primitive SIG-131 extends for multi-shard chunker-config capture.
- **PR:** branch `sig-136`; `Closes SIG-136`; In Progress at start, In Review on PR open.
