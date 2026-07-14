// Memory Gardener digest — a single rolling KV key that lets the founder see
// what BOTH Gardener passes (decay + consolidation) would do, WITHOUT
// `wrangler tail`. Surfaced read-only behind the org-gated admin metrics route.
//
// One key, two independently-written halves. Each write is a best-effort
// read-modify-write that PRESERVES the other half it reads. KV has no
// compare-and-swap, so two concurrent writers can lose one update (the same
// accepted caveat as `appendLearning`); this is a founder-only debug digest, so
// an occasionally-dropped sample is harmless — it never gates a review or a
// memory write. Never throws: any failure logs and returns.

import type { Env } from "@/src/shared/types/env"

export const MEMORY_GARDENER_DIGEST_KEY = "memory-gardener-digest:latest"

/** Max samples retained in each list — keep the digest small + cheap to read. */
export const MAX_DIGEST_SAMPLES = 20

export interface DecayWouldReapSample {
  scope: string
  subjectId: string
  learningId: string
  type?: string
  prNumber: number
  closedAt: string
  ageDays: number
}

export interface DecayDigestHalf {
  ranAt: string
  mode: string
  summary: Record<string, unknown>
  wouldReapSamples: DecayWouldReapSample[]
}

/** A cluster the consolidation TICK cleared + enqueued (before the LLM ran). */
export interface ConsolidateCandidateSample {
  scope: string
  subjectId: string
  size: number
  memberIds: string[]
  preferredRule: string
}

/** A consolidation PROPOSAL the Queue consumer produced (after the LLM ran). */
export interface ConsolidationProposalSample {
  scope: string
  subjectId: string
  canonicalRule: string
  polarity: string
  confidence: number
  mergedIds: string[]
  /** Was the canonical actually written + originals archived (enforce + >=0.85)? */
  applied: boolean
  mode: string
}

export interface ConsolidationDigestHalf {
  ranAt: string
  mode: string
  summary: Record<string, unknown>
  candidateSamples: ConsolidateCandidateSample[]
  proposals: ConsolidationProposalSample[]
}

export interface MemoryGardenerDigest {
  updatedAt: string
  decay?: DecayDigestHalf
  consolidation?: ConsolidationDigestHalf
}

async function loadRaw(env: Env): Promise<MemoryGardenerDigest> {
  try {
    const raw = await env.OPENCLAW_STATE.get(MEMORY_GARDENER_DIGEST_KEY)
    if (raw === null) return { updatedAt: new Date(0).toISOString() }
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MemoryGardenerDigest
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: "memory-gardener-digest-load-failed", error: errorMessage(err) }))
  }
  return { updatedAt: new Date(0).toISOString() }
}

/** Read the digest for the admin surface. Null when absent/unreadable. */
export async function loadMemoryGardenerDigest(env: Env): Promise<MemoryGardenerDigest | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(MEMORY_GARDENER_DIGEST_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as MemoryGardenerDigest
    return null
  } catch (err) {
    console.warn(JSON.stringify({ event: "memory-gardener-digest-load-failed", error: errorMessage(err) }))
    return null
  }
}

/** Write the DECAY half (preserves the consolidation half). Best-effort. */
export async function writeDecayDigestHalf(env: Env, half: DecayDigestHalf): Promise<void> {
  try {
    const current = await loadRaw(env)
    const next: MemoryGardenerDigest = {
      updatedAt: new Date().toISOString(),
      decay: { ...half, wouldReapSamples: half.wouldReapSamples.slice(0, MAX_DIGEST_SAMPLES) },
      ...(current.consolidation ? { consolidation: current.consolidation } : {}),
    }
    await env.OPENCLAW_STATE.put(MEMORY_GARDENER_DIGEST_KEY, JSON.stringify(next))
  } catch (err) {
    console.warn(JSON.stringify({ event: "memory-gardener-digest-decay-write-failed", error: errorMessage(err) }))
  }
}

/**
 * Write the CONSOLIDATION half from the tick (summary + the candidate clusters it
 * enqueued). Resets the per-tick `proposals` ring to empty — the consumers that
 * process THIS tick's enqueued clusters append their proposals to it afterward.
 * Preserves the decay half. Best-effort.
 */
export async function writeConsolidationDigestHalf(
  env: Env,
  half: Omit<ConsolidationDigestHalf, "proposals">,
): Promise<void> {
  try {
    const current = await loadRaw(env)
    const next: MemoryGardenerDigest = {
      updatedAt: new Date().toISOString(),
      ...(current.decay ? { decay: current.decay } : {}),
      consolidation: {
        ...half,
        candidateSamples: half.candidateSamples.slice(0, MAX_DIGEST_SAMPLES),
        proposals: [],
      },
    }
    await env.OPENCLAW_STATE.put(MEMORY_GARDENER_DIGEST_KEY, JSON.stringify(next))
  } catch (err) {
    console.warn(
      JSON.stringify({ event: "memory-gardener-digest-consolidation-write-failed", error: errorMessage(err) }),
    )
  }
}

/**
 * Append one consolidation PROPOSAL to the digest's bounded ring (newest kept).
 * Called by the Queue consumer after the Gardener LLM runs, in BOTH shadow and
 * enforce. Preserves both halves; only mutates `consolidation.proposals`.
 * Best-effort (see the KV-RMW race note above).
 */
export async function appendConsolidationProposal(env: Env, proposal: ConsolidationProposalSample): Promise<void> {
  try {
    const current = await loadRaw(env)
    const existing = current.consolidation
    const consolidation: ConsolidationDigestHalf = existing
      ? { ...existing, proposals: [proposal, ...existing.proposals].slice(0, MAX_DIGEST_SAMPLES) }
      : {
          ranAt: new Date().toISOString(),
          mode: proposal.mode,
          summary: {},
          candidateSamples: [],
          proposals: [proposal],
        }
    const next: MemoryGardenerDigest = {
      updatedAt: new Date().toISOString(),
      ...(current.decay ? { decay: current.decay } : {}),
      consolidation,
    }
    await env.OPENCLAW_STATE.put(MEMORY_GARDENER_DIGEST_KEY, JSON.stringify(next))
  } catch (err) {
    console.warn(JSON.stringify({ event: "memory-gardener-digest-proposal-write-failed", error: errorMessage(err) }))
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
