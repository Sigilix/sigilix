// SIG-398 — local fixture eval (LIVE: real specialists via Ollama Turbo).
//
// Runs the four review specialists locally against a frozen fixture diff
// (`evals/fixtures/<name>/pr.diff`), K times, scores every repeat with the
// SIG-397 scorer, and writes the per-row stability report + findings JSONs
// to `e2e/.fixture-eval-out/`. This is the fast A/B bed for the SIG-392
// recall levers — minutes per iteration instead of a GitHub round-trip.
//
//   OLLAMA_API_KEY=… FIXTURE_EVAL_REPEATS=8 npm run fixture-eval
//
// Env:
//   FIXTURE_EVAL_FIXTURE     fixture dir name (default fullstack-pr20-dense)
//   FIXTURE_EVAL_REPEATS     K (default 1; ≥5 recommended, K≥12 for numbers you act on)
//   FIXTURE_EVAL_ROLES       comma list (default logic,security,performance,tests)
//   FIXTURE_EVAL_MODEL_<ROLE> primary-model override for bake-offs (nulls the fallback,
//                            same single-model discipline as LOGIC_RECALL_MODEL)
//
// Context is MINIMAL (diff only — no retrieval/graph/AST evidence blocks):
// scores compare against the committed local-minimal baseline, never prod.
// Gated on OLLAMA_API_KEY like every live eval — skips without it, so
// `npm run build` / CI never spend model calls.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { scoreFixture } from "@/evals/scorer"
import { unionFixtureFindings } from "@/evals/local-adapter"
import { foldRuns, formatLocalEvalReport, loadFixture, type RepeatOutcome } from "@/e2e/fixture-eval-lib"
import {
  PER_ROLE_TIMEOUT_MS,
  buildFixtureMessage,
  hasAnyEvalApiKey,
  rolesFromEnv,
  runRole,
} from "@/e2e/fixture-eval-runner"

// SIG-406: gate on EITHER provider key — a `:cloud` override runs on Ollama Turbo,
// the prod OpenRouter default + OPENROUTER_API_KEY runs on OpenRouter. runRole picks
// the matching key by the role's effective model shape.
const HAS_KEY = hasAnyEvalApiKey()
const FIXTURE_NAME = process.env.FIXTURE_EVAL_FIXTURE ?? "fullstack-pr20-dense"
const REPEATS = (() => {
  const raw = process.env.FIXTURE_EVAL_REPEATS
  const n = Number(raw ?? 1)
  const parsed = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  // A typo'd K silently running a single pass is the "one run is noise"
  // trap — warn loudly when the env value didn't parse to what was asked.
  if (raw !== undefined && String(parsed) !== raw.trim()) {
    console.warn(`[fixture-eval] FIXTURE_EVAL_REPEATS=${JSON.stringify(raw)} parsed as K=${parsed}`)
  }
  return parsed
})()
const ROLES = rolesFromEnv(process.env.FIXTURE_EVAL_ROLES)
const OUT_DIR = join(process.cwd(), "e2e", ".fixture-eval-out")

describe.skipIf(!HAS_KEY)(`local fixture eval — ${FIXTURE_NAME} (LIVE)`, () => {
  it(
    `runs ${ROLES.join("+")} ×${REPEATS} and scores every repeat`,
    { timeout: (PER_ROLE_TIMEOUT_MS + 30_000) * REPEATS },
    async () => {
      const fixture = loadFixture(FIXTURE_NAME)
      // The PR's REAL title — what the bots saw on the benchmark run.
      // Faithful input; names no specific planted bug.
      const userMessage = buildFixtureMessage({ title: fixture.prTitle, diff: fixture.diff })
      mkdirSync(OUT_DIR, { recursive: true })

      const outcomes: RepeatOutcome[] = []
      for (let repeat = 1; repeat <= REPEATS; repeat++) {
        const startedAt = Date.now()
        const roleRuns = await Promise.all(ROLES.map((role) => runRole({ role, userMessage })))
        const erroredRoles = ROLES.filter((_, i) => roleRuns[i]!.errored)
        const union = unionFixtureFindings(roleRuns.map((r) => r.findings))
        // Persist findings BEFORE scoring: an ambiguity throw (the scorer's
        // tighten-the-rules signal on a novel finding shape) must never
        // discard the paid model output — fix the rules, rescore offline
        // via `evals score --findings`, no re-spend.
        const findingsPath = join(OUT_DIR, `${FIXTURE_NAME}.run${repeat}.findings.json`)
        writeFileSync(findingsPath, JSON.stringify(union, null, 2) + "\n")
        const score = scoreFixture(fixture.truth, "sigilix", union)
        const elapsedMs = Date.now() - startedAt
        outcomes.push({ repeat, score, erroredRoles: erroredRoles as string[], elapsedMs })
        console.log(
          `[fixture-eval] repeat ${repeat}/${REPEATS}: recall ${score.overall.caught}/${score.overall.total}, ` +
            `precision ${score.precisionNumerator}/${score.precisionDenominator}, ` +
            `hiSevFP ${score.highSevFalsePositives.length}, errored: [${erroredRoles.join(",")}] ` +
            `→ ${findingsPath} (rescore offline: npm run evals -- score --fixture ${FIXTURE_NAME} --findings ${findingsPath})`,
        )
      }

      const baseline = foldRuns({
        fixture: FIXTURE_NAME,
        repeats: REPEATS,
        generatedAt: new Date().toISOString(),
        outcomes,
      })
      const report = formatLocalEvalReport({ fixture: FIXTURE_NAME, truth: fixture.truth, outcomes, baseline })
      const reportPath = join(OUT_DIR, `${FIXTURE_NAME}.report.md`)
      const baselinePath = join(OUT_DIR, `${FIXTURE_NAME}.local-baseline.json`)
      writeFileSync(reportPath, report + "\n")
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n")
      console.log(report)
      console.log(`[fixture-eval] report → ${reportPath}`)
      console.log(`[fixture-eval] baseline (commit as baseline.local-minimal.json when establishing) → ${baselinePath}`)

      // A repeat where EVERY role errored produced no measurement at all.
      const totalDeadRepeats = outcomes.filter((o) => o.erroredRoles.length === ROLES.length).length
      expect(totalDeadRepeats).toBeLessThan(REPEATS)
    },
  )
})
