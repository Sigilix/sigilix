// SIG-318 (PR 2) — the PR-review FINDINGS domain (domain layer).
//
// PURE finding-identity logic: stable IDs, consensus ranking + annotation, the
// stable (path, headline) key, and cross-push deltas. No env / network /
// storage (crypto.subtle is a Web global — a pure hash, not IO).
//
// Moved verbatim from triage-pr-review-ensemble.ts and re-exported there, so
// existing importers are unaffected. To honor the dependency rule (the domain
// must not import the orchestrator god-file), `computeConsensusRanking` is
// generalized over the provenance entry type — it reads only `sourceSpecialists`
// and passes entries through unchanged — so this module imports NOTHING from the
// god-file. It previously referenced the god-file-defined `SynthesizerProvenance`
// type; that type stays in the orchestrator (it relocates to the domain in the
// PR 3 type-consolidation). Here we depend only on the entity data types.

import type { SpecialistRole } from "@/shared/domain/specialist-role"
import type { PrReviewVerdict, PrReviewFinding } from "@/shared/domain/pr-review-finding"

/** A verdict whose findings carry stable `${role}-${i}` ids (post-assign). */
export interface PrReviewVerdictWithIds extends PrReviewVerdict {
  findings: Array<PrReviewFinding & { id: string }>
}

export function assignStableFindingIds(role: SpecialistRole, verdict: PrReviewVerdict): PrReviewVerdictWithIds {
  return {
    ...verdict,
    findings: verdict.findings.map((f, i) => ({ ...f, id: `${role}-${i}` })),
  }
}

/**
 * ARC-270 — consensus-aware ranking of post-synth findings.
 *
 * Re-orders `verdict.findings` (and the parallel `provenance` array)
 * by **`(consensus, score)` DESC** where `consensus = number of
 * distinct specialists that cited the finding via `sourceSpecialists`.
 * Two specialists independently flagging the same line is much
 * stronger signal than one specialist's opinion — surface that
 * agreement at the top, where reviewers will look first.
 *
 * **Why consensus is primary, not score.** A 2-specialist score-2
 * finding ranks above a 1-specialist score-5 finding. This is
 * deliberate: lone-specialist score-5 is the most common LLM
 * over-confidence failure mode, and cross-specialist agreement is
 * exactly the signal that distinguishes "real bug" from "model
 * hallucinated a confident concern". Reversing the keys would put
 * over-confident solo findings at the top.
 *
 * Strictly additive (Codex spec catch): we do NOT change the gate
 * (`chooseReviewEvent`) or drop any findings here. The score values
 * stay untouched. This is a reorder-and-annotate step only.
 *
 * Stable: ties on `(consensus, score)` preserve the synth's emit
 * order (so the synth's logical grouping survives the reorder when
 * there's no consensus signal to leverage).
 *
 * Returns a NEW verdict object + a NEW parallel provenance array +
 * a `consensusByIndex` array aligned with the new ordering. Callers
 * use `consensusByIndex` to render a "Flagged by N specialists"
 * annotation on findings with `consensus >= 2`.
 *
 * Pure — exported for unit tests.
 */
// Default param keeps the bare `ConsensusRanked` usable (the type was concrete
// before this extraction); the orchestrator passes its full provenance entry as
// P via inference. The default is the minimal read shape, not the god-file's
// SynthesizerProvenance — the dependency rule still holds (DeepSeek-v4-pro #411-PR2).
export interface ConsensusRanked<P = { sourceSpecialists?: readonly string[] }> {
  verdict: PrReviewVerdict
  provenance: P[]
  /** `consensusByIndex[i]` is the number of distinct specialists for
   *  the finding at NEW index `i`. Always >= 1 (validateForSubmission
   *  drops zero-source findings as hallucinations).
   */
  consensusByIndex: number[]
}

export function computeConsensusRanking<P extends { sourceSpecialists?: readonly string[] }>(
  verdict: PrReviewVerdict,
  provenance: P[],
): ConsensusRanked<P> {
  // Defensive: provenance.length should equal findings.length post-
  // validateForSubmission. If misaligned, fall back to a no-op
  // (preserve order + emit consensus=1 for all) so we don't
  // accidentally drop findings.
  if (provenance.length !== verdict.findings.length) {
    return {
      verdict,
      provenance,
      consensusByIndex: verdict.findings.map(() => 1),
    }
  }

  const consensusOf = (i: number): number => {
    const specs = provenance[i]?.sourceSpecialists
    if (!Array.isArray(specs) || specs.length === 0) return 1
    return new Set(specs).size
  }

  // Build index permutation. Sort by `(consensus DESC, score DESC,
  // originalIndex ASC)` for stable tiebreaking.
  const order = verdict.findings.map((_, i) => i)
  order.sort((a, b) => {
    const ca = consensusOf(a)
    const cb = consensusOf(b)
    if (cb !== ca) return cb - ca
    const sa = verdict.findings[a]!.score
    const sb = verdict.findings[b]!.score
    if (sb !== sa) return sb - sa
    return a - b
  })

  const newFindings = order.map((i) => verdict.findings[i]!)
  const newProvenance = order.map((i) => provenance[i]!)
  const consensusByIndex = order.map((i) => consensusOf(i))

  return {
    verdict: { ...verdict, findings: newFindings },
    provenance: newProvenance,
    consensusByIndex,
  }
}

/**
 * ARC-270 — annotate a finding's `body` with a "Flagged by N
 * specialists" prefix when consensus >= 2. Returns a CLONE of the
 * finding; never mutates the original (same immutability pattern
 * as the review-memory soften clone in the ensemble flow).
 *
 * For consensus < 2, returns the finding unchanged (no annotation,
 * since a single specialist's opinion is the default expectation).
 *
 * Pure — exported for unit tests.
 */
export function annotateWithConsensus(
  finding: PrReviewFinding,
  consensus: number,
): PrReviewFinding {
  if (consensus < 2) return finding
  const annotation = `_Flagged by ${consensus} specialists._`
  const body = finding.body.length > 0
    ? `${annotation}\n\n${finding.body}`
    : annotation
  return { ...finding, body }
}

// ─── ARC-271 — finding deltas across pushes ──────────────────────────

/**
 * Normalize a headline for stable-key derivation: lowercase, collapse
 * whitespace runs, strip trailing punctuation. Tolerates minor LLM
 * rephrasing across pushes (different casing, extra spaces, optional
 * trailing period). Major rephrasing produces a new key — accepted
 * v1 trade-off (over-report new is safer than silent drop).
 */
function normalizeHeadline(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
}

/**
 * ARC-271 — compute a stable finding key from `(path, headline)`.
 * Pure SHA-256 → first 16 hex chars (64 bits — enough to avoid
 * collisions within a single PR's finding set, which is bounded to
 * MAX_SYNTH_FINDINGS).
 *
 * Exported for unit tests.
 */
export async function computeFindingKey(path: string, headline: string): Promise<string> {
  const input = `${path.toLowerCase()}|${normalizeHeadline(headline)}`
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  const bytes = new Uint8Array(buf)
  let hex = ""
  for (let i = 0; i < 8; i++) hex += bytes[i]!.toString(16).padStart(2, "0")
  return hex
}

/**
 * ARC-271 — delta classification result.
 *
 * - `new` — finding has no matching key in the prior manifest.
 * - `stillOpen` — finding's key was also in the prior manifest.
 * - `likelyFixed` — prior finding's key is NOT in current AND the
 *   prior finding's path is in the current PR's changed-file set.
 *   (Path-in-diff implies the file was edited; finding gone → likely
 *   resolved by the edit.)
 * - `carriedOver` — prior finding's key is NOT in current AND the
 *   prior finding's path is NOT in the current PR's changed-file set.
 *   (File untouched since prior review — incremental review didn't
 *   look at it. Finding may still apply but we have no fresh signal.)
 *
 * Codex spec warning: NEVER classify a non-touched-file finding as
 * `fixed`. Incremental review only sends changed-file diffs to
 * specialists, so an old finding for an unchanged file would not
 * reappear in the new run for reasons orthogonal to whether the
 * code was fixed.
 */
export interface FindingDelta {
  newCount: number
  stillOpenCount: number
  likelyFixedCount: number
  carriedOverCount: number
}

/**
 * Compute the delta against the prior manifest's findings. Pure;
 * exported for unit tests.
 */
export function computeFindingDelta(
  currentKeys: ReadonlySet<string>,
  priorFindings: ReadonlyArray<{ key: string; path: string }>,
  changedPaths: ReadonlySet<string>,
): FindingDelta {
  const priorKeys = new Set(priorFindings.map((f) => f.key))
  let newCount = 0
  for (const k of currentKeys) {
    if (!priorKeys.has(k)) newCount += 1
  }
  const stillOpenCount = [...currentKeys].filter((k) => priorKeys.has(k)).length
  // code-reviewer HIGH catch: `computeFindingKey` lowercases path for
  // key derivation (so case-renamed files don't drift). The
  // changed-path lookup must use the same normalization or a prior
  // finding stored as `Src/Foo.ts` won't match `changedPaths`
  // entries like `src/foo.ts` from the diff — falsely landing in
  // `carried-over`. Lowercase both sides of the comparison.
  const changedPathsLower = new Set<string>()
  for (const p of changedPaths) changedPathsLower.add(p.toLowerCase())
  let likelyFixedCount = 0
  let carriedOverCount = 0
  for (const p of priorFindings) {
    if (currentKeys.has(p.key)) continue
    if (changedPathsLower.has(p.path.toLowerCase())) likelyFixedCount += 1
    else carriedOverCount += 1
  }
  return { newCount, stillOpenCount, likelyFixedCount, carriedOverCount }
}

// SIG-318 (PR 12a): moved verbatim from triage-pr-review-ensemble.ts (the
// adjudicate phase calls it on the validated verdict). Pure (apart from the
// in-place score mutation) — no env / network / storage — so it belongs in the
// findings domain alongside the consensus ranking it runs next to. Re-exported
// from the god-file so existing importers (the AST-emit test) are unaffected.
/**
 * SIG-310: enforce that a `deterministic_emit` AST rule's SEVERITY is a HARD
 * score ceiling on any finding it produces. The synth picks `score` freely
 * (the rendered `severity` is advisory text only), so without this a
 * warning-severity type smell (the optional-alias drift) could be emitted at
 * P0/P1, breaking the zero-P0/P1-FP bar (code-review MAJOR on #294).
 *
 * Clamps, IN PLACE, the score of any finding co-located (±2 lines, same path,
 * same category) with a NON-`error` `emitWhenUnmatched` AST finding to that
 * rule's tier (warning→3/P2, info→2). `error` security emit rules are never
 * clamped — a P0/P1 injection/TLS sink is the correct outcome there.
 *
 * SIG-312 (CodeRabbit #296): a `warning`/`security` emit (the dynamic-HTML
 * advisory) DOES create a ceiling, BUT a SPECIALIST-backed security finding is
 * exempt — its score is the model's TRUST JUDGMENT legitimately escalating a
 * surfaced sink to P0/P1, and demoting it would hide a REAL caught XSS at P2.
 * Only a deterministic-ONLY security advisory (no specialist source — its
 * `sourceFindingIds` are empty or reference only the `ast/…` emit) is capped.
 * `provenanceFindings` aligns by index with `findings` (same walk in
 * validateForSubmission). Returns the count clamped. Pure (apart from the
 * in-place score mutation); exported for test.
 */
export function clampAstEmitScores(
  findings: Array<{ path: string; line: number; category: string; score: number }>,
  astFindings: ReadonlyArray<{ path: string; line: number; endLine?: number; roleHint: string; severity: string; emitWhenUnmatched?: boolean }>,
  provenanceFindings?: ReadonlyArray<{ sourceFindingIds?: readonly string[] } | null | undefined>,
): number {
  const CEIL: Record<string, number> = { error: 5, warning: 3, info: 2 }
  const emitCeils = astFindings
    .filter((f) => f.emitWhenUnmatched === true && (CEIL[f.severity] ?? 5) < 5)
    .map((f) => ({ path: f.path, role: f.roleHint, lo: f.line, hi: f.endLine ?? f.line, ceil: CEIL[f.severity] ?? 5 }))
  if (emitCeils.length === 0) return 0
  let clamped = 0
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!
    const ceil = emitCeils
      .filter((e) => e.path === finding.path && e.role === finding.category && finding.line >= e.lo - 2 && finding.line <= e.hi + 2)
      .reduce((m, e) => Math.min(m, e.ceil), 5)
    if (ceil >= 5 || finding.score <= ceil) continue
    // SIG-312: never demote a SPECIALIST-backed security finding (the model's
    // escalation of a real sink). Cap only a deterministic-only one.
    if (finding.category === "security") {
      const srcIds = provenanceFindings?.[i]?.sourceFindingIds ?? []
      if (srcIds.some((id) => !id.startsWith("ast/"))) continue
    }
    finding.score = ceil
    clamped++
  }
  return clamped
}
