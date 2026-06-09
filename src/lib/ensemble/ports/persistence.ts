// Port: the typed KV-persistence obligations the PR-review ensemble's finalize
// path owes — the review-provenance manifest, the per-day budget counter, and
// the SLO/FP-rate telemetry record. Modeled as DOMAIN obligations (not a raw KV
// surface): the KV namespace, the reverse-ts key derivation + TTL, and the
// `env` binding all stay adapter-internal. The adapter (PR 11) holds `env` (+ a
// `GitHubClient` for the manifest's file-list fetch) and implements these. Types
// only; the manifest finding shape is a pure leaf in `@/lib/review-manifest`.
//
// COUPLING NOTE (reported): `ReviewManifestFinding` lives in the `@/lib/review-
// manifest` sibling. It is a pure interface (primitive fields only), so importing
// it type-only here is faithful; when the manifest types are lifted to a leaf
// (`domain/` or `@/shared/types`), this port should import from there instead.

import type { ReviewManifestFinding } from "@/lib/review-manifest"

/**
 * The telemetry record `finalize` persists for the FP-rate ruler + SLO surface.
 * The adapter reads ONLY `owner`/`repo`/`prNumber` (to build the reverse-ts KV
 * key) and stringifies the whole record verbatim — it never branches on any
 * other field — so the orchestrator's private `EnsembleTelemetry` object is
 * carried through structurally + runtime-identically by passing it where this
 * narrow shape is expected.
 *
 * SIG-363 DEVIATION (reported): the original spec called for
 * `{ owner; repo; prNumber } & Record<string, unknown>`, but the orchestrator's
 * `EnsembleTelemetry` is an `interface` (no implicit index signature), and an
 * interface is NOT assignable to `Record<string, unknown>` (TS2345 at the
 * `finalize` call site). The narrow shape below is what the adapter actually
 * needs, IS assignable from `EnsembleTelemetry`, and stays runtime-identical.
 */
export type EnsembleTelemetrySummary = {
  owner: string
  repo: string
  prNumber: number
}

export interface EnsemblePersistencePort {
  /**
   * Best-effort write of the review-provenance manifest (ARC-184). Captures the
   * head/base/merge-base SHAs, the file-list hash, the prompt version, the model
   * id, and the target review id. Write failures degrade gracefully — never
   * block the review flow. Skipped when `OPENCLAW_REVIEW_MANIFEST_ENABLED=off`.
   */
  writeReviewManifest(args: {
    owner: string
    repo: string
    prNumber: number
    headSha: string
    baseSha: string
    modelId: string
    reviewId: number
    /** ARC-271: per-finding snapshot for the next push's delta computation.
     *  Optional — when absent or empty, the manifest omits the `findings`
     *  field and the next review surfaces no delta. */
    findings?: ReviewManifestFinding[]
  }): Promise<void>

  /** Add `by` to today's cumulative model-call count (`ensemble-budget:<day>`). */
  incrementDailyBudget(by: number): Promise<void>

  /**
   * Persist the review's SLO / FP-rate telemetry record under the reverse-ts
   * `ensemble-review-telemetry:` key. Best-effort — a failed write is logged,
   * never thrown into the review flow.
   */
  writeTelemetry(telemetry: EnsembleTelemetrySummary): Promise<void>
}
