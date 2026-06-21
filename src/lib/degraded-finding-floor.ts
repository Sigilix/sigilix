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
  const accounted = new Set<string>(args.provenanceFindings.flatMap((p) => p.sourceFindingIds))
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

// ─── SIG-351 — synth source-finding floor ────────────────────────────────
//
// Unlike the SIG-287 floor above, this applies to full-coverage synth runs too.
// FP adjudication is allowed only when the synth records a proof-like drop; an
// omitted score>=4 source finding is restored so recall does not depend on the
// model's source-ID bookkeeping. Restored findings still flow through the same
// post-synth hallucination/grounding/validation gates as model-kept findings.

/** Minimum specialist-finding score the full-coverage source floor restores. */
export const SYNTH_SOURCE_FLOOR_MIN_SCORE = 4

/** SIG-484: the LOWERED floor (gated by `synthSourceFloorLow`). The default floor=4
 *  leaves score 2-3 source findings the LLM-synth thins/over-merges on dense PRs
 *  permanently lost (the score>=2 degraded floor only runs when a specialist FAILED).
 *  Lowering to 2 re-aligns the deterministic floor with the synth prompt's retention
 *  directive (protect score>=2). Same orphaned + not-proof-dropped gates → recall-safe. */
export const SYNTH_SOURCE_FLOOR_MIN_SCORE_LOW = 2

const SOURCE_FLOOR_ROLE_PRIORITY: Record<SpecialistRole, number> = {
  security: 4,
  logic: 3,
  performance: 2,
  tests: 1,
}

/** Structural subset of `SynthesizerProvenance["dropped"][number]`. */
export interface SourceFloorDroppedFinding {
  sourceFindingId: string
  reason: string
}

const SUPERSEDED_BY_AST_PREFIX = "superseded_by_ast/"

/**
 * A drop counts as proof-resolved (the synth may legitimately SUPPRESS a
 * score>=4 source finding) only when it is one of:
 *
 *   - `false positive on diff inspection` — irreducibly model-trusted; the
 *     model claims the diff disproves the finding. Left as-is.
 *   - `superseded_by_ast/<id>` — the synth dropped the specialist finding
 *     because a deterministic AST emit covers it. This IS deterministically
 *     checkable: `<id>` must be a REAL AST finding id. We mirror the SIG-314
 *     kept-path guard (triage-pr-review-ensemble.ts builds `validIds` from
 *     `astResult.findings.map(f => f.astFindingId)`) so a hallucinated or
 *     nonexistent `<id>` is NOT honored — the floor then restores the finding
 *     (recall-safe: this can only ever ADD a restore, never silence a real one).
 *
 * `astFindingIds` is the real AST id set (`ast/<ruleId>/<pathHash7>/<line>`,
 * canonically lowercase). It is matched case-exactly: if the synth echoes a
 * different-cased id it is treated as unverified → restore, which is the
 * conservative (recall-positive) direction.
 */
function isProofResolvedDrop(reason: string, astFindingIds: ReadonlySet<string>): boolean {
  const trimmed = reason.trim()
  const normalized = trimmed.toLowerCase()
  if (normalized.startsWith("false positive on diff inspection")) return true
  if (normalized.startsWith(SUPERSEDED_BY_AST_PREFIX)) {
    const astId = trimmed.slice(SUPERSEDED_BY_AST_PREFIX.length).trim()
    return astFindingIds.has(astId)
  }
  return false
}

function findingText(finding: PrReviewFinding): string {
  return [finding.headline, finding.body, finding.failureExample, finding.fixExample, finding.testGap]
    .filter((v): v is string => typeof v === "string")
    .join("\n")
}

function distinctiveBacktickTokens(finding: PrReviewFinding): string[] {
  const out = new Set<string>()
  for (const match of findingText(finding).matchAll(/`([^`\n]{2,120})`/g)) {
    const code = match[1] ?? ""
    const trimmedCode = code.trim()
    for (const ident of code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      // Keep identifiers that are likely to name the mechanism, not tiny locals.
      if (ident.length < 8 && trimmedCode !== ident && !/[A-Z0-9_$]/.test(ident.slice(1))) continue
      out.add(ident.toLowerCase())
    }
  }
  return [...out].slice(0, 6)
}

const SOURCE_MECHANISM_PHRASES = [
  "attacker-controlled",
  "untrusted",
  "without checking",
  "without validating",
  "without validation",
  "without destination validation",
  "without allow-list",
  "without allowlisting",
  "without authorization",
  "without ownership",
  "missing authorization",
  "missing validation",
  "does not check",
  "does not validate",
  "never calls",
  "concurrent",
  "race",
  "double-charge",
  "double charge",
  "oversell",
  "object.assign",
  "__proto__",
  "prototype pollution",
  "path traversal",
] as const

function distinctiveMechanismPhrases(finding: PrReviewFinding): string[] {
  const text = findingText(finding).toLowerCase()
  return SOURCE_MECHANISM_PHRASES.filter((phrase) => text.includes(phrase))
}

function preservesSourceMechanism(source: PrReviewFinding, emitted: PrReviewFinding): boolean {
  const tokens = distinctiveBacktickTokens(source)
  const emittedText = findingText(emitted).toLowerCase()
  if (tokens.length > 0 && !tokens.every((token) => emittedText.includes(token))) return false
  const mechanismPhrases = distinctiveMechanismPhrases(source)
  if (mechanismPhrases.length === 0) return true
  return mechanismPhrases.some((phrase) => emittedText.includes(phrase))
}

/**
 * Re-inject P0/P1 source findings the synth neither represented in kept
 * provenance nor explicitly resolved with proof. Generic dropped reasons like
 * "duplicate" are NOT enough: if the source ID is not represented by an output
 * finding, the floor restores it and lets downstream validators decide.
 *
 * A represented source ID can still be under-preserved when the synth rewrites
 * away the source finding's distinctive code token (`tenantId`, `markTokenSeen`,
 * etc.). For score>=4 findings, split that source out and restore the original
 * source wording rather than trusting a vague rewrite. This is recall-safe: the
 * original specialist finding remains the evidence source and still passes
 * through the normal post-synth gates.
 *
 * `astFindingIds` is the real AST id set used to verify `superseded_by_ast/<id>`
 * drops — a spoofed/hallucinated `<id>` is NOT honored as a suppression, mirroring
 * the SIG-314 kept-path guard. Defaults to empty (fail-safe: no AST supersession is
 * honored → restore), so callers without an AST result can omit it.
 */
export function applySynthSourceFindingFloor(args: {
  findings: ReadonlyArray<PrReviewFinding>
  provenanceFindings: ReadonlyArray<FloorProvenanceFinding>
  provenanceDropped: ReadonlyArray<SourceFloorDroppedFinding>
  specialists: ReadonlyArray<DegradedFloorSpecialist>
  astFindingIds?: ReadonlySet<string>
  minScore?: number
}): DegradedFloorResult {
  const minScore = args.minScore ?? SYNTH_SOURCE_FLOOR_MIN_SCORE
  const astFindingIds = args.astFindingIds ?? new Set<string>()
  const alignedFindings = args.findings.slice()
  const alignedProvenanceFindings = alignedFindings.map(
    (_, i) =>
      args.provenanceFindings[i] ?? {
        sourceSpecialists: [],
        sourceFindingIds: [],
        action: "rewritten" as const,
        verifiedViaRetrieval: false,
      },
  )
  const proofResolved = new Set<string>()
  for (const d of args.provenanceDropped) {
    if (isProofResolvedDrop(d.reason, astFindingIds)) proofResolved.add(d.sourceFindingId)
  }

  const sourceIndexes = new Map<string, number[]>()
  for (let i = 0; i < alignedProvenanceFindings.length; i++) {
    for (const id of alignedProvenanceFindings[i]!.sourceFindingIds) {
      const arr = sourceIndexes.get(id) ?? []
      arr.push(i)
      sourceIndexes.set(id, arr)
    }
  }

  const splitSourceIds = new Set<string>()
  for (const { findings: specialistFindings } of args.specialists) {
    for (const f of specialistFindings) {
      if (f.score < minScore) continue
      if (proofResolved.has(f.id)) continue
      const indexes = sourceIndexes.get(f.id) ?? []
      if (indexes.length === 0) continue
      if (indexes.some((i) => preservesSourceMechanism(f, alignedFindings[i]!))) continue
      splitSourceIds.add(f.id)
    }
  }

  const findings: PrReviewFinding[] = []
  const provenanceFindings: FloorProvenanceFinding[] = []
  for (let i = 0; i < alignedFindings.length; i++) {
    const provenance = alignedProvenanceFindings[i]!
    const sourceFindingIds = provenance.sourceFindingIds.filter(
      (id) => !splitSourceIds.has(id) && !proofResolved.has(id),
    )
    if (sourceFindingIds.length === 0 && i < args.provenanceFindings.length) continue
    findings.push(alignedFindings[i]!)
    provenanceFindings.push({ ...provenance, sourceFindingIds })
  }

  const accounted = new Set<string>(provenanceFindings.flatMap((p) => p.sourceFindingIds))
  for (const id of proofResolved) accounted.add(id)
  const restored: DegradedFloorResult["restored"] = []
  const bestBySourceId = new Map<string, { role: SpecialistRole; finding: PrReviewFinding & { id: string } }>()

  for (const { role, findings: specialistFindings } of args.specialists) {
    for (const f of specialistFindings) {
      if (f.score < minScore) continue
      const existing = bestBySourceId.get(f.id)
      const preferred =
        !existing ||
        f.score > existing.finding.score ||
        (f.score === existing.finding.score &&
          SOURCE_FLOOR_ROLE_PRIORITY[role] > SOURCE_FLOOR_ROLE_PRIORITY[existing.role])
      if (preferred) {
        bestBySourceId.set(f.id, { role, finding: f })
      }
    }
  }

  for (const [id, { role, finding }] of bestBySourceId) {
    if (accounted.has(id)) continue
    accounted.add(id)
    findings.push(finding)
    provenanceFindings.push({
      sourceSpecialists: [role],
      sourceFindingIds: [id],
      action: "kept",
      verifiedViaRetrieval: false,
    })
    restored.push({ role, id, score: finding.score, headline: finding.headline })
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
    recovered.push({
      id: best.id,
      score: best.score,
      category: best.category ?? "logic",
      headline: best.headline,
    })
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

/**
 * One-line headline from an AST message. The detector messages open with a
 * crisp label before a colon ("Type-contract drift: …", "Likely cents/dollars
 * unit bug: …") — that label IS the headline. Using it keeps the GitHub preview
 * credible instead of truncating the long first sentence mid-word into the
 * inbox (SIG-317 step 6 Part C — Kimi: the preview must not read as linter
 * noise). Falls back to the first sentence (capped) when there's no label.
 */
function astHeadline(message: string): string {
  // A leading "Label:" — a short clause (4-60 chars) with no sentence-ending
  // punctuation, ending at the first colon.
  const label = message.match(/^([^:.!?\n]{4,60}):\s/)
  if (label?.[1]) return label[1].trim()
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
        (ast.roleHint === "security" || f.category === ast.roleHint) && f.lo <= hi && f.hi >= lo,
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
    injected.push({
      astFindingId: ast.astFindingId,
      path: ast.path,
      line: ast.line,
      score,
      category: ast.roleHint,
      headline,
      body: ast.message,
    })
  }

  return { findings, provenanceFindings, injected }
}
