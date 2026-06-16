// SIG-395 — the invariant-lens phase (app layer): single-charge auditor
// calls that run CONCURRENT with the specialist fan-out (the lens needs no
// pass-1 input — its superpower vs the re-sweep: recall lift at ~zero
// added wall-clock).
//
// Same mode contract as the re-sweep (`OPENCLAW_INVARIANT_LENS_MODE`):
//   off    — inert; `start` returns a settled no-op handle (zero calls).
//   shadow — auditors run + telemetry; candidates NEVER merge.
//   on     — candidates merge into the LOGIC role's verdict pre-synth
//            (logic is the protected role, so it exists whenever the
//            coverage gate passes; falls back to the first succeeded
//            role if logic itself failed) and flow through the
//            UNCHANGED gate stack.
//
// Split into start/apply so the caller can kick the auditors off BEFORE
// awaiting the fan-out and merge after verdict collection:
//
//   const lens = startInvariantLens({...})   // before the fanout await
//   ...fanout, verdict collection, coverage gate...
//   const { verdicts } = await applyInvariantLens({ lens, succeeded, ... })

import type { Env } from "@/src/shared/types/env"
import { type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { modelApiKeys, runSpecialist, SPECIALIST_CONFIGS } from "@/src/lib/ensemble/adapters/model-provider"
import { buildInvariantFamilyPrompt, INVARIANT_FAMILIES } from "@/src/prompts/specialists/invariant-lens"
import { parseSecondPassReasonerMode, secondPassReasonerOverride } from "@/src/lib/ensemble/domain/secondpass-reasoner"
import { SPECIALIST_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { composeSignals } from "@/src/lib/ensemble/domain/shadow-grace"
import { splitDiffByFile } from "@/src/lib/diff-packing"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import {
  countAddedLines,
  decideInvariantDispatch,
  type InvariantLensRecallContract,
  type InvariantLensMode,
} from "@/src/lib/ensemble/domain/invariant-lens"

export interface InvariantLensStartArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  mode: InvariantLensMode
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  diff: string
  /** The user message the specialists received (same diff/context view). */
  userMessage: string
}

interface FamilyOutcome {
  familyId: string
  findings: readonly PrReviewFinding[]
  errored: boolean
}

export interface InvariantLensHandle {
  mode: InvariantLensMode
  /** Resolves when every dispatched auditor settles (never rejects). */
  outcomes: Promise<readonly FamilyOutcome[]>
  dispatched: readonly string[]
  skipped: ReadonlyArray<{ id: string; reason: string }>
  startedAtMs: number
}

/** Kick off the auditor calls (concurrent with the fan-out). Emits the
 *  dispatch decision; in `off` mode returns a settled no-op handle. */
export function startInvariantLens(a: InvariantLensStartArgs): InvariantLensHandle {
  const startedAtMs = Date.now()
  if (a.mode === "off") {
    return { mode: a.mode, outcomes: Promise.resolve([]), dispatched: [], skipped: [], startedAtMs }
  }

  const changedFiles = splitDiffByFile(a.diff)
  const decision = decideInvariantDispatch({
    mode: a.mode,
    familyIds: INVARIANT_FAMILIES.map((f) => f.id),
    diff: a.diff,
    changedFileCount: changedFiles.length,
    addedLineCount: countAddedLines(a.diff),
  })
  console.log(
    JSON.stringify({
      event: "invariant-lens-decision",
      owner: a.owner,
      repo: a.repo,
      prNumber: a.prNumber,
      headSha: a.headSha.slice(0, 7),
      mode: a.mode,
      fired: decision.fire,
      reasons: decision.reasons,
      dispatched: decision.dispatched,
      skipped: decision.skipped,
    }),
  )
  if (!decision.fire) {
    return { mode: a.mode, outcomes: Promise.resolve([]), dispatched: [], skipped: decision.skipped, startedAtMs }
  }

  const chatEnabled = a.env.OLLAMA_CHAT_ENABLE === "on" ? ("on" as const) : ("off" as const)
  // SIG-369(b): default-off second-pass model override. Off → undefined → the
  // call uses SPECIALIST_CONFIGS.logic (moonshotai/kimi-k2.7-code, SIG-450) exactly
  // as today (byte-identical). On → routes these lens re-runs to the cheaper reasoner.
  const lensModelOverride = secondPassReasonerOverride({
    mode: parseSecondPassReasonerMode(a.env.OPENCLAW_SECONDPASS_REASONER_MODE),
    baseConfig: SPECIALIST_CONFIGS.logic,
  })
  const outcomes = Promise.all(
    INVARIANT_FAMILIES.filter((f) => decision.dispatched.includes(f.id)).map(async (family): Promise<FamilyOutcome> => {
      try {
        const r = await runSpecialist({
          // The logic model config — the strongest reasoner; the lens is
          // a reasoning task (derive the rule, then sweep).
          role: "logic",
          apiKeys: modelApiKeys(a.env),
          systemPrompt: buildInvariantFamilyPrompt(family),
          initialMessage: a.userMessage,
          chatEnabled,
          // Same structuring-via-catch contract as the re-sweep phase:
          // any abort/throw degrades this family to zero candidates.
          signal: composeSignals(a.orchCtrl.signal, AbortSignal.timeout(SPECIALIST_TIMEOUT_MS)),
          perfCtx: a.perfCtx,
          // SIG-369(b): absent when off → byte-identical o3 path.
          ...(lensModelOverride !== undefined ? { modelOverride: lensModelOverride } : {}),
        })
        const errored = r.verdict === null
        return { familyId: family.id, findings: errored ? [] : r.verdict!.findings, errored }
      } catch {
        return { familyId: family.id, findings: [], errored: true }
      }
    }),
  )
  return { mode: a.mode, outcomes, dispatched: decision.dispatched, skipped: decision.skipped, startedAtMs }
}

export interface InvariantLensApplyResult {
  verdicts: readonly CollectedVerdict[]
  lensFindingIds: readonly string[]
}

/** Await the auditors and (mode `on`) merge candidates into the logic
 *  role's verdict. Shadow telemeters and passes through untouched. */
export async function applyInvariantLens(args: {
  lens: InvariantLensHandle
  succeeded: readonly CollectedVerdict[]
  owner: string
  repo: string
  prNumber: number
  headSha: string
  diff: string
  executionLane?: "default" | "background" | "amendment"
  recallContract?: InvariantLensRecallContract
}): Promise<InvariantLensApplyResult> {
  const passthrough: InvariantLensApplyResult = { verdicts: args.succeeded, lensFindingIds: [] }
  if (args.lens.mode === "off" || args.lens.dispatched.length === 0) return passthrough

  const outcomes = await args.lens.outcomes
  // Anchored-to-diff guard: the lens sees the whole diff, so the only
  // ungroundable candidates are ones anchored OUTSIDE the changed files.
  const changedPaths = new Set(splitDiffByFile(args.diff).map((b) => b.path))
  const kept: PrReviewFinding[] = []
  let candidates = 0
  let highSeverityCandidates = 0
  let outOfDiffDropped = 0
  for (const o of outcomes) {
    for (const f of o.findings) {
      candidates += 1
      if (f.score >= 4) highSeverityCandidates += 1
      if (changedPaths.has(f.path)) kept.push(f)
      else outOfDiffDropped += 1
    }
  }
  const elapsedMs = Date.now() - args.lens.startedAtMs
  const target = args.succeeded.find((v) => v.role === "logic" && v.verdict !== null) ?? args.succeeded[0]
  const mergedIntoSynth = args.lens.mode === "on" && kept.length > 0 && target !== undefined && target.verdict !== null
  console.log(
    JSON.stringify({
      event: args.lens.mode === "shadow" ? "invariant-lens-shadow-summary" : "invariant-lens-summary",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      mode: args.lens.mode,
      executionLane: args.executionLane ?? "default",
      recallContract: args.recallContract ?? "blocking",
      mergedIntoSynth,
      perFamily: outcomes.map((o) => ({ family: o.familyId, findings: o.findings.length, errored: o.errored })),
      candidates,
      highSeverityCandidates,
      highSeverityKeptCandidates: kept.filter((f) => f.score >= 4).length,
      outOfDiffDropped,
      keptCandidates: kept.length,
      elapsedMs,
    }),
  )
  if (args.lens.mode === "shadow" || kept.length === 0) return passthrough

  // Merge target: logic (protected role — present whenever the coverage
  // gate passed and logic was dispatched); else the first succeeded role.
  if (!target || target.verdict === null) return passthrough
  const lensFindingIds: string[] = []
  const verdicts = args.succeeded.map((v) => {
    if (v !== target) return v
    const before = v.verdict!.findings.length
    const merged = assignStableFindingIds(v.role, {
      ...v.verdict!,
      findings: [...v.verdict!.findings, ...kept],
    })
    for (let i = before; i < merged.findings.length; i++) lensFindingIds.push(merged.findings[i]!.id)
    return { ...v, verdict: merged }
  })
  return { verdicts, lensFindingIds }
}
