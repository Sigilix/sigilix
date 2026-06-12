// SIG-392 — reconstruct synth provenance when the model omits it (gemma
// large-payload recovery).
//
// On big payloads gemma4:31b emits a VALID verdict but drops the `provenance`
// block (live-captured: provType undefined, verdict intact). Today that
// hard-rejects → deepseek fallback, discarding the better synth's good verdict.
// This rebuilds provenance by co-locating each verdict finding with its real
// source specialist finding(s) — path + line proximity only (NOT headline; the
// synth rewrites wording). Recall- AND precision-safe vs the hallucination guard:
// a matched finding gets REAL source ids (guard passes, same as honest
// provenance); a finding matching NO source gets `sourceFindingIds: []` and is
// dropped by the guard — exactly what the guard does to an untraceable
// (hallucinated) finding. Only invoked when the verdict already parsed
// cleanly; garbage output still routes to retry/fallback. Spec:
// docs/superpowers/specs/2026-06-12-sig392-synth-provenance-reconstruction.md

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

// Attribution is by PATH + LINE PROXIMITY only — NOT headline similarity. The
// synth's job is to rewrite/merge findings, so a real finding's headline often
// diverges sharply from its source; requiring headline overlap would drop
// real-but-rephrased findings (a recall regression the reconstruction must not
// introduce). For the hallucination guard's question — "does a real source
// exist for this finding?" — co-location is the correct signal: a synth finding
// with NO source within ±5 lines of its anchor is the untraceable
// (hallucinated) case; one near real sources is grounded regardless of wording.
const LINE_SLACK = 5
const ROLES: ReadonlySet<string> = new Set(["logic", "security", "performance", "tests"])

/** A source specialist finding the reconstruction matches verdict findings against. */
export interface ProvenanceSource {
  id: string
  path: string
  line: number
  headline: string
}

export interface ReconstructResult {
  provenance: SynthesizerProvenance
  matched: number
  unmatched: number
}

/** Stable-id prefix → specialist role (`logic-3` → `logic`); null if unknown. */
function roleFromId(id: string): SpecialistRole | null {
  const head = id.split("-")[0] ?? ""
  return ROLES.has(head) ? (head as SpecialistRole) : null
}

/**
 * Build a SynthesizerProvenance for a verdict whose model output omitted one.
 * Each `provenance.findings[i]` corresponds BY INDEX to `verdictFindings[i]`
 * (the validateForSubmission pairing contract). A verdict finding's
 * `sourceFindingIds` is every source at the same path whose line falls within
 * ±5 of the finding's anchor range; unmatched findings carry `[]` (→ dropped
 * by the hallucination guard). `dropped`/`softened` are empty — the model gave
 * us no drop/soften signal, and an empty `dropped` only means "no proof-drops
 * recorded", which the SIG-351 source floor and review-memory soften both
 * tolerate (they act on presence, not absence).
 */
export function reconstructSynthProvenance(
  verdictFindings: ReadonlyArray<PrReviewFinding>,
  sources: ReadonlyArray<ProvenanceSource>,
): ReconstructResult {
  let matched = 0
  let unmatched = 0
  const findings: SynthesizerProvenance["findings"] = verdictFindings.map((f) => {
    const ids: string[] = []
    const roles = new Set<SpecialistRole>()
    const lo = Math.min(f.startLine ?? f.line, f.line) - LINE_SLACK
    const hi = Math.max(f.startLine ?? f.line, f.line) + LINE_SLACK
    for (const s of sources) {
      if (s.path !== f.path) continue
      if (s.line < lo || s.line > hi) continue
      ids.push(s.id)
      const role = roleFromId(s.id)
      if (role) roles.add(role)
    }
    if (ids.length > 0) matched += 1
    else unmatched += 1
    return {
      sourceSpecialists: [...roles].sort(),
      sourceFindingIds: [...new Set(ids)].sort(),
      action: "rewritten" as const,
      verifiedViaRetrieval: false,
    }
  })
  return { provenance: { findings, dropped: [] }, matched, unmatched }
}
