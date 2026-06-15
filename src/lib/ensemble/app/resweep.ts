// SIG-393 — the region re-sweep phase (app layer): bounded second-pass
// model calls over already-flagged regions, between specialist verdict
// collection and synth.
//
// Modes (`OPENCLAW_RESWEEP_MODE`, default off):
//   off    — phase is inert (gate still logs nothing; zero cost).
//   shadow — re-sweep runs + telemetry, candidates are NOT merged.
//            Zero posted-output change; this is the rollout's first stop.
//   on     — candidates merge into the role verdicts pre-synth and flow
//            through the UNCHANGED gate stack (validation, grounding,
//            verification, trust ledger). No new posting surface.
//
// Evidence base + design: docs/superpowers/specs/2026-06-11-sig-393-region-resweep-spec.md
// (file-level regions; the gates are the precision backstop — the
// prototype measured ~9.5 ungated hi-sev FP/run alongside the recall lift,
// which is exactly the load the believability gates exist to carry).

import type { Env } from "@/src/shared/types/env"
import { type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { modelApiKeys, runSpecialist, SPECIALIST_CONFIGS } from "@/src/lib/ensemble/adapters/model-provider"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import { parseSecondPassReasonerMode, secondPassReasonerOverride } from "@/src/lib/ensemble/domain/secondpass-reasoner"
import { SPECIALIST_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { composeSignals } from "@/src/lib/ensemble/domain/shadow-grace"
import { splitDiffByFile } from "@/src/lib/diff-packing"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import {
  buildResweepGuidance,
  decideResweepGate,
  selectResweepRegions,
  type ResweepFindingRef,
  type ResweepMode,
  type ResweepRegion,
} from "@/src/lib/ensemble/domain/resweep"

export interface ResweepArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  mode: ResweepMode
  maxRegions: number
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  diff: string
  /** The collected pass-1 verdicts (post coverage gate, so non-empty). */
  succeeded: readonly CollectedVerdict[]
}

export interface ResweepResult {
  /** In `on` mode with candidates: the merged verdicts synth consumes.
   *  Otherwise the input array unchanged. */
  verdicts: readonly CollectedVerdict[]
  /** Finding ids added by the re-sweep (telemetry provenance — the
   *  finding objects themselves are untouched, no renderer change). */
  resweepFindingIds: readonly string[]
}

function correlation(a: ResweepArgs): Record<string, string | number> {
  return { owner: a.owner, repo: a.repo, prNumber: a.prNumber, headSha: a.headSha.slice(0, 7) }
}

/** Project the pass-1 findings into the gate/guidance shape. */
function findingRefs(succeeded: readonly CollectedVerdict[]): ResweepFindingRef[] {
  return succeeded.flatMap(
    (v) =>
      v.verdict?.findings.map((f) => ({
        path: f.path,
        line: f.line,
        category: f.category,
        score: f.score,
      })) ?? [],
  )
}

export async function runResweepPhase(a: ResweepArgs): Promise<ResweepResult> {
  const passthrough: ResweepResult = {
    verdicts: a.succeeded,
    resweepFindingIds: [],
  }
  if (a.mode === "off") return passthrough

  const refs = findingRefs(a.succeeded)
  const diffBlocks = new Map(splitDiffByFile(a.diff).map((b) => [b.path, b.body]))
  const addedLinesByPath = new Map(
    [...diffBlocks].map(([path, body]) => [
      path,
      body.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    ]),
  )

  const gate = decideResweepGate({ mode: a.mode, findings: refs, addedLinesByPath })
  console.log(
    JSON.stringify({
      event: "resweep-gate-decision",
      ...correlation(a),
      mode: a.mode,
      fired: gate.fire,
      reasons: gate.reasons,
      flaggedRegions: gate.flaggedPaths.length,
    }),
  )
  if (!gate.fire) return passthrough

  const { regions, droppedPaths } = selectResweepRegions({
    flaggedPaths: gate.flaggedPaths,
    diffBlocks,
    findings: refs,
    maxRegions: a.maxRegions,
  })
  if (regions.length === 0) return passthrough

  const startedAtMs = Date.now()
  const roles = a.succeeded.map((v) => v.role)
  const chatEnabled = a.env.OLLAMA_CHAT_ENABLE === "on" ? ("on" as const) : ("off" as const)
  // SIG-369(b): default-off second-pass model override, applied ONLY to the
  // LOGIC role's re-sweep calls — logic runs on openai/o3 (the expensive model
  // this lever targets); security/perf/tests keep their own cheaper configs
  // untouched. Off → undefined → byte-identical o3 path for logic.
  const logicResweepOverride = secondPassReasonerOverride({
    mode: parseSecondPassReasonerMode(a.env.OPENCLAW_SECONDPASS_REASONER_MODE),
    baseConfig: SPECIALIST_CONFIGS.logic,
  })

  // Per region × succeeded role. Bounded: regions ≤ maxRegions, roles ≤ 4,
  // each call under the standard per-specialist timeout + orch abort.
  const jobs = regions.flatMap((region) => roles.map((role) => ({ role, region })))
  const results = await Promise.all(
    jobs.map(async (job) => {
      const initialMessage = buildSpecialistInitialMessage({
        prNumber: a.prNumber,
        // Names the file, never a bug (the don't-coach rule).
        title: `Focused re-review: ${job.region.path}`,
        body: "",
        diff: job.region.diffSlice,
        retrievalSnapshot: "",
        namespace: "resweep",
        guidance: buildResweepGuidance(job.region),
      })
      try {
        const r = await runSpecialist({
          role: job.role,
          apiKeys: modelApiKeys(a.env),
          systemPrompt: SPECIALIST_PROMPTS[job.role],
          initialMessage,
          chatEnabled,
          // Deliberate divergence from the fanout's `withComposedTimeout`
          // grace pattern: the catch below IS the structuring here — any
          // abort/throw maps to `{findings: [], errored: true}` and the
          // phase degrades to passthrough. Candidates are additive, so a
          // lost call can never corrupt the pass-1 verdicts.
          signal: composeSignals(a.orchCtrl.signal, AbortSignal.timeout(SPECIALIST_TIMEOUT_MS)),
          perfCtx: a.perfCtx,
          // SIG-369(b): override the LOGIC role's model only (absent for other
          // roles AND when the flag is off → byte-identical to today).
          ...(job.role === "logic" && logicResweepOverride !== undefined
            ? { modelOverride: logicResweepOverride }
            : {}),
        })
        return { job, findings: r.verdict?.findings ?? [], errored: r.verdict === null }
      } catch {
        return { job, findings: [], errored: true }
      }
    }),
  )

  // Region-scope guard: a re-sweep call saw ONLY its region's diff slice, so
  // any finding it anchors outside that file is ungroundable — drop it here
  // rather than sending the gates a finding about code the model never saw.
  const keptByRole = new Map<CollectedVerdict["role"], PrReviewFinding[]>()
  let candidateCount = 0
  let outOfRegionDropped = 0
  let erroredCalls = 0
  for (const r of results) {
    if (r.errored) erroredCalls += 1
    for (const f of r.findings) {
      candidateCount += 1
      if (f.path !== r.job.region.path) {
        outOfRegionDropped += 1
        continue
      }
      const list = keptByRole.get(r.job.role) ?? []
      list.push(f)
      keptByRole.set(r.job.role, list)
    }
  }

  const elapsedMs = Date.now() - startedAtMs
  const summary = {
    event: a.mode === "shadow" ? "resweep-shadow-summary" : "resweep-summary",
    ...correlation(a),
    mode: a.mode,
    regions: regions.map((r: ResweepRegion) => r.path),
    droppedRegions: droppedPaths,
    extraCalls: jobs.length,
    erroredCalls,
    candidates: candidateCount,
    outOfRegionDropped,
    keptCandidates: candidateCount - outOfRegionDropped,
    elapsedMs,
  }
  console.log(JSON.stringify(summary))

  if (a.mode === "shadow" || keptByRole.size === 0) return passthrough

  // Merge (mode "on"): append each role's kept candidates to that role's
  // verdict, then re-assign stable ids. Ids are positional (`role-i`), so
  // pass-1 findings keep their exact ids and the additions take the next
  // indices — downstream consumers see one larger verdict per role.
  const resweepFindingIds: string[] = []
  const verdicts = a.succeeded.map((v) => {
    const additions = keptByRole.get(v.role)
    if (!additions || additions.length === 0 || v.verdict === null) return v
    const before = v.verdict.findings.length
    const merged = assignStableFindingIds(v.role, {
      ...v.verdict,
      findings: [...v.verdict.findings, ...additions],
    })
    for (let i = before; i < merged.findings.length; i++) {
      resweepFindingIds.push(merged.findings[i]!.id)
    }
    return { ...v, verdict: merged }
  })
  return { verdicts, resweepFindingIds }
}
