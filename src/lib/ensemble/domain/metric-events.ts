// SIG-363: the metric-event vocabulary the PR-review orchestrator emits, lifted
// out of the metrics Durable Objects so the sink ports (`ports/sinks.ts`) and
// the orchestrator can reference these event shapes without importing the
// `@/do/*` infra layer (which would invert the dependency rule). The DOs that
// consume each event re-export it, so existing importers (the dispatcher in
// `src/index.ts`, the god-file, the metrics clients) are unchanged.
//
// Domain leaf: the only outward references are the pure vocabulary leaves
// `@/shared/domain/finding-category` and `@/lib/dismiss-reasons` (both
// primitive-only, no env / network) — the same lateral the sibling domain gates
// already take.

import type { FindingCategory } from "@/src/shared/domain/finding-category"
import type { DismissReason } from "@/src/lib/dismiss-reasons"

/**
 * One validator-gate rejection (the shape the ensemble collects + forwards).
 *
 * SIG-173: discriminated union — `"gate-rejection"` is the existing
 * shadow/enforce telemetry the validator gates push; `"dismissal-reason"`
 * is the per-reason rollup written when `@sigilix dismiss <reason>`
 * succeeds in `github-mention.ts`. Both flow through the same DO so a
 * single endpoint surface can serve both rollups, and the `daily_counts`
 * table is the natural place for the per-reason counter
 * (gate = `"dismissal"`, reason = `<DismissReason>`, kept = 0).
 */
export type ValidationRejectionEvent =
  | {
      kind: "gate-rejection"
      gate: string
      reason: string
      /** true = actually dropped (enforce mode); false = would-drop (shadow). */
      dropped: boolean
      /**
       * SIG-245: the rejected finding's own category (logic/security/
       * performance/testing/…), distinct from `gate` (the validator that
       * fired). The gate×category split surfaces the meta-FP class — e.g. the
       * security gate firing on a `testing`/`docs`-category finding — that a
       * gate-only rollup can't see. Optional: absent on gates with no finding
       * in scope (the verification re-anchor/refuted gates). Typed to the
       * canonical `FindingCategory` so callers can't pass a typo'd bucket; the
       * record path also trims defensively (the event crosses an RPC boundary).
       */
      category?: FindingCategory
    }
  | {
      kind: "dismissal-reason"
      reason: DismissReason
    }

/** One PR review's graph-retrieval measurement (mirrors the logged event). */
export interface GraphRetrievalSample {
  /** effective graph-retrieval mode: "shadow" | "post". */
  mode: string
  jaccard: number
  addedCount: number
  nodeCount: number
  cappedNodeCount: number
  blastCallerCount: number
  blastDependentCount: number
}

/** One PR review's graph-expansion measurement (mirrors the logged event). */
export interface GraphExpansionSample {
  /** effective graph-expansion mode: "shadow" | "post". */
  mode: string
  graphAvailable: boolean
  /** treatment − control: the cross-file context gain the GO/KILL keys off. */
  netNewTokens: number
  /** filesByPath-only tokens (what PR1 saw, no cross-file fetch). */
  controlTokens: number
  /** treatment total tokens (control + cross-file). */
  totalTokens: number
  fetchEnabled: boolean
  fetchFiles: number
  fetchBytes: number
  fetchElapsedMs: number
  budgetExhausted: boolean
}
