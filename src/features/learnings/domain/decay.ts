// Activity-aware decay eligibility (Phase-1 of the Memory Gardener arc).
//
// Pure domain logic: given a memory's taxonomy fields + the closure clock of
// the PR it is anchored to, decide whether the Gardener's decay pass may reap
// it. The gate is deliberately conservative — the ONLY entries it ever touches
// are ephemeral memories whose anchoring PR closed longer ago than the window.
// Every ambiguous or missing signal (legacy record, open/unknown PR, a durable
// type, a non-PR anchor) resolves to KEEP. Reaping a real convention is a
// recall regression; missing a stale ephemeral is merely a delayed tidy-up, so
// the asymmetry is always biased toward keep.
//
// Domain-layer contract: NO env, NO IO, NO clock, NO network. The `nowMs` and
// `prClosedAtMs` non-deterministic inputs are injected by the (adapter) caller.

import type { LearningEntry, LearningMemoryType } from "./types"

/** Decay clock: an ephemeral memory's anchoring PR must have been closed for
 *  strictly MORE than this many days before the memory becomes reap-eligible. */
export const MEMORY_DECAY_WINDOW_DAYS = 21

/** The two transient taxonomy tiers the decay pass may reap. The two durable
 *  tiers (`durable_preference`, `architectural_fact`) are NEVER eligible. */
export const EPHEMERAL_MEMORY_TYPES: ReadonlySet<LearningMemoryType> = new Set<LearningMemoryType>([
  "ephemeral_project",
  "transient_feedback",
])

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whether a memory is eligible for the Gardener's activity-aware decay reap.
 *
 * @param entry          the memory's taxonomy fields (`type` + `lifespanAnchor`).
 * @param prClosedAtMs   the anchoring PR's closure timestamp in epoch ms, or
 *                       `null` for open / unknown / any lookup failure — the
 *                       ONLY per-PR signal the decision needs.
 * @param nowMs          the current wall clock in epoch ms (injected).
 *
 * Eligible ONLY when ALL hold: the entry carries the taxonomy fields, its type
 * is an ephemeral tier, its anchor is a `pr`, the PR has a known closure time,
 * and that closure is more than `MEMORY_DECAY_WINDOW_DAYS` ago. Anything else
 * keeps.
 */
export function isMemoryDecayEligible(
  entry: Pick<LearningEntry, "type" | "lifespanAnchor">,
  prClosedAtMs: number | null,
  nowMs: number,
): boolean {
  // Legacy record (written before the taxonomy fields existed) — fail-safe keep.
  if (entry.type === undefined || entry.lifespanAnchor === undefined) return false
  // Durable tiers (durable_preference / architectural_fact) NEVER decay.
  if (!EPHEMERAL_MEMORY_TYPES.has(entry.type)) return false
  // Only a PR anchor carries a closure signal. "durable" never decays; a
  // "branch" anchor has no closure signal wired yet (dead path today) — keep.
  if (entry.lifespanAnchor.kind !== "pr") return false
  // Open / unknown / API error — fail-safe keep.
  if (prClosedAtMs === null) return false
  const ageDays = (nowMs - prClosedAtMs) / MS_PER_DAY
  return ageDays > MEMORY_DECAY_WINDOW_DAYS
}
