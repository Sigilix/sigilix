// PTS SIG-578 — deep-work continuity BASELINE (LIVE). Drives each scenario through the
// conditions on a REAL model and prints a condition x metric scorecard PER SCENARIO and
// pooled (task success, working-state retention, tokens-to-completion, latency), with 95%
// CIs and deltas vs Control-B.
//
// This is a LIVE test: it makes real model calls, so it is gated on a provider key and
// SKIPS in normal CI (`npm run build`). The pure scoring/plumbing is regression-guarded by
// pts-continuity-score.test.ts, which runs in CI with no key.
//
// Key selection follows the logic-recall ruler (SIG-406): the key is chosen by the model's
// id shape — an OpenRouter slash id (the default) -> OPENROUTER_API_KEY; a `:cloud` tag ->
// OLLAMA_API_KEY (Ollama Turbo, no OpenRouter spend). Put whichever key(s) you have in the
// gitignored `.dev.vars` and run:
//
//   # prod-shaped model on OpenRouter (default openai/gpt-oss-120b):
//   OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY' .dev.vars | cut -d= -f2-)" npm run pts-continuity-eval
//
//   # pin an Ollama Turbo :cloud model instead (no OpenRouter spend):
//   PTS_MODEL=deepseek-v4-pro:cloud \
//     OLLAMA_API_KEY="$(grep -E '^OLLAMA_API_KEY' .dev.vars | cut -d= -f2-)" npm run pts-continuity-eval
//
// Knobs: PTS_MODEL (model id), PTS_RUNS (runs/condition/scenario, default 5 — a single pass
// is noise; per the repo model-eval standard use K>=12 for any delta you'll ACT on),
// PTS_SCENARIOS (comma-separated scenario ids), PTS_TREATMENT (registered treatment
// compactor id — none ship yet, so treatment is SKIPPED unless one is registered; a name
// supplied but not registered is a hard error, never a silent skip).

import { describe, it, expect } from "vitest"
import { CONTINUITY_SCENARIOS, aggregateCondition, type RunMetrics, type Scenario } from "./pts-continuity-corpus"
import {
  runContinuitySession,
  standardConditions,
  resolveTreatmentCompactor,
  gatewayModelClient,
  continuityApiKey,
  type Condition,
  type ModelClient,
} from "./pts-continuity-harness"
import { buildScorecard, formatScorecard } from "./pts-continuity-scorecard"

const MODEL = process.env.PTS_MODEL?.trim() || "openai/gpt-oss-120b"
const RUNS = (() => {
  const n = Number(process.env.PTS_RUNS ?? 5)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5
})()
const API_KEY = continuityApiKey(MODEL, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
const SCENARIO_IDS =
  process.env.PTS_SCENARIOS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? []
const SCENARIOS = SCENARIO_IDS.length
  ? CONTINUITY_SCENARIOS.filter((s) => SCENARIO_IDS.includes(s.id))
  : CONTINUITY_SCENARIOS

// Every run is many sequential model calls (build-up + probes + final, plus a compaction
// call on Control-B). Budget generously per condition and overall.
const PER_RUN_TIMEOUT_MS = 240_000
const MAX_CONDITIONS = 3 // control-a + control-b + (optional) treatment
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

/** Run every (condition x RUNS) for one scenario, logging each run. */
async function runScenario(
  scenario: Scenario,
  conditions: Condition[],
  model: ModelClient,
): Promise<Map<string, RunMetrics[]>> {
  const byCondition = new Map<string, RunMetrics[]>()
  for (const c of conditions) byCondition.set(c.id, [])
  for (const c of conditions) {
    for (let k = 0; k < RUNS; k++) {
      const m = await runContinuitySession({ scenario, compactor: c.compactor, model })
      byCondition.get(c.id)!.push(m)
      console.log(
        `[pts] ${scenario.id.padEnd(24)} ${c.id.padEnd(12)} run ${k + 1}/${RUNS}: ` +
          `${m.errored ? `ERROR: ${m.errorMessage ?? "unknown"}` : `retention ${pct(m.retention)} · success ${m.taskSuccess ? "Y" : "N"} · ${m.tokens} tok · ${m.latencyMs}ms`}`,
      )
    }
  }
  return byCondition
}

describe.skipIf(!API_KEY)(
  "PTS deep-work continuity baseline (LIVE — needs OLLAMA_API_KEY or OPENROUTER_API_KEY)",
  () => {
    it(
      "measures Control-A (no reset) vs Control-B (naive compaction) [+ Treatment if registered], per scenario + pooled",
      async () => {
        const model = gatewayModelClient(MODEL, API_KEY as string)
        const requestedTreatment = process.env.PTS_TREATMENT?.trim()
        const treatment = resolveTreatmentCompactor(requestedTreatment)
        // A supplied-but-unresolved treatment name is a hard error — a silent skip would
        // measure the WRONG conditions and quietly mislabel the baseline.
        if (requestedTreatment && !treatment) {
          throw new Error(
            `PTS_TREATMENT="${requestedTreatment}" is not a registered treatment compactor — ` +
              `register it via registerTreatmentCompactor(...) or unset PTS_TREATMENT.`,
          )
        }
        const conditions = standardConditions(treatment)
        if (!treatment) {
          console.log("[pts] treatment condition SKIPPED — no PTS compactor registered (stub seam ready).")
        }

        // Collect runs keyed by scenario so a loose scenario can't contaminate a
        // well-guarded one — we report PER-SCENARIO and pooled.
        const perScenario = new Map<string, Map<string, RunMetrics[]>>()
        for (const scenario of SCENARIOS) {
          perScenario.set(scenario.id, await runScenario(scenario, conditions, model))
        }

        // Per-scenario scorecards (never only pooled — the headline is per-scenario A-B).
        for (const scenario of SCENARIOS) {
          const runs = perScenario.get(scenario.id)!
          const aggregates = conditions.map((c) => aggregateCondition(c.id, runs.get(c.id)!))
          const sc = buildScorecard({
            model: MODEL,
            scenarioIds: [scenario.id],
            runsPerCondition: RUNS,
            baselineId: "control-b",
            aggregates,
          })
          console.log(formatScorecard(sc))
        }

        // Pooled scorecard across all scenarios (kept alongside, never instead of, per-scenario).
        const pooled = conditions.map((c) =>
          aggregateCondition(
            c.id,
            SCENARIOS.flatMap((s) => perScenario.get(s.id)!.get(c.id)!),
          ),
        )
        const pooledCard = buildScorecard({
          model: MODEL,
          scenarioIds: SCENARIOS.map((s) => s.id),
          runsPerCondition: RUNS * SCENARIOS.length,
          baselineId: "control-b",
          aggregates: pooled,
        })
        console.log("\n[pts] POOLED across scenarios:")
        console.log(formatScorecard(pooledCard))
        console.log("\n[pts] pooled scorecard JSON:\n" + JSON.stringify(pooledCard, null, 2))

        // Plumbing guard only — never assert a model-behavior direction on a small N (it
        // would flake). The baseline NUMBERS live in the printed scorecards; the expected
        // direction (Control-A retention >= Control-B) is reported there, not asserted.
        const controlA = pooled.find((a) => a.condition === "control-a")!
        expect(controlA.n, "Control-A produced at least one non-errored run").toBeGreaterThan(0)
      },
      SCENARIOS.length * MAX_CONDITIONS * RUNS * PER_RUN_TIMEOUT_MS + 60_000,
    )
  },
)
