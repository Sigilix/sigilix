// PTS SIG-578 — deep-work continuity BASELINE (LIVE). Drives each scenario through the
// three conditions on a REAL model and prints the condition x metric scorecard (task
// success, working-state retention, tokens-to-completion, latency), with 95% CIs and
// deltas vs Control-B.
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
// Knobs: PTS_MODEL (model id), PTS_RUNS (runs/condition, default 3), PTS_SCENARIOS
// (comma-separated scenario ids), PTS_TREATMENT (registered treatment compactor id — none
// ship yet, so the treatment condition is SKIPPED until a later SIG-578-series issue
// registers one via registerTreatmentCompactor).

import { describe, it, expect } from "vitest"
import { CONTINUITY_SCENARIOS, aggregateCondition, type RunMetrics } from "./pts-continuity-corpus"
import {
  runContinuitySession,
  standardConditions,
  resolveTreatmentCompactor,
  gatewayModelClient,
  continuityApiKey,
} from "./pts-continuity-harness"
import { buildScorecard, formatScorecard } from "./pts-continuity-scorecard"

const MODEL = process.env.PTS_MODEL?.trim() || "openai/gpt-oss-120b"
const RUNS = (() => {
  const n = Number(process.env.PTS_RUNS ?? 3)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3
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
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

describe.skipIf(!API_KEY)(
  "PTS deep-work continuity baseline (LIVE — needs OLLAMA_API_KEY or OPENROUTER_API_KEY)",
  () => {
    it(
      "measures Control-A (no reset) vs Control-B (naive compaction) [+ Treatment if registered]",
      async () => {
        const model = gatewayModelClient(MODEL, API_KEY as string)
        const treatment = resolveTreatmentCompactor(process.env.PTS_TREATMENT)
        const conditions = standardConditions(treatment)
        if (!treatment) {
          console.log("[pts] treatment condition SKIPPED — no PTS compactor registered (stub seam ready).")
        }

        // runs per condition, pooled across scenarios x repeats.
        const byCondition = new Map<string, RunMetrics[]>()
        for (const c of conditions) byCondition.set(c.id, [])

        for (const scenario of SCENARIOS) {
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
        }

        const aggregates = conditions.map((c) => aggregateCondition(c.id, byCondition.get(c.id)!))
        const scorecard = buildScorecard({
          model: MODEL,
          scenarioIds: SCENARIOS.map((s) => s.id),
          runsPerCondition: RUNS * SCENARIOS.length,
          baselineId: "control-b",
          aggregates,
        })
        console.log(formatScorecard(scorecard))
        console.log("\n[pts] scorecard JSON:\n" + JSON.stringify(scorecard, null, 2))

        // Plumbing guard only — never assert a model-behavior direction on a small N (it
        // would flake). The baseline NUMBERS live in the printed scorecard; the expected
        // direction (Control-A retention >= Control-B) is reported there, not asserted.
        const controlA = aggregates.find((a) => a.condition === "control-a")!
        expect(controlA.n, "Control-A produced at least one non-errored run").toBeGreaterThan(0)
      },
      SCENARIOS.length * (2 + 1) * RUNS * PER_RUN_TIMEOUT_MS + 60_000,
    )
  },
)
