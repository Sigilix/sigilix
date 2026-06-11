// SIG-318 (PR 12c) — the RECALL-FLOOR tail of the specialists+synth app phase,
// split out of `runSpecialistsAndSynthesize` (ensemble/app/specialists.ts) only
// to keep each app file under the 1k-line cap. Carved verbatim from
// `handlePrReviewEnsemble`: the SIG-317 truncation-recovery, SIG-351 source-
// finding floor, SIG-287 degraded-coverage floor, and SIG-317-step-6 AST-emit
// floor — each a recall-only re-injection that flows through the SAME post-synth
// gates downstream (the floors never force-post). The moved statements are
// byte-identical; only the function wrapper + the explicit arg/result plumbing
// is new. ZERO behavior change.
//
// The synth verdict + provenance enter NON-NULLABLE (the parse-fail bail in the
// caller returns otherwise), so the floors mutate locals and hand the caller
// back the (still non-null) `effectiveSynthVerdict`/`effectiveSynthProvenance`.
//
// Dependency rule: imports the floor installers laterally from the
// `degraded-finding-floor` leaf + domain/shared types; never the orchestrator.

import { runAstRules } from "@/src/features/ast-rules"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import {
  applyDegradedCoverageFindingFloor,
  applySynthSourceFindingFloor,
  recoverTruncatedSynthFindings,
  injectUnmatchedAstEmits,
} from "@/src/lib/degraded-finding-floor"

type AstResult = Awaited<ReturnType<typeof runAstRules>>
/** The synth-input verdicts produced by `buildSynthInputVerdicts(succeeded)`. */
type SynthInputVerdict = CollectedVerdict & { verdict: PrReviewVerdictWithIds }

export interface RecallFloorsArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  ensembleConfig: EnsembleConfig
  /** The synth verdict, NON-NULL (caller's parse-fail bail returns otherwise). */
  synthVerdict: PrReviewVerdict
  /** The synth provenance, NON-NULL (caller's parse-fail bail returns otherwise). */
  synthProvenance: SynthesizerProvenance
  synthInputVerdicts: ReadonlyArray<SynthInputVerdict>
  astResult: AstResult
  degradedCoverage: { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } | null
}

export interface RecallFloorsResult {
  effectiveSynthVerdict: PrReviewVerdict
  effectiveSynthProvenance: SynthesizerProvenance
}

export function applyRecallFloors(a: RecallFloorsArgs): RecallFloorsResult {
  const {
    owner,
    repo,
    prNumber,
    headSha,
    ensembleConfig,
    synthVerdict,
    synthProvenance,
    synthInputVerdicts,
    astResult,
    degradedCoverage,
  } = a
  // `synthVerdict`/`synthProvenance` enter NON-NULL (the caller's parse-fail
  // bail returns otherwise). Capture into locals so the floors can replace them
  // for validation WITHOUT reassigning the synth output (which would widen its
  // type back to nullable + perturb the downstream soften path that reads
  // `synthOutput.provenance.softened`).
  let effectiveSynthVerdict = synthVerdict
  let effectiveSynthProvenance = synthProvenance

  // SIG-317: synth verdict-truncation recovery (runs BEFORE the degraded floor
  // so recovery re-aligns verdict↔provenance first). On target-rich PRs the
  // synth writes a COMPLETE provenance but a SHORTER verdict.findings — it
  // details the top-ranked findings (security-first) and silently truncates
  // the verbose tail, losing real subtle findings it MARKED KEPT (pr/10:
  // provenance 20, verdict 8 — a score-5 N+1, the cents bug, a floating
  // promise all lost). Recover the tail from the cited specialist sources; the
  // recovered findings flow through the SAME post-synth gates below, so this
  // CANNOT lower precision — the gates remain the authority. Modes:
  // `off` (default) inert, `shadow` logs the recoverable count, `on` applies.
  //
  // The helper ALWAYS returns a 1:1-aligned (verdict, provenance) pair — it
  // trims the truncated orphan tail to verdict length, then re-appends only the
  // recovered entries. So in `on` we install the result UNCONDITIONALLY whenever
  // the truncation branch runs, even when nothing qualified for recovery: the
  // trim alone re-aligns the arrays so the degraded floor downstream appends
  // onto an aligned base (otherwise the stale longer provenance survives and
  // validateForSubmission mispairs the floor's restored findings — Codex SIG-317
  // review). The non-recovered case is behavior-identical for posting (the
  // ignored tail was never paired), so trimming it costs no recall. Orphans
  // citing only AST-emit ids are NOT recovered here (sourceById is specialist-
  // only) — AST/SIG-310 deterministic recovery is a deliberate Part-1 gap,
  // fast-follow; it is precision-safe (those emits were already truncated).
  const synthRecoveryMode = ensembleConfig.flags.synthRecovery
  if (synthRecoveryMode !== "off" && effectiveSynthProvenance.findings.length > effectiveSynthVerdict.findings.length) {
    const sourceById = new Map<string, PrReviewFinding & { id: string }>()
    for (const v of synthInputVerdicts) {
      for (const f of v.verdict?.findings ?? []) {
        const id = (f as { id?: unknown }).id
        if (typeof id === "string") sourceById.set(id, f as PrReviewFinding & { id: string })
      }
    }
    const rec = recoverTruncatedSynthFindings({
      findings: effectiveSynthVerdict.findings,
      provenanceFindings: effectiveSynthProvenance.findings,
      sourceById,
    })
    if (rec.recovered.length > 0) {
      console.log(
        JSON.stringify({
          event: "pr-review-synth-truncation-recovered",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: synthRecoveryMode,
          verdictLen: effectiveSynthVerdict.findings.length,
          provenanceLen: effectiveSynthProvenance.findings.length,
          recoveredCount: rec.recovered.length,
          recovered: rec.recovered.map((r) => ({ id: r.id, score: r.score, category: r.category })),
        }),
      )
    }
    if (synthRecoveryMode === "on") {
      // Install unconditionally — `rec` is always aligned (trim ± recovery).
      effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: rec.findings }
      effectiveSynthProvenance = { ...effectiveSynthProvenance, findings: rec.provenanceFindings }
    }
  }

  // SIG-351: full-coverage source-finding floor. Prompt-level FP
  // adjudication is allowed ONLY when the synth records a proof-like drop
  // (`false positive on diff inspection` / AST supersession). If a score>=4
  // source finding is neither represented in kept provenance nor proof-dropped,
  // restore it before validation. This is recall-only: restored findings still
  // pass through the normal hallucination, grounding, validator, anchor, and
  // rendering gates below.
  {
    const floored = applySynthSourceFindingFloor({
      findings: effectiveSynthVerdict.findings,
      provenanceFindings: effectiveSynthProvenance.findings,
      provenanceDropped: effectiveSynthProvenance.dropped,
      specialists: synthInputVerdicts
        .filter((v) => v.verdict !== null)
        .map((v) => ({ role: v.role, findings: v.verdict!.findings })),
      // SIG-351: verify `superseded_by_ast/<id>` suppressions against the REAL
      // AST id set — same source SIG-314 uses for the kept-path hallucination
      // guard (validateForSubmission's `astFindingIds`, below). A spoofed
      // `<id>` is NOT honored, so the floor restores the finding (recall-safe).
      astFindingIds: new Set(astResult.findings.map((f) => f.astFindingId)),
    })
    if (floored.restored.length > 0) {
      effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: floored.findings }
      effectiveSynthProvenance = {
        ...effectiveSynthProvenance,
        findings: floored.provenanceFindings,
      }
      console.log(
        JSON.stringify({
          event: "pr-review-synth-source-findings-restored",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          restoredCount: floored.restored.length,
          restored: floored.restored.map((r) => ({ role: r.role, id: r.id, score: r.score })),
        }),
      )
    }
  }

  if (degradedCoverage) {
    const floored = applyDegradedCoverageFindingFloor({
      findings: effectiveSynthVerdict.findings,
      provenanceFindings: effectiveSynthProvenance.findings,
      specialists: synthInputVerdicts
        .filter((v) => v.verdict !== null)
        .map((v) => ({ role: v.role, findings: v.verdict!.findings })),
    })
    if (floored.restored.length > 0) {
      effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: floored.findings }
      effectiveSynthProvenance = {
        ...effectiveSynthProvenance,
        findings: floored.provenanceFindings,
      }
      console.log(
        JSON.stringify({
          event: "pr-review-degraded-source-findings-restored",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          rolesMissing: degradedCoverage.rolesMissing,
          restoredCount: floored.restored.length,
          restored: floored.restored.map((r) => ({ role: r.role, id: r.id, score: r.score })),
        }),
      )
    }
  }

  // SIG-317 step 6 Part A: deterministic AST-emit injection floor. Force-
  // SURFACE any `emitWhenUnmatched` (warning/info) AST finding the synth did
  // NOT emit — the proven subtle needle (cents-as-dollars, enum drift) the
  // model crowded out of its verdict tail. The injected finding cites the
  // `astFindingId` (SIG-314 admits it) and flows through every post-synth gate
  // below, so nothing is force-posted; it just can't be silently dropped.
  // `off` skips; `shadow` logs what WOULD inject (no behavior change); `on`
  // injects. Recall-positive + P2/P3-capped (never mints a P0/P1).
  // Validated parse — a misconfig / typo FAILS CLOSED to "off" rather than
  // silently enabling on any non-"off" string (CodeRabbit/Sigilix #330).
  const astEmitFloorMode = ensembleConfig.flags.astEmitFloorMode
  if (astEmitFloorMode !== "off") {
    const floored = injectUnmatchedAstEmits({
      findings: effectiveSynthVerdict.findings,
      provenanceFindings: effectiveSynthProvenance.findings,
      astFindings: astResult.findings,
    })
    if (floored.injected.length > 0) {
      console.log(
        JSON.stringify({
          event: "pr-review-ast-emit-floor-injected",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: astEmitFloorMode,
          injectedCount: floored.injected.length,
          injected: floored.injected,
        }),
      )
      if (astEmitFloorMode === "on") {
        effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: floored.findings }
        effectiveSynthProvenance = {
          ...effectiveSynthProvenance,
          findings: floored.provenanceFindings,
        }
      }
    }
  }

  return { effectiveSynthVerdict, effectiveSynthProvenance }
}
