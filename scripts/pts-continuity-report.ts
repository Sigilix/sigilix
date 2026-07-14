// PTS SIG-578 — deep-work continuity CLI. Standalone runnable report over the continuity
// corpus: drives each scenario through Control-A / Control-B [/ Treatment] on a real model
// and prints a condition x metric scorecard PER SCENARIO and pooled, optionally writing the
// JSON scorecards.
//
// Runs through the SAME harness + model gateway as the live test. Needs a provider key in
// the environment (or gitignored .dev.vars) — the key is chosen by the model's id shape
// (OpenRouter slash id -> OPENROUTER_API_KEY; `:cloud` tag -> OLLAMA_API_KEY). No key ->
// the command prints exactly what to set and exits non-zero.
//
// A single pass is noise; --runs defaults to 5, and per the repo model-eval standard use
// K>=12 for any delta you'll ACT on. Report PER-SCENARIO deltas (a loose scenario must not
// contaminate a well-guarded one); the pooled row is kept alongside, never instead.
//
// Usage:
//   npm run pts-continuity-report                                  # defaults: openai/gpt-oss-120b, 5 runs, all scenarios
//   npm run pts-continuity-report -- --model=deepseek-v4-pro:cloud --runs=12
//   npm run pts-continuity-report -- --scenarios=double-charge-bug-hunt --out=scorecard.json
//   npm run pts-continuity-report -- --treatment=<registered-compactor-id>

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { CONTINUITY_SCENARIOS, aggregateCondition, type RunMetrics } from "@/e2e/pts-continuity-corpus"
import {
  runContinuitySession,
  standardConditions,
  resolveTreatmentCompactor,
  gatewayModelClient,
  continuityApiKey,
} from "@/e2e/pts-continuity-harness"
import { buildScorecard, formatScorecard, type Scorecard } from "@/e2e/pts-continuity-scorecard"

const ALLOWED_ARGS: ReadonlySet<string> = new Set(["model", "runs", "scenarios", "treatment", "out"])

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (!m) die(`unrecognized argument "${a}" (expected --key=value)`)
    const key = m[1]!
    const value = m[2]!
    if (!ALLOWED_ARGS.has(key))
      die(`unknown flag --${key} (allowed: ${[...ALLOWED_ARGS].map((k) => "--" + k).join(", ")})`)
    if (value === "") die(`--${key} requires a non-empty value`)
    out[key] = value
  }
  return out
}

/** Read a key from process.env, falling back to gitignored .dev.vars (like bin/sigilix) so
 *  the CLI is runnable without exporting env by hand. An explicit env var always wins. */
function readKey(name: string): string | undefined {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  if (!existsSync(".dev.vars")) return undefined
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && m[1] === name) return m[2]?.replace(/^["']|["']$/g, "") || undefined
  }
  return undefined
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const model = args.model ?? "openai/gpt-oss-120b"
  const runs = (() => {
    const n = Number(args.runs ?? 5)
    if (!Number.isFinite(n) || n < 1) die("--runs must be a positive integer")
    return Math.floor(n)
  })()
  const scenarioIds =
    args.scenarios
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  const scenarios = scenarioIds.length
    ? CONTINUITY_SCENARIOS.filter((s) => scenarioIds.includes(s.id))
    : CONTINUITY_SCENARIOS
  if (scenarios.length === 0) die(`no scenarios matched (known: ${CONTINUITY_SCENARIOS.map((s) => s.id).join(", ")})`)

  const apiKey = continuityApiKey(model, {
    ollama: readKey("OLLAMA_API_KEY"),
    openrouter: readKey("OPENROUTER_API_KEY"),
  })
  if (!apiKey) {
    die(
      `no API key for model "${model}". Set the provider key for its id shape:\n` +
        `  - OpenRouter model (contains "/"): export OPENROUTER_API_KEY=...  (or put it in .dev.vars)\n` +
        `  - Ollama Turbo model (":cloud"):   export OLLAMA_API_KEY=...       (or put it in .dev.vars)`,
    )
  }

  const client = gatewayModelClient(model, apiKey)
  const treatment = resolveTreatmentCompactor(args.treatment)
  if (args.treatment && !treatment) die(`treatment compactor "${args.treatment}" is not registered`)
  const conditions = standardConditions(treatment)
  if (!treatment) console.error("[pts] treatment condition skipped — no PTS compactor registered (stub seam ready).")

  // Collect runs keyed by scenario so a loose scenario can't contaminate a well-guarded one.
  const perScenario = new Map<string, Map<string, RunMetrics[]>>()
  for (const scenario of scenarios) {
    const byCondition = new Map<string, RunMetrics[]>()
    for (const c of conditions) byCondition.set(c.id, [])
    for (const c of conditions) {
      for (let k = 0; k < runs; k++) {
        const m = await runContinuitySession({ scenario, compactor: c.compactor, model: client })
        byCondition.get(c.id)!.push(m)
        console.error(
          `[pts] ${scenario.id.padEnd(24)} ${c.id.padEnd(12)} run ${k + 1}/${runs}: ` +
            `${m.errored ? `ERROR: ${m.errorMessage ?? "unknown"}` : `retention ${pct(m.retention)} · success ${m.taskSuccess ? "Y" : "N"} · ${m.tokens} tok · ${m.latencyMs}ms`}`,
        )
      }
    }
    perScenario.set(scenario.id, byCondition)
  }

  // Per-scenario scorecards.
  const perScenarioCards: { scenarioId: string; scorecard: Scorecard }[] = []
  for (const scenario of scenarios) {
    const byCondition = perScenario.get(scenario.id)!
    const aggregates = conditions.map((c) => aggregateCondition(c.id, byCondition.get(c.id)!))
    const sc = buildScorecard({
      model,
      scenarioIds: [scenario.id],
      runsPerCondition: runs,
      baselineId: "control-b",
      aggregates,
    })
    perScenarioCards.push({ scenarioId: scenario.id, scorecard: sc })
    console.log(formatScorecard(sc))
  }

  // Pooled scorecard across all scenarios.
  const pooled = conditions.map((c) =>
    aggregateCondition(
      c.id,
      scenarios.flatMap((s) => perScenario.get(s.id)!.get(c.id)!),
    ),
  )
  const pooledCard = buildScorecard({
    model,
    scenarioIds: scenarios.map((s) => s.id),
    runsPerCondition: runs * scenarios.length,
    baselineId: "control-b",
    aggregates: pooled,
  })
  console.log("\n[pts] POOLED across scenarios:")
  console.log(formatScorecard(pooledCard))

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ perScenario: perScenarioCards, pooled: pooledCard }, null, 2))
    console.error(`[pts] scorecards JSON written to ${args.out}`)
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)))
