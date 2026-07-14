// Memory Gardener — memory-consolidation pass (Gardener P2 of the dynamic-memory
// moat). Runs on the SAME 6h cron as the decay pass (its OWN independent
// `ctx.waitUntil` block in `scheduled()`, gated ONLY by its own mode-check —
// never by the indexer gate).
//
// Bounded KV scan of `learnings:*` stores. Per store: skip stores with < 3
// TYPED entries (legacy/untyped records are never consolidated — a moat guard),
// runtime-embed the remaining rules in ONE Workers-AI batch, cluster the
// near-duplicates in-memory (O(n^2) cosine, threshold 0.85, >= 3 members), and
// for each cleared cluster ENQUEUE a `consolidate-cluster` Queue job. The tick
// itself makes NO LLM call — the single Gardener call happens in the Queue
// consumer (`memory-consolidate-cluster.ts`), off the cron's isolate. A
// suppress+require cluster is deterministically rejected here and never enqueued.
//
// Default OFF (mode unset) returns immediately with ZERO side effects — no KV
// read, no embed, no enqueue — so prod is byte-identical until an operator opts
// in. Fail-soft throughout (per-key + per-store try/catch, like the decay pass):
// one bad key/store/embed counts as an error and is logged, never aborting the
// tick.

import {
  CONSOLIDATE_MIN_CLUSTER_SIZE,
  CONSOLIDATE_SIMILARITY_THRESHOLD,
  clusterBySimilarity,
  isDurableConsolidationCandidate,
  loadLearnings,
  parseLearningsKey,
  resolveClusterConflict,
  resolveMemoryConsolidateMode,
  type MemoryConsolidateMode,
} from "@/src/features/learnings"
import { embedTexts } from "@/src/shared/adapters/model"
import type { JobMessage } from "@/src/shared/types/job"
import type { Env } from "@/src/shared/types/env"
import { writeConsolidationDigestHalf, type ConsolidateCandidateSample } from "./memory-gardener-digest"

/** Max active `learnings:` keys visited per tick (lexicographic from the start;
 *  no cross-tick cursor). A truncated scan is logged, never silent. */
export const MAX_CONSOLIDATE_KEYS_PER_TICK = 200

/** Max stores actually EMBEDDED per tick (each embed is one Workers-AI batch
 *  call). Once reached, further stores are skipped this tick (deferred, logged). */
export const MAX_EMBED_STORES_PER_TICK = 25

const LEARNINGS_PREFIX = "learnings:"

export interface MemoryConsolidateSummary {
  mode: MemoryConsolidateMode
  /** `learnings:` keys parsed + loaded this tick. */
  keysScanned: number
  /** Entries iterated across all loaded stores. */
  entriesScanned: number
  /** Stores that had >= 3 typed entries and were embedded + clustered. */
  storesEmbedded: number
  /** Clusters found at >= minClusterSize before the polarity guard. */
  clustersFound: number
  /** Clusters rejected by the deterministic suppress+require guard (never enqueued). */
  clustersConflicted: number
  /** `consolidate-cluster` jobs enqueued (clean clusters). */
  clustersEnqueued: number
  /** Caught per-key/per-store errors (each logged; store skipped). */
  errors: number
  /** The KV key-list was truncated at the per-tick cap. */
  keyListTruncated: boolean
  /** The per-tick embed cap was hit; some stores were skipped (deferred). */
  embedCapReached: boolean
}

export async function runMemoryConsolidatePass(env: Env): Promise<MemoryConsolidateSummary> {
  const mode = resolveMemoryConsolidateMode(env)
  const summary: MemoryConsolidateSummary = {
    mode,
    keysScanned: 0,
    entriesScanned: 0,
    storesEmbedded: 0,
    clustersFound: 0,
    clustersConflicted: 0,
    clustersEnqueued: 0,
    errors: 0,
    keyListTruncated: false,
    embedCapReached: false,
  }
  // Load-bearing "default OFF = prod unchanged": no KV read, no embed, no log.
  if (mode === "off") return summary

  const candidateSamples: ConsolidateCandidateSample[] = []

  const listed = await env.OPENCLAW_STATE.list({
    prefix: LEARNINGS_PREFIX,
    limit: MAX_CONSOLIDATE_KEYS_PER_TICK,
  })
  if (!listed.list_complete) {
    summary.keyListTruncated = true
    console.log(
      JSON.stringify({
        event: "memory-consolidate-tick-truncated",
        reason: "key-list",
        keysScanned: listed.keys.length,
      }),
    )
  }

  let embedCapSkipped = 0

  for (const key of listed.keys) {
    // Per-key fail-soft: one bad key can't abort the tick.
    try {
      const parsedKey = parseLearningsKey(key.name)
      if (parsedKey === null) continue // e.g. a `learnings-archive:` key never matches this prefix anyway
      const { scope, subjectId } = parsedKey
      summary.keysScanned += 1
      const store = await loadLearnings(env, scope, subjectId)
      if (store === null) continue
      summary.entriesScanned += store.entries.length

      // Only DURABLE-tier records are consolidation candidates. Legacy (untyped)
      // AND ephemeral-tier records are excluded — the canonical is always durable,
      // so merging ephemerals would launder a decay-reapable memory into an
      // immortal one (see isDurableConsolidationCandidate). Moat guard.
      const candidates = store.entries.filter(isDurableConsolidationCandidate)
      if (candidates.length < CONSOLIDATE_MIN_CLUSTER_SIZE) continue

      if (summary.storesEmbedded >= MAX_EMBED_STORES_PER_TICK) {
        summary.embedCapReached = true
        embedCapSkipped += 1
        continue // deferred this tick (not embedded)
      }

      const vectors = await embedTexts(
        env.AI,
        candidates.map((e) => e.rule),
      )
      summary.storesEmbedded += 1

      const clusters = clusterBySimilarity(candidates, vectors, {
        threshold: CONSOLIDATE_SIMILARITY_THRESHOLD,
        minClusterSize: CONSOLIDATE_MIN_CLUSTER_SIZE,
      })

      for (const cluster of clusters) {
        summary.clustersFound += 1
        const resolution = resolveClusterConflict(cluster)
        if (resolution.kind === "polarity-conflict") {
          summary.clustersConflicted += 1
          console.log(
            JSON.stringify({
              event: "memory-consolidate-cluster-conflicted",
              scope,
              subjectId,
              size: cluster.length,
              polarities: resolution.polarities,
              memberIds: cluster.map((e) => e.id),
            }),
          )
          continue
        }

        const memberIds = cluster.map((e) => e.id)
        const message: JobMessage = { type: "consolidate-cluster", scope, subjectId, memberIds }
        await env.OPENCLAW_JOBS.send(message)
        summary.clustersEnqueued += 1

        if (candidateSamples.length < 100) {
          candidateSamples.push({
            scope,
            subjectId,
            size: cluster.length,
            memberIds,
            preferredRule: resolution.preferred.rule,
          })
        }
        console.log(
          JSON.stringify({
            event: "memory-consolidate-cluster-enqueued",
            scope,
            subjectId,
            size: cluster.length,
            memberIds,
          }),
        )
      }
    } catch (err) {
      summary.errors += 1
      console.error(JSON.stringify({ event: "memory-consolidate-key-error", key: key.name, error: errorMessage(err) }))
    }
  }

  if (summary.embedCapReached) {
    console.log(
      JSON.stringify({
        event: "memory-consolidate-tick-truncated",
        reason: "embed-cap",
        storesSkipped: embedCapSkipped,
        cap: MAX_EMBED_STORES_PER_TICK,
      }),
    )
  }

  // Founder visibility (see memory-gardener-digest.ts): write the consolidation
  // half with the summary + the candidate clusters this tick enqueued.
  await writeConsolidationDigestHalf(env, {
    ranAt: new Date().toISOString(),
    mode,
    summary: { ...summary },
    candidateSamples,
  })

  console.log(JSON.stringify({ event: "memory-consolidate-complete", ...summary }))
  return summary
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
