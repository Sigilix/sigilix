// Memory Gardener — `consolidate-cluster` Queue consumer (Gardener P2).
//
// The consolidation TICK (`memory-consolidate.ts`) does the bounded scan + embed
// + cluster and enqueues one job per cleared cluster; THIS handler makes the
// single Gardener LLM call, off the cron's isolate. It RE-LOADS the store (the
// tick's snapshot may be stale), re-verifies the deterministic guards
// (present-count, suppress+require polarity, suppression-backdoor), runs the
// model, and — only in `enforce` with confidence >= threshold — appends ONE
// canonical rule FIRST and THEN tombstones the merged originals (reusing the
// decay pass's archive-then-remove primitive; 30-day recoverable, never a hard
// delete). In `shadow` (and on any below-threshold proposal) it writes the
// digest ONLY — no append, no archive. Fail-soft: any error logs and returns
// (the originals are always kept).

import {
  CONSOLIDATE_MIN_CLUSTER_SIZE,
  MAX_LEARNINGS,
  appendLearning,
  archiveLearningEntries,
  canonicalPolarityAllowed,
  chooseCanonicalType,
  computeLearningId,
  isDurableConsolidationCandidate,
  loadLearnings,
  resolveClusterConflict,
  resolveMemoryConsolidateMode,
  runConsolidation,
  type ConsolidationInput,
  type LearningEntry,
  type LearningScope,
  type LearningStore,
} from "@/src/features/learnings"
import type { Env } from "@/src/shared/types/env"
import { appendConsolidationProposal } from "./memory-gardener-digest"

/** Minimum Gardener self-confidence to actually collapse a cluster (enforce). */
export const CONSOLIDATE_CONFIDENCE_THRESHOLD = 0.85

export interface ConsolidateClusterJob {
  scope: LearningScope
  subjectId: string
  memberIds: string[]
}

export async function handleConsolidateClusterJob(job: ConsolidateClusterJob, env: Env): Promise<void> {
  const mode = resolveMemoryConsolidateMode(env)
  // A redelivered job after a flag flip-off must be inert.
  if (mode === "off") return

  const { scope, subjectId } = job
  try {
    const store = await loadLearnings(env, scope, subjectId)
    if (store === null) return

    // Re-pick the cluster members from the CURRENT store by id (the tick's
    // snapshot may be stale). Only entries still present are merge candidates.
    const byId = new Map(store.entries.map((e) => [e.id, e]))
    const members: LearningEntry[] = []
    for (const id of job.memberIds) {
      const entry = byId.get(id)
      // Defense-in-depth: only DURABLE-tier members are ever consolidated (the
      // tick already filters, but ids are content-addressed so a re-check is cheap
      // and keeps the "never launder ephemeral/legacy" guard local to the write).
      if (entry !== undefined && isDurableConsolidationCandidate(entry)) members.push(entry)
    }
    if (members.length < CONSOLIDATE_MIN_CLUSTER_SIZE) {
      console.log(JSON.stringify({ event: "memory-consolidate-skip", reason: "too-few-present", scope, subjectId }))
      return
    }

    // Defense-in-depth: re-run the deterministic polarity guard on the current
    // members. A suppress+require cluster is never sent to the model.
    const resolution = resolveClusterConflict(members)
    if (resolution.kind === "polarity-conflict") {
      console.log(
        JSON.stringify({
          event: "memory-consolidate-skip",
          reason: "polarity-conflict",
          scope,
          subjectId,
          polarities: resolution.polarities,
        }),
      )
      return
    }

    const inputs: ConsolidationInput[] = resolution.ordered.map((e) => ({
      id: e.id,
      rule: e.rule,
      polarity: e.polarity,
      category: e.category ?? null,
      pathGlob: e.pathGlob ?? null,
      createdTs: e.createdTs,
      appliedCount: e.appliedCount,
    }))

    const parsed = await runConsolidation(env, { cluster: inputs })
    if (parsed === null) {
      console.log(JSON.stringify({ event: "memory-consolidate-skip", reason: "model-no-verdict", scope, subjectId }))
      return
    }

    // Suppression-backdoor guard: consolidation may never MINT a new suppress.
    if (!canonicalPolarityAllowed(members, parsed.polarity)) {
      console.log(
        JSON.stringify({
          event: "memory-consolidate-skip",
          reason: "suppress-not-in-cluster",
          scope,
          subjectId,
        }),
      )
      return
    }

    const belowThreshold = parsed.confidence < CONSOLIDATE_CONFIDENCE_THRESHOLD
    const willWrite = mode === "enforce" && !belowThreshold

    let applied = false
    if (willWrite) {
      applied = await applyConsolidation(env, store, scope, subjectId, members, parsed)
    }

    await appendConsolidationProposal(env, {
      scope,
      subjectId,
      canonicalRule: parsed.canonicalRule,
      polarity: parsed.polarity,
      confidence: parsed.confidence,
      mergedIds: members.map((e) => e.id),
      applied,
      mode,
    })

    console.log(
      JSON.stringify({
        event: applied ? "memory-consolidate-applied" : "memory-consolidate-proposed",
        scope,
        subjectId,
        mode,
        confidence: parsed.confidence,
        belowThreshold,
        mergedCount: members.length,
        polarity: parsed.polarity,
      }),
    )
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "memory-consolidate-cluster-error",
        scope,
        subjectId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * Enforce write. Default ordering is append-the-canonical-FIRST, then tombstone
 * the merged originals — so a crash between the two leaves BOTH the canonical AND
 * the originals (safe/recoverable) rather than a gap.
 *
 * The ONE exception is the store-at-cap edge: `appendLearning`/`upsertEntry`
 * hard-evicts (no tombstone) the least-recently-applied entry when a new id pushes
 * the store past MAX_LEARNINGS. Since a consolidation NETS entries DOWN (add 1,
 * remove >=3), that transient overflow could permanently drop an UNRELATED memory.
 * At cap we therefore archive the members FIRST (freeing >=3 slots) so the append
 * lands without an eviction; the crash window then leaves the originals in the
 * 30-day tombstone (recoverable) — never a hard delete of a non-member.
 *
 * Returns true only when both the append AND the archive succeed.
 */
async function applyConsolidation(
  env: Env,
  store: LearningStore,
  scope: LearningScope,
  subjectId: string,
  members: ReadonlyArray<LearningEntry>,
  parsed: {
    canonicalRule: string
    polarity: LearningEntry["polarity"]
    category: LearningEntry["category"]
    pathGlob: LearningEntry["pathGlob"]
  },
): Promise<boolean> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  // canonicalRule is already normalized by parseConsolidation.
  const canonicalId = await computeLearningId(parsed.canonicalRule)

  const canonical: LearningEntry = {
    id: canonicalId,
    rule: parsed.canonicalRule,
    polarity: parsed.polarity,
    category: parsed.category ?? null,
    pathGlob: parsed.pathGlob ?? null,
    scope,
    subjectId,
    // System-authored durable rule: no originating comment. `command` is the
    // existing system-authored source kind (used by `@sigilix remember`).
    source: { kind: "command" },
    createdTs: nowIso,
    appliedCount: 0,
    type: chooseCanonicalType(members),
    lifespanAnchor: { kind: "durable" },
  }

  // Never archive the canonical itself if its content-addressed id collides with
  // a merged input (identical normalized rule) — that id upserts in place.
  const toArchive = members.filter((m) => m.id !== canonicalId)

  // At-cap edge: append-first would hard-evict a non-member. Archive first so the
  // append lands into freed space. (canonicalId already present ⇒ an upsert, no
  // growth ⇒ no eviction ⇒ keep the crash-safe append-first path.)
  const alreadyPresent = store.entries.some((e) => e.id === canonicalId)
  const wouldEvict = !alreadyPresent && store.entries.length >= MAX_LEARNINGS
  if (wouldEvict && toArchive.length > 0) {
    const archived = await archiveLearningEntries(env, scope, subjectId, toArchive, nowIso)
    if (!archived) return false
    return appendLearning(env, scope, subjectId, canonical, nowMs)
  }

  const appended = await appendLearning(env, scope, subjectId, canonical, nowMs)
  if (!appended) return false
  if (toArchive.length === 0) return true
  return archiveLearningEntries(env, scope, subjectId, toArchive, nowIso)
}
