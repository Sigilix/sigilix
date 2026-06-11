// SIG-392 — SYNTH-UNDER-LEVER-LOAD replay (LIVE: real synthesizer via
// Ollama Turbo). The gate-survival replay proved the validator gates pass
// the lever recall through clean BUT are not the precision backstop (they
// pass the FPs through too). That leaves the SYNTHESIZER as the actual
// precision backstop for the extra lever candidates — and the open risk
// (the pr/10 / SIG-317 pattern): does synth DROP real findings when fed a
// larger-than-tuned input, and does it SUPPRESS the lever FPs?
//
// This feeds the captured lever-loaded union (pass-1 + merged lever
// candidates) into the REAL synthesizer exactly as the prod pipeline does
// (buildSynthInputVerdicts → renderSpecialistVerdictsForSynth →
// buildSynthesizerInitialMessage → runSynthesizer), then scores the synth
// OUTPUT against the frozen truth. Two questions, both measured per row:
//   RETENTION  — did synth keep the lever-recovered rows (b12,b19,b4,b15)?
//   SUPPRESSION— did synth's dedup/consensus drop the FPs the gates passed?
//
//   OLLAMA_API_KEY=… SYNTH_LOAD_REPEATS=4 SYNTH_LOAD_INPUTS="a.union.json,b.union.json" \
//     npx vitest run e2e/synth-load.live.test.ts
//
// Minimal context (no AST/SARIF/review-memory synth blocks) — matches the
// harness convention; the comparison is input-union vs synth-output on the
// SAME context, so the lever-load effect is isolated.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runSynthesizer } from "@/src/lib/ensemble/adapters/model-provider"
import {
  SYNTHESIZER_PROMPT,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "@/src/prompts/pr-review-specialists"
import { buildSynthInputVerdicts } from "@/src/lib/ensemble/domain/synth"
import { applySynthSourceFindingFloor } from "@/src/lib/degraded-finding-floor"
import { scoreFixture } from "@/evals/scorer"
import { shadowFindingsToFixtureFindings, type LocalRawFinding } from "@/evals/local-adapter"
import type { FixtureFinding, FixtureGroundTruth } from "@/evals/fixture-types"
import { FIXTURES_DIR } from "@/e2e/fixture-eval-lib"
import { rebuildSpecialistVerdicts } from "@/e2e/replay-shared"

const API_KEY = process.env.OLLAMA_API_KEY
const FIXTURE = "fullstack-pr20-dense"
const PER_SYNTH_TIMEOUT_MS = 300_000
const REPEATS = (() => {
  const n = Number(process.env.SYNTH_LOAD_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
// SYNTH_LOAD_MODEL overrides the synth primary (default gpt-oss:120b-cloud)
// — the "is the recall loss a model ceiling?" A/B. Nulls the fallback so
// every run is the requested model (LOGIC_RECALL_MODEL discipline).
const MODEL_OVERRIDE = process.env.SYNTH_LOAD_MODEL?.trim()
// Default to two representative captured unions (one re-sweep, one lens) so
// a default run is cheap; override with a comma list for the full sweep.
const INPUTS = (process.env.SYNTH_LOAD_INPUTS ?? "resweep.window.run1.union.json,invariant.run2.union.json")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const OUT_DIR = join(process.cwd(), "e2e", ".fixture-eval-out")

/** Adapt the synth output verdict's findings into the scorer's shape. */
function synthFindingsToFixture(verdict: { findings: ReadonlyArray<LocalRawFinding> }): FixtureFinding[] {
  return shadowFindingsToFixtureFindings("synth", verdict.findings)
}

describe.skipIf(!API_KEY)(`SIG-392 synth-under-lever-load — ${FIXTURE} (LIVE)`, () => {
  it(
    `replays ${INPUTS.length} lever-loaded union(s) ×${REPEATS} through the real synthesizer`,
    { timeout: (PER_SYNTH_TIMEOUT_MS + 15_000) * INPUTS.length * REPEATS },
    async () => {
      const dir = join(FIXTURES_DIR, FIXTURE)
      const truth = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8")) as FixtureGroundTruth
      const diff = readFileSync(join(dir, "pr.diff"), "utf8")

      const lines: string[] = []
      // Per-row aggregate: how often the row was present in the synth INPUT
      // vs present in the synth OUTPUT, across all runs.
      const inputCaught = new Map<string, number>()
      const outputCaught = new Map<string, number>()
      const flooredCaught = new Map<string, number>()
      let totalRuns = 0
      let attempted = 0
      let aborted = 0
      const fpInputs: number[] = []
      const fpOutputs: number[] = []
      const fpFloored: number[] = []

      for (const inputName of INPUTS) {
        const captured = JSON.parse(readFileSync(join(OUT_DIR, inputName), "utf8")) as FixtureFinding[]
        const { verdicts: specialistVerdicts, leverOrigins } = rebuildSpecialistVerdicts(captured)
        const synthInputVerdicts = buildSynthInputVerdicts(
          specialistVerdicts as Parameters<typeof buildSynthInputVerdicts>[0],
        )
        // SIG-392: stamp lever origins into the synth-visible JSON exactly as
        // prod does in promoted mode (set SYNTH_LOAD_NO_ORIGINS=1 to A/B the
        // pre-marker input shape).
        const verdictBlock = renderSpecialistVerdictsForSynth(
          synthInputVerdicts,
          process.env.SYNTH_LOAD_NO_ORIGINS === "1" ? undefined : leverOrigins,
        )
        const synthMessage = buildSynthesizerInitialMessage({
          prNumber: 0,
          diff,
          specialistVerdictsBlock: verdictBlock,
        })
        const inputScore = scoreFixture(truth, "sigilix", captured)

        for (let repeat = 1; repeat <= REPEATS; repeat++) {
          const r = await runSynthesizer({
            apiKey: API_KEY!,
            systemPrompt: SYNTHESIZER_PROMPT,
            userMessage: synthMessage,
            chatEnabled: "on",
            signal: AbortSignal.timeout(PER_SYNTH_TIMEOUT_MS),
            perfCtx: { owner: "eval", repo: "synth-load", prNumber: 0, headSha: "0".repeat(40) },
            ...(MODEL_OVERRIDE
              ? {
                  configOverride: {
                    primary: MODEL_OVERRIDE,
                    fallback: null,
                    retries: 1,
                    perAttemptTimeoutMs: PER_SYNTH_TIMEOUT_MS,
                  },
                }
              : {}),
          })
          attempted += 1
          if (r.verdict === null) {
            aborted += 1
            lines.push(`${inputName} #${repeat}: SYNTH FAILED (${r.failureReason ?? "?"})`)
            continue
          }
          const outFindings = synthFindingsToFixture(r.verdict as { findings: ReadonlyArray<LocalRawFinding> })
          const outScore = scoreFixture(truth, "sigilix", outFindings)
          // SIG-392: prod applies the SIG-351 source-finding floor AFTER the
          // synth (recall-floors.ts) — score>=4 source rows neither kept in
          // provenance nor proof-dropped are restored before validation. Raw
          // synth retention alone UNDERSTATES the prod pipeline; score both.
          const floored = applySynthSourceFindingFloor({
            findings: r.verdict.findings,
            provenanceFindings: r.provenance?.findings ?? [],
            provenanceDropped: r.provenance?.dropped ?? [],
            specialists: synthInputVerdicts
              .filter((v) => v.verdict !== null)
              .map((v) => ({ role: v.role, findings: v.verdict!.findings })),
          })
          const flooredFindings = synthFindingsToFixture(floored as { findings: ReadonlyArray<LocalRawFinding> })
          const flooredScore = scoreFixture(truth, "sigilix", flooredFindings)
          const leverProofDrops = (r.provenance?.dropped ?? [])
            .filter((d) => leverOrigins.has(d.sourceFindingId))
            .map((d) => `${d.sourceFindingId}(${d.reason.slice(0, 40)})`)
          totalRuns += 1
          fpInputs.push(inputScore.highSevFalsePositives.length)
          fpOutputs.push(outScore.highSevFalsePositives.length)
          fpFloored.push(flooredScore.highSevFalsePositives.length)
          for (const id of inputScore.overall.caughtIds) inputCaught.set(id, (inputCaught.get(id) ?? 0) + 1)
          for (const id of outScore.overall.caughtIds) outputCaught.set(id, (outputCaught.get(id) ?? 0) + 1)
          for (const id of flooredScore.overall.caughtIds) flooredCaught.set(id, (flooredCaught.get(id) ?? 0) + 1)
          const dropped = inputScore.overall.caughtIds.filter((id) => !flooredScore.overall.caughtIds.includes(id))
          const line =
            `${inputName} #${repeat}: input ${inputScore.overall.caught}/20 (FP ${inputScore.highSevFalsePositives.length}) → ` +
            `synth ${outScore.overall.caught}/20 (FP ${outScore.highSevFalsePositives.length}) → ` +
            `floored ${flooredScore.overall.caught}/20 (FP ${flooredScore.highSevFalsePositives.length}, +${floored.restored.length} restored) | ` +
            `findings ${captured.length}→${r.verdict.findings.length}→${floored.findings.length} | ` +
            `post-floor dropped rows: ${dropped.join(",") || "none"} | lever proof-drops: ${leverProofDrops.join("; ") || "none"}`
          lines.push(line)
          console.log(`[synth-load] ${line}`)
        }
      }

      // Per-row retention table: a row at input K/K that drops to <K/K in
      // output is a synth-under-load loss (the SIG-317 pattern).
      const rows = [...new Set([...inputCaught.keys(), ...outputCaught.keys(), ...flooredCaught.keys()])].sort()
      // Abort-inclusive stratum (Kimi rev-2 condition): per-row counts below
      // are conditioned on VALID runs; the attempted/aborted split is reported
      // so retry-until-K-valid protocols can't silently paint rosier retention
      // than operational reality.
      const report = [
        `## SIG-392 synth-under-lever-load — ${FIXTURE} (${totalRuns} valid synth runs over ${INPUTS.length} input(s))`,
        "",
        `attempts: ${attempted} | valid: ${totalRuns} | aborted: ${aborted} (abort-inclusive retention = per-row counts ÷ ${attempted})`,
        "",
        ...lines.map((l) => `- ${l}`),
        "",
        "### per-row retention (input → raw synth → floored, counts; floored = prod truth)",
        ...rows.map((id) => {
          const i = inputCaught.get(id) ?? 0
          const o = outputCaught.get(id) ?? 0
          const fl = flooredCaught.get(id) ?? 0
          return `${id}: input ${i} → synth ${o} → floored ${fl}${fl < i ? "  ⚠️ post-floor drop" : ""}`
        }),
        "",
        `high-sev FP: input mean ${mean(fpInputs).toFixed(1)} → synth mean ${mean(fpOutputs).toFixed(1)} → floored mean ${mean(fpFloored).toFixed(1)}`,
      ].join("\n")
      writeFileSync(join(OUT_DIR, "synth-load.report.md"), report + "\n")
      console.log(report)

      expect(totalRuns).toBeGreaterThan(0)
    },
  )
})

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
