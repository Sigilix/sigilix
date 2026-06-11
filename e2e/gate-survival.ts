// SIG-392/SIG-393/SIG-395 — POST-GATE SURVIVAL replay (offline, no model
// calls). Takes captured lever-candidate findings from the local harness
// runs, reconstructs the validation-gate inputs the production pipeline
// would build for the frozen fixture, runs `validateForSubmission` with
// PROD gate modes (parsed from wrangler.toml [vars]), and re-scores the
// surviving set — yielding the promotion-critical numbers (post-gate
// recall + post-gate high-sev FP) without waiting for enforce mode.
//
//   npx tsx e2e/gate-survival.ts e2e/.fixture-eval-out/<run>.union.json [...more]
//
// Fidelity caveats (printed with results):
//  - synth is modeled as a pass-through union (recall ≤ union by design;
//    synth retention under load is the separate SIG-350-style check)
//  - captured findings lack `independentAssessment` (the adapter drops
//    it) — refutation-survival/logic-refutation style gates would treat
//    sev>=4 logic findings as rationale-less; in PROD MODES those gates
//    are shadow, so prod-mode results are unaffected
//  - securityManifest / testingEvidence / coverage are absent → those
//    gates no-op (back-compat behavior), matching their disabled state

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { validateForSubmission } from "@/src/lib/ensemble/app/orchestrator-helpers"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import { buildChangedLineTextByPath } from "@/src/lib/ensemble/domain/gates/validate-logic-finding"
import { computeTestToSourceAddedRatio } from "@/src/lib/ensemble/domain/gates/test-ratio-damper"
import { runAstRules, createAstCache } from "@/src/features/ast-rules"
import { resolveAstRulesConfig } from "@/src/lib/sigilix-config"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import { scoreFixture } from "@/evals/scorer"
import { shadowFindingsToFixtureFindings } from "@/evals/local-adapter"
import type { FixtureFinding, FixtureGroundTruth } from "@/evals/fixture-types"
import { FIXTURES_DIR } from "@/e2e/fixture-eval-lib"
import { prodEnvFromWrangler, rebuildSpecialistVerdicts, roleOf } from "@/e2e/replay-shared"

const FIXTURE = "fullstack-pr20-dense"

async function main(): Promise<void> {
  const inputs = process.argv.slice(2)
  if (inputs.length === 0) {
    console.error("usage: npx tsx e2e/gate-survival.ts <findings.union.json> [...more]")
    process.exit(1)
  }

  const dir = join(FIXTURES_DIR, FIXTURE)
  const truth = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8")) as FixtureGroundTruth
  const diff = readFileSync(join(dir, "pr.diff"), "utf8")
  const filesByPath = new Map<string, string>()
  for (const sub of ["server", "shared"]) {
    for (const name of readdirSync(join(dir, "files", sub))) {
      // Stored with a .txt suffix so the repo's inclusive tsconfig doesn't
      // typecheck fixture code; the map key is the real in-repo path.
      filesByPath.set(`${sub}/${name.replace(/\.txt$/, "")}`, readFileSync(join(dir, "files", sub, name), "utf8"))
    }
  }

  const prodEnv = prodEnvFromWrangler()
  // --enforce-all: override every validator to its strictest mode — the
  // CEILING of what this gate layer can filter (vs the prod-mode floor).
  if (process.env.GATE_SURVIVAL_ENFORCE_ALL === "1") {
    for (const k of Object.keys(prodEnv)) {
      if (/VALIDATOR_MODE$|_REFUTATION$|REFUTATION_SURVIVAL_MODE$|_REFUTATION_MODE$/.test(k)) prodEnv[k] = "enforce"
    }
    prodEnv["OPENCLAW_LOGIC_VALIDATOR_MODE"] = "enforce"
    prodEnv["OPENCLAW_PERF_VALIDATOR_MODE"] = "enforce"
    prodEnv["OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE"] = "enforce"
    prodEnv["OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE"] = "enforce"
    prodEnv["OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE"] = "enforce"
    prodEnv["OPENCLAW_LOGIC_REFUTATION_MODE"] = "enforce"
    prodEnv["OPENCLAW_REFUTATION_SURVIVAL_MODE"] = "enforce"
    prodEnv["OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE"] = "enforce"
    prodEnv["OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE"] = "enforce"
    prodEnv["OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE"] = "enforce"
  }
  const config = parseEnsembleConfig(prodEnv)
  const reviewable = parseDiffToReviewablePositions(diff)
  const addedLineTextByLine = buildAddedLineTextByLine(diff)
  const changedLineTextByPath = buildChangedLineTextByPath(diff)
  const astCache = createAstCache()
  const astResult = await runAstRules({
    diff,
    filesByPath,
    reviewable,
    config: resolveAstRulesConfig({}),
    ctx: { owner: "eval", repo: "gate-survival", prNumber: 0 },
    astCache,
  })

  console.log(`# gate-survival replay — ${FIXTURE}, PROD modes from wrangler.toml`)
  console.log(
    `# modes: security=${config.validatorModes.securityValidatorMode} logic=${config.validatorModes.logicValidatorMode} ` +
      `tests=${config.validatorModes.testsValidatorMode} perf=${config.validatorModes.perfValidatorMode} ` +
      `inline-grounding=${config.validatorModes.inlineGroundingValidatorMode} window-blindness=${config.validatorModes.windowBlindnessValidatorMode} ` +
      `logic-claim-refutation=${config.validatorModes.logicClaimRefutationMode}`,
  )

  const aggregate = { preCaught: new Map<string, number>(), postCaught: new Map<string, number>(), runs: 0 }
  for (const input of inputs) {
    const captured = JSON.parse(readFileSync(input, "utf8")) as FixtureFinding[]
    // Rebuild per-role specialist verdicts with REAL stable ids so the
    // hallucination guard's provenance check sees traceable sources.
    const { verdicts: specialistVerdicts } = rebuildSpecialistVerdicts(captured)
    const synthFindings = specialistVerdicts.flatMap((v) => v.verdict!.findings)
    const provenance: SynthesizerProvenance = {
      findings: synthFindings.map((f) => ({
        sourceSpecialists: [roleOf((f as { id?: string }).id ?? "logic")],
        sourceFindingIds: [(f as { id?: string }).id ?? "logic-0"],
        action: "kept" as const,
        verifiedViaRetrieval: false,
      })),
      dropped: [],
    }

    const validated = validateForSubmission({
      trustLedgerEnabled: false,
      synthOutput: {
        verdict: {
          summary: "replay",
          confidence: 3,
          confidenceReason: "replay",
          findings: synthFindings,
        } as PrReviewVerdict,
        provenance,
      },
      reviewable,
      specialistVerdicts,
      astFindingIds: astResult.findings.map((f) => f.astFindingId),
      addedLineTextByLine,
      testToSourceRatio: computeTestToSourceAddedRatio(addedLineTextByLine),
      logicEvidence: {
        changedLineTextByPath,
        astLogicFindings: astResult.findings.filter((f) => f.roleHint === "logic"),
      },
      perfEvidence: {
        changedLineTextByPath,
        astPerfFindings: astResult.findings.filter((f) => f.roleHint === "performance"),
      },
      profile: "chill",
      fullFileByPath: filesByPath,
      astCache,
      wasTruncated: false,
      droppedPaths: [],
      securityValidatorMode: config.validatorModes.securityValidatorMode,
      testsValidatorMode: config.validatorModes.testsValidatorMode,
      logicValidatorMode: config.validatorModes.logicValidatorMode,
      logicRefutationMode: config.validatorModes.logicRefutationMode,
      refutationSurvivalMode: config.validatorModes.refutationSurvivalMode,
      logicClaimRefutationMode: config.validatorModes.logicClaimRefutationMode,
      perfValidatorMode: config.validatorModes.perfValidatorMode,
      inlineGroundingValidatorMode: config.validatorModes.inlineGroundingValidatorMode,
      absenceClaimValidatorMode: config.validatorModes.absenceClaimValidatorMode,
      windowBlindnessValidatorMode: config.validatorModes.windowBlindnessValidatorMode,
      securityGroundingValidatorMode: config.validatorModes.securityGroundingValidatorMode,
      securityUsageValidatorMode: config.validatorModes.securityUsageValidatorMode,
    } as Parameters<typeof validateForSubmission>[0])

    // Re-adapt survivors and score pre vs post.
    const survivors = validated.verdict.findings.map(
      (f, i) =>
        shadowFindingsToFixtureFindings("kept", [
          {
            path: f.path,
            line: f.line,
            score: f.score,
            category: f.category,
            headline: f.headline,
            body: f.body,
          },
        ]).map((x) => ({ ...x, ref: `kept-${i}` }))[0]!,
    )
    const pre = scoreFixture(truth, "sigilix", captured)
    const post = scoreFixture(truth, "sigilix", survivors)
    aggregate.runs += 1
    for (const id of pre.overall.caughtIds) aggregate.preCaught.set(id, (aggregate.preCaught.get(id) ?? 0) + 1)
    for (const id of post.overall.caughtIds) aggregate.postCaught.set(id, (aggregate.postCaught.get(id) ?? 0) + 1)
    console.log(
      `${input.split("/").pop()}: pre ${pre.overall.caught}/20 (hiSevFP ${pre.highSevFalsePositives.length}) → ` +
        `post-gate ${post.overall.caught}/20 (hiSevFP ${post.highSevFalsePositives.length}) | ` +
        `findings ${captured.length}→${survivors.length} | gate drops: invalidLine=${validated.droppedForInvalidLine} ` +
        `halluc=${validated.droppedForHallucination} validation=${validated.droppedForFailedValidation} ` +
        `logic=${validated.droppedForFailedLogicValidation} tests=${validated.droppedForFailedTestValidation}`,
    )
  }

  const rows = [...new Set([...aggregate.preCaught.keys(), ...aggregate.postCaught.keys()])].sort()
  console.log(`\n## per-row survival across ${aggregate.runs} runs (pre → post-gate caught count)`)
  for (const id of rows) {
    const pre = aggregate.preCaught.get(id) ?? 0
    const post = aggregate.postCaught.get(id) ?? 0
    console.log(`${id}: ${pre} → ${post}${post < pre ? "  ⚠️ gate loss" : ""}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
