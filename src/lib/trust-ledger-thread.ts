// SIG Trust Ledger v0 — the threading layer: attach per-finding `trust` metadata
// at the signal sites (worker-token verdict, receipt-join, the grounding demote
// reasons, the grounded-model provenance baseline) on the way to render. Pure +
// immutable here; the ensemble calls these at each site, the renderer
// (trust-ledger-render.ts) reads the result. Runtime-only — never parsed from
// model JSON.

import type { PrReviewFinding, FindingTrust, FindingTrustTier } from "./triage-pr-review"

/** PR2 flag (`OPENCLAW_TRUST_LEDGER`). `off` = attach metadata in-memory but
 *  record no telemetry + render nothing. `shadow` = attach + record the tier
 *  distribution, still render nothing. `on` = attach + record + render the
 *  Trust Summary and per-finding VERIFIED/GROUNDED/MODEL pills. */
export type TrustLedgerMode = "off" | "shadow" | "on"

export function parseTrustLedgerMode(raw: string | undefined): TrustLedgerMode {
  return raw === "shadow" || raw === "on" ? raw : "off"
}

/** A single proof signal a site can emit — just a candidate tier. A site emits
 *  the tier it justifies (e.g. the worker-token site emits `worker-token-confirmed`);
 *  `resolveTier` collapses the set to the single highest-proof tier. */
export type FindingTrustSignal = FindingTrustTier

/** An immutable trust patch from one signal site. `signals` are folded together
 *  with the finding's EXISTING tier (so a later, weaker patch can adjust the
 *  surface/reason without lowering a tier a stronger earlier signal already set). */
export interface FindingTrustPatch {
  signals?: ReadonlyArray<FindingTrustSignal | null | undefined>
  surface?: FindingTrust["surface"]
  demoteReason?: FindingTrust["demoteReason"]
}

const TIER_RANK: Record<FindingTrustTier, number> = {
  "runner-confirmed": 5,
  "deterministic-grounded": 4,
  "worker-token-confirmed": 3,
  "grounded-model": 2,
  "body-only-ungrounded": 1,
}

/**
 * Collapse a set of tier-signals to the single highest-proof tier, independent
 * of input order. Null/undefined signals are ignored (a site can pass them
 * without a guard). No positive signal → `body-only-ungrounded`.
 */
export function resolveTier(
  signals: ReadonlyArray<FindingTrustSignal | null | undefined>,
): FindingTrustTier {
  let best: FindingTrustTier = "body-only-ungrounded"
  for (const s of signals) {
    if (s && TIER_RANK[s] > TIER_RANK[best]) best = s
  }
  return best
}

/**
 * Fold a patch into a finding's prior trust → the next `FindingTrust`. The tier
 * is `resolveTier([existingTier, ...patch.signals])`, so it only ever moves UP —
 * a body demote (e.g. `verification-refuted`) can change `surface`/`demoteReason`
 * while a stronger proof tier (e.g. worker-token-confirmed) survives. `surface`
 * and `demoteReason` are preserved unless the patch supplies new values. Always
 * returns a concrete `FindingTrust` (tier never unset).
 */
function nextTrust(prev: FindingTrust | undefined, patch: FindingTrustPatch): FindingTrust {
  const tier = resolveTier([prev?.tier, ...(patch.signals ?? [])])
  const surface = patch.surface ?? prev?.surface
  const demoteReason = patch.demoteReason ?? prev?.demoteReason
  return {
    tier,
    ...(surface !== undefined ? { surface } : {}),
    ...(demoteReason !== undefined ? { demoteReason } : {}),
  }
}

/**
 * Immutably attach/merge `trust` onto a finding. Returns a NEW finding (the
 * caller swaps it into the array) so we never mutate a shared object. Use this
 * where a fresh clone is wanted; use `annotateFindingTrust` where object identity
 * must be preserved.
 */
export function mergeFindingTrust(
  finding: PrReviewFinding,
  patch: FindingTrustPatch,
): PrReviewFinding {
  return { ...finding, trust: nextTrust(finding.trust, patch) }
}

/**
 * In-place trust annotation — assigns the merged `trust` onto the finding object
 * WITHOUT cloning. Used at the ensemble's verification/demote sites where the
 * finding's object IDENTITY must survive: the SIG-285 refuted-demote set keys by
 * identity (`new Set<PrReviewFinding>(refutedInline)`) and the marker index is
 * position-aligned, so swapping an array element for a clone would break them.
 * `trust` is runtime-only additive metadata that no control flow branches on, so
 * mutating just that field in place is safe and sidesteps the identity hazards.
 */
export function annotateFindingTrust(finding: PrReviewFinding, patch: FindingTrustPatch): void {
  finding.trust = nextTrust(finding.trust, patch)
}

/** Per-review tier distribution — derived from the rendered findings for the
 *  Trust Summary + the (flag-gated) telemetry recording. */
export interface TrustTierCounts {
  runnerConfirmed: number
  deterministicGrounded: number
  workerTokenConfirmed: number
  groundedModel: number
  bodyOnlyUngrounded: number
  /** total findings counted (inline + body-only). */
  total: number
}

/** Count findings by trust tier. A finding with no `trust` counts as
 *  `body-only-ungrounded` (the renderer's MODEL pill) — the honest default. */
export function countTrustTiers(
  findings: ReadonlyArray<Pick<PrReviewFinding, "trust">>,
): TrustTierCounts {
  const counts: TrustTierCounts = {
    runnerConfirmed: 0,
    deterministicGrounded: 0,
    workerTokenConfirmed: 0,
    groundedModel: 0,
    bodyOnlyUngrounded: 0,
    total: 0,
  }
  for (const f of findings) {
    counts.total++
    switch (f.trust?.tier) {
      case "runner-confirmed":
        counts.runnerConfirmed++
        break
      case "deterministic-grounded":
        counts.deterministicGrounded++
        break
      case "worker-token-confirmed":
        counts.workerTokenConfirmed++
        break
      case "grounded-model":
        counts.groundedModel++
        break
      default:
        counts.bodyOnlyUngrounded++
    }
  }
  return counts
}
