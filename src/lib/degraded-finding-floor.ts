// SIG-287 — degraded-coverage finding floor.
//
// When the ensemble runs with DEGRADED coverage (a dispatched specialist
// timed out / was cancelled — in practice `logic` on ~every review), the
// synthesizer can shrug: it emits a low-confidence "no concerns" verdict
// and DROPS the findings the specialists that DID return actually raised
// (on PR #218 the synth emitted 0 findings while `performance` had a
// real score-2 finding). Combined with the event downgrade (#219, a
// degraded review can no longer post a confident APPROVE), the review
// becomes an honest-but-empty "partial review" — which still hides what
// the surviving specialists found.
//
// This floor re-injects, ONLY on degraded runs, any returned specialist
// finding at or above `minScore` whose source id the synth did not
// account for in its provenance. The re-injected finding flows through
// the normal post-synth pipeline (validators, anchor repair, withdrawal
// suppression, inline-grounding, score-1 advisory demotion) exactly like
// a synth-kept finding — nothing is force-posted. It just ensures the
// synth can't silently erase the only signal a degraded review has.
//
// Pure + structural (no import from the ensemble — avoids a cycle). The
// orchestrator passes the synth verdict's findings + its INDEX-PARALLEL
// provenance findings (the hallucination guard pairs them by index, so
// the floor appends to BOTH in lockstep to preserve alignment).

import type { PrReviewFinding } from "./triage-pr-review"
import type { SpecialistRole } from "./ensemble-router"

/** Minimum specialist-finding score the floor will restore. Nits (score 1) stay dropped. */
export const DEGRADED_FLOOR_MIN_SCORE = 2

/**
 * One synth provenance entry — structurally compatible with
 * `SynthesizerProvenance["findings"][number]` so the orchestrator can
 * pass `synthOutput.provenance.findings` straight in and back out.
 */
export interface FloorProvenanceFinding {
  sourceSpecialists: SpecialistRole[]
  sourceFindingIds: string[]
  action: "kept" | "merged" | "rewritten"
  verifiedViaRetrieval: boolean
}

export interface DegradedFloorSpecialist {
  role: SpecialistRole
  /** The role's returned findings (specialist findings carry a stable `id`). */
  findings: ReadonlyArray<PrReviewFinding & { id: string }>
}

export interface DegradedFloorResult {
  /** Synth findings + any restored specialist findings, appended in order. */
  findings: PrReviewFinding[]
  /** Provenance findings + matching entries for the restored findings, INDEX-PARALLEL to `findings`. */
  provenanceFindings: FloorProvenanceFinding[]
  /** What was restored (for telemetry). Empty when nothing qualified. */
  restored: Array<{ role: SpecialistRole; id: string; score: number; headline: string }>
}

/**
 * Re-inject returned specialist findings (score >= `minScore`) the synth
 * did not account for, preserving index-alignment between `findings` and
 * `provenanceFindings`. Pure — returns fresh arrays; never mutates input.
 * The caller must only invoke this on degraded runs.
 */
export function applyDegradedCoverageFindingFloor(args: {
  findings: ReadonlyArray<PrReviewFinding>
  provenanceFindings: ReadonlyArray<FloorProvenanceFinding>
  specialists: ReadonlyArray<DegradedFloorSpecialist>
  minScore?: number
}): DegradedFloorResult {
  const minScore = args.minScore ?? DEGRADED_FLOOR_MIN_SCORE
  // Every source finding id the synth already represents in its output.
  const accounted = new Set<string>(
    args.provenanceFindings.flatMap((p) => p.sourceFindingIds),
  )
  const findings: PrReviewFinding[] = [...args.findings]
  const provenanceFindings: FloorProvenanceFinding[] = [...args.provenanceFindings]
  const restored: DegradedFloorResult["restored"] = []

  for (const { role, findings: specialistFindings } of args.specialists) {
    for (const f of specialistFindings) {
      if (f.score < minScore) continue
      if (accounted.has(f.id)) continue
      // Guard a (pathological) duplicate id across specialists so we never
      // double-inject and skew the index pairing.
      accounted.add(f.id)
      findings.push(f)
      provenanceFindings.push({
        sourceSpecialists: [role],
        sourceFindingIds: [f.id],
        action: "kept",
        verifiedViaRetrieval: false,
      })
      restored.push({ role, id: f.id, score: f.score, headline: f.headline })
    }
  }

  return { findings, provenanceFindings, restored }
}

// ─── SIG-317 — synth verdict-truncation recovery ──────────────────────────
//
// On target-rich PRs the synthesizer emits a COMPLETE `provenance.findings`
// (one terse entry per source it decided to keep) but a SHORTER
// `verdict.findings` — it details the top-ranked findings (security-first, per
// the synth prompt's "rank by severity") and silently truncates the verbose
// verdict array, losing real subtle findings it MARKED KEPT. The synth's own
// provenance is the proof of intent: on pr/10 `provenance.findings` had 20
// entries (action "kept", 0 dropped) while `verdict.findings` had 8 — 12
// score>=3 findings lost, including a score-5 N+1, a cents/dollars bug, a
// floating promise, and the SIG-310 deterministic emit.
//
// This recovers the truncated tail: for every provenance entry BEYOND the
// verdict length, reconstruct the verdict finding from its cited source. The
// recovered findings flow through the SAME post-synth gates (grounding,
// citation, evidence, clamps, anchor repair) as synth-kept findings — nothing
// is force-posted; a recovered finding that doesn't hold is dropped by its
// gate. Precision-safe by construction: we only restore findings the synth
// itself provenanced as "kept"/"merged", never inventing new ones, and the
// gates remain the precision authority.

export interface TruncationRecoveryResult {
  /** Synth findings + recovered tail, index-parallel to `provenanceFindings`. */
  findings: PrReviewFinding[]
  /** Provenance entries, realigned 1:1 to `findings`. */
  provenanceFindings: FloorProvenanceFinding[]
  /** What was recovered (telemetry). Empty when the synth verdict wasn't truncated. */
  recovered: Array<{ id: string; score: number; category: string; headline: string }>
}

/**
 * Recover findings the synth truncated out of `verdict.findings` but still
 * accounted for in `provenance.findings` (i.e. `provenance.findings.length >
 * verdict.findings.length`). Reconstructs each orphaned tail entry from its
 * cited source finding via `sourceById`. Pure — never mutates input. Returns
 * the inputs unchanged when there is no truncation tail.
 */
export function recoverTruncatedSynthFindings(args: {
  findings: ReadonlyArray<PrReviewFinding>
  provenanceFindings: ReadonlyArray<FloorProvenanceFinding>
  /**
   * Candidate source findings keyed by source id. The orchestrator passes
   * specialist findings (`${role}-${index}`) in Part 1; orphans citing only
   * AST-emit ids are simply skipped (AST/SIG-310 recovery is a fast-follow).
   */
  sourceById: ReadonlyMap<string, PrReviewFinding & { id: string }>
  minScore?: number
}): TruncationRecoveryResult {
  const minScore = args.minScore ?? DEGRADED_FLOOR_MIN_SCORE
  // No truncation tail → nothing to recover; return inputs unchanged.
  if (args.provenanceFindings.length <= args.findings.length) {
    return {
      findings: [...args.findings],
      provenanceFindings: [...args.provenanceFindings],
      recovered: [],
    }
  }
  // Keep the aligned prefix (the findings the synth DID fully write) intact.
  const findings: PrReviewFinding[] = [...args.findings]
  const provenanceFindings: FloorProvenanceFinding[] = args.provenanceFindings.slice(0, findings.length)
  const recovered: TruncationRecoveryResult["recovered"] = []
  // Guard against re-adding a source already present in the kept prefix.
  const present = new Set<string>(provenanceFindings.flatMap((p) => p.sourceFindingIds))

  for (let i = args.findings.length; i < args.provenanceFindings.length; i++) {
    const p = args.provenanceFindings[i]
    if (!p || !Array.isArray(p.sourceFindingIds) || p.sourceFindingIds.length === 0) continue
    // Reconstruct from the highest-score cited source not already present.
    let best: (PrReviewFinding & { id: string }) | undefined
    for (const sid of p.sourceFindingIds) {
      if (present.has(sid)) continue
      const f = args.sourceById.get(sid)
      if (f && (best === undefined || f.score > best.score)) best = f
    }
    if (best === undefined || best.score < minScore) continue
    // Mark ALL cited sources present (not just `best`) — a merged provenance
    // entry [a, b] is recovered as ONE finding (the best-scored representation),
    // so a later orphan re-citing `a` or `b` must not re-recover it as a
    // duplicate. Reached only for a QUALIFYING orphan (the skip above returns
    // first), so a skipped orphan never poisons `present` for later ones.
    for (const sid of p.sourceFindingIds) present.add(sid)
    findings.push(best)
    provenanceFindings.push({
      sourceSpecialists: p.sourceSpecialists,
      sourceFindingIds: p.sourceFindingIds,
      action: p.action,
      verifiedViaRetrieval: p.verifiedViaRetrieval ?? false,
    })
    recovered.push({ id: best.id, score: best.score, category: best.category ?? "logic", headline: best.headline })
  }

  return { findings, provenanceFindings, recovered }
}

// ─── SIG-317 step 6 Part A — deterministic AST-emit injection floor ─────────
//
// The named fast-follow gap above: a `deterministic_emit` AST finding (an
// `emitWhenUnmatched` pseudo-rule — cents-as-dollars, enum/contract drift,
// fractional-cents, dynamic-HTML-sink) is surfaced TODAY only if the synth
// model obeys the prompt instruction to "EMIT a finding for it yourself".
// When the model ignores it or truncates it into the dropped verdict tail, the
// PROVEN needle is silently lost — exactly the crowd-out this step exists to
// stop. `validateForSubmission` (SIG-314) only ADMITS an AST-cited finding the
// synth chose to emit; it never ADDS one.
//
// This floor force-injects any `emitWhenUnmatched` AST finding NOT already
// covered by an emitted finding, mirroring the synth prompt's coverage rule:
// for a `roleHint:"security"` entry, "covered" = any finding at the same
// (path, line±tolerance); for any other role, "covered" = a same-category
// finding at the same (path, line±tolerance). The injected finding cites the
// `astFindingId`, so SIG-314's hallucination guard admits it, and it flows
// through every post-synth gate (grounding, anchor repair, clamps) like any
// other finding — nothing is force-POSTED, only force-SURFACED to the gates.
//
// SCOPE — `warning`/`info` emits ONLY (P2/P3 advisories). The crowd-out is a
// LOW-severity phenomenon: an `error` security sink (exec / TLS) is P0/P1, sorts
// FIRST under the synth's severity ranking, is never truncated, and already has
// the SIG-309 grounding path — so it is never the crowd-out victim and stays out
// of scope. Capping the floor at the warning tier keeps it RECALL-POSITIVE and
// SIG-245-safe (it can never mint a deterministic P0/P1 the model didn't judge).
//
// Pure — returns fresh arrays, never mutates input.

const AST_EMIT_FLOOR_CEIL: Record<string, number> = { warning: 3, info: 2 }

/** Mode for the AST-emit floor. Matches the off|shadow|on idiom of the other gates. */
export type AstEmitFloorMode = "off" | "shadow" | "on"

/**
 * Parse `OPENCLAW_AST_EMIT_FLOOR`. Case-insensitive, whitespace-tolerant; any
 * unknown / missing / garbage value FAILS CLOSED to `off` so a misconfig can't
 * silently enable the floor (CodeRabbit/Sigilix #330). Mirrors the codebase's
 * `parseAbsenceClaimValidatorMode` / `parseWindowBlindnessValidatorMode` pattern.
 */
export function parseAstEmitFloorMode(raw: string | undefined): AstEmitFloorMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "on") return "on"
  return "off"
}

/** Minimal structural view of an AST emit the floor needs (subset of `AstFinding`). */
export interface AstEmitCandidate {
  astFindingId: string
  path: string
  line: number
  endLine?: number
  roleHint: string
  severity: string
  emitWhenUnmatched?: boolean
  message: string
  /** SIG-317 step 6 Part B: the runner's redacted code slice that proved the
   *  emit. Attached to the injected finding as `astEvidence` so the render shows
   *  "Detected by static analysis". Optional (back-compat). */
  evidence?: string
}

export interface AstEmitFloorResult {
  findings: PrReviewFinding[]
  provenanceFindings: FloorProvenanceFinding[]
  /** Telemetry — carries the projected headline/body so a human can audit
   *  believability from the shadow log BEFORE the `on` flip (Kimi sign-off). */
  injected: Array<{
    astFindingId: string
    path: string
    line: number
    score: number
    category: string
    headline: string
    body: string
  }>
}

/** One-line headline from an AST message: first sentence, capped at 100 chars. */
function astHeadline(message: string): string {
  const first = message.split(/(?<=[.!?])\s/)[0] ?? message
  const trimmed = first.trim()
  return trimmed.length > 100 ? `${trimmed.slice(0, 97)}…` : trimmed
}

/**
 * Inject `emitWhenUnmatched` (warning/info) AST findings the emitted set does
 * not already cover. `findings` and `provenanceFindings` are INDEX-PARALLEL
 * (the hallucination guard pairs them), so we append to BOTH in lockstep.
 * Pure. The caller gates invocation behind the off/shadow/on flag.
 *
 * ⚠️ The injected finding's `body` is the RAW AST `message` — no model prose
 * and no proof slice. At score 2-3 that reads as linter noise, which HURTS
 * believability. This floor must stay `shadow` until step 6 Part B (AST-evidence
 * render) makes the surfaced finding customer-ready (Kimi sign-off). Shadow logs
 * the projected bodies so the robotic-ness can be audited before the `on` flip.
 */
export function injectUnmatchedAstEmits(args: {
  findings: ReadonlyArray<PrReviewFinding>
  provenanceFindings: ReadonlyArray<FloorProvenanceFinding>
  astFindings: ReadonlyArray<AstEmitCandidate>
  /** ± lines of slack when matching an emitted finding to an AST entry. Slightly
   *  wider than clampAstEmitScores' ±2 so a model finding anchored a few lines
   *  off the detector's line still counts as covered → no duplicate (DeepSeek). */
  lineTolerance?: number
}): AstEmitFloorResult {
  const tol = args.lineTolerance ?? 3
  const findings: PrReviewFinding[] = [...args.findings]
  const provenanceFindings: FloorProvenanceFinding[] = [...args.provenanceFindings]
  const injected: AstEmitFloorResult["injected"] = []

  const candidates = args.astFindings.filter(
    (f) => f.emitWhenUnmatched === true && AST_EMIT_FLOOR_CEIL[f.severity] !== undefined,
  )
  // Already-cited AST ids (covered by an emitted finding's provenance) + ids we
  // inject in this pass — so we never double-inject the same emit.
  const seen = new Set<string>(provenanceFindings.flatMap((p) => p.sourceFindingIds))

  // Pre-group the emitted findings by path so the per-candidate coverage check
  // scans only the same-file findings, not the whole array (Sigilix #330 P3:
  // avoid the O(candidates × all-findings) quadratic on target-rich PRs).
  const findingsByPath = new Map<string, Array<{ lo: number; hi: number; category: string }>>()
  for (const f of findings) {
    let arr = findingsByPath.get(f.path)
    if (!arr) findingsByPath.set(f.path, (arr = []))
    // store each finding's OWN span (startLine..line) for range-overlap.
    arr.push({ lo: f.startLine ?? f.line, hi: f.line, category: f.category })
  }

  for (const ast of candidates) {
    if (seen.has(ast.astFindingId)) continue
    // The AST emit's span (line..endLine) widened by the tolerance. Coverage is
    // RANGE-OVERLAP: an existing finding's own span (startLine..line) overlapping
    // this window counts as covering it (CodeRabbit #330 — a multi-line existing
    // finding shouldn't be missed just because its anchor `line` sits outside).
    const lo = ast.line - tol
    const hi = (ast.endLine ?? ast.line) + tol
    const covered = (findingsByPath.get(ast.path) ?? []).some(
      (f) =>
        // security entries are covered by ANY finding on the line; other roles
        // require a same-category finding (the synth prompt's coverage rule).
        (ast.roleHint === "security" || f.category === ast.roleHint) &&
        f.lo <= hi &&
        f.hi >= lo,
    )
    if (covered) continue

    const score = AST_EMIT_FLOOR_CEIL[ast.severity]!
    const headline = astHeadline(ast.message)
    const isMultiLine = ast.endLine !== undefined && ast.endLine !== ast.line
    findings.push({
      path: ast.path,
      // Convention: `line` = last line of the span, `startLine` = first. Emit the
      // full multi-line span (CodeRabbit #330) so the anchor isn't collapsed.
      line: ast.endLine ?? ast.line,
      ...(isMultiLine ? { startLine: ast.line } : {}),
      scope: "line",
      score,
      category: ast.roleHint as PrReviewFinding["category"],
      headline,
      body: ast.message,
      confidence: 4,
      // Part B: the proof slice renders as "Detected by static analysis".
      ...(ast.evidence ? { astEvidence: ast.evidence } : {}),
    } as PrReviewFinding)
    provenanceFindings.push({
      sourceSpecialists: [ast.roleHint as SpecialistRole],
      sourceFindingIds: [ast.astFindingId],
      action: "kept",
      verifiedViaRetrieval: false,
    })
    seen.add(ast.astFindingId)
    injected.push({ astFindingId: ast.astFindingId, path: ast.path, line: ast.line, score, category: ast.roleHint, headline, body: ast.message })
  }

  return { findings, provenanceFindings, injected }
}
