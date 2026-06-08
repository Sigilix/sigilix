// SIG-350 synthesizer-retention baseline - replays frozen specialist verdict
// bundles through the REAL synthesizer (Ollama Turbo) and reports retention,
// FP filtering, hallucination, severity drift, duplicate collapse, precision,
// and runtime.
//
//   OLLAMA_API_KEY=ollama_... npm run synth-retention-eval
//   SYNTH_RETENTION_REPEATS=12 OLLAMA_API_KEY=... npm run synth-retention-eval
//
// This is a LIVE test: it makes real model calls and is skipped in normal CI
// without OLLAMA_API_KEY. runSynthesizer is read-only: no GitHub/KV/DO writes.

import { describe, it } from "vitest"
import {
  formatSynthRetentionSummary,
  scoreSynthRetentionCase,
  summarizeSynthRetentionResults,
  SYNTH_RETENTION_CASES,
  type SynthRetentionCase,
  type SynthRetentionOutput,
} from "./synth-retention-corpus"
import {
  runSynthesizer,
  SYNTHESIZER_CONFIG,
  SYNTHESIZER_TIMEOUT_MS,
} from "../src/lib/triage-pr-review-ensemble"
import {
  SYNTHESIZER_PROMPT,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "../src/prompts/pr-review-specialists"
import type { PrReviewVerdict } from "../src/lib/triage-pr-review"
import type { EnsembleRunCtx } from "../src/lib/ensemble-perf-telemetry"

const API_KEY = process.env.OLLAMA_API_KEY
const PER_CASE_TIMEOUT_MS = SYNTHESIZER_TIMEOUT_MS + 30_000
const REPEATS = (() => {
  const n = Number(process.env.SYNTH_RETENTION_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const MODEL_OVERRIDE = process.env.SYNTH_RETENTION_MODEL?.trim()
const SYNTH_CONFIG = MODEL_OVERRIDE
  ? { ...SYNTHESIZER_CONFIG, primary: MODEL_OVERRIDE, fallback: null }
  : SYNTHESIZER_CONFIG

const EMPTY_VERDICT: PrReviewVerdict = {
  summary: "Synth failed.",
  confidence: 1,
  confidenceReason: "No parseable synth output.",
  findings: [],
}

const PERF_CTX: EnsembleRunCtx = {
  owner: "eval",
  repo: "eval",
  prNumber: 0,
  headSha: "0".repeat(40),
}

function userMessageForCase(c: SynthRetentionCase): string {
  return buildSynthesizerInitialMessage({
    prNumber: 0,
    diff: c.diff,
    specialistVerdictsBlock: renderSpecialistVerdictsForSynth(
      c.specialistVerdicts.map((v) => ({ role: v.role, verdict: v.verdict })),
    ),
  })
}

async function runCase(c: SynthRetentionCase, apiKey: string): Promise<SynthRetentionOutput> {
  try {
    const result = await runSynthesizer({
      apiKey,
      systemPrompt: SYNTHESIZER_PROMPT,
      userMessage: userMessageForCase(c),
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_CASE_TIMEOUT_MS),
      perfCtx: PERF_CTX,
      configOverride: SYNTH_CONFIG,
    })
    if (result.verdict && result.provenance) {
      return {
        verdict: result.verdict,
        provenance: result.provenance,
        elapsedMs: result.elapsedMs,
        modelUsed: result.modelUsed,
      }
    }
    return {
      verdict: EMPTY_VERDICT,
      provenance: { findings: [], dropped: [] },
      elapsedMs: result.elapsedMs,
      modelUsed: result.modelUsed,
      failureReason: result.failureReason ?? "synth_failed",
    }
  } catch (e) {
    return {
      verdict: EMPTY_VERDICT,
      provenance: { findings: [], dropped: [] },
      elapsedMs: PER_CASE_TIMEOUT_MS,
      modelUsed: SYNTH_CONFIG.primary,
      failureReason: e instanceof Error ? e.message : String(e),
    }
  }
}

describe.skipIf(!API_KEY)("synth retention baseline (LIVE - needs OLLAMA_API_KEY, K-repeated)", () => {
  it(
    "measures synthesizer TP retention, FP filtering, hallucinations, duplicate collapse, and runtime",
    async () => {
      const onlyIds = (process.env.SYNTH_RETENTION_ONLY?.split(",").map((s) => s.trim()).filter(Boolean)) ?? []
      const cases = onlyIds.length
        ? SYNTH_RETENTION_CASES.filter((c) => onlyIds.includes(c.id))
        : SYNTH_RETENTION_CASES
      const scores = []
      for (let k = 0; k < REPEATS; k++) {
        for (const c of cases) {
          const output = await runCase(c, API_KEY as string)
          const score = scoreSynthRetentionCase(c, output)
          scores.push(score)
          const mark = [
            `recall ${score.retained}/${score.totalMustKeep}`,
            `fp-kept ${score.falsePositivesKept}/${score.totalMustDrop}`,
            `hallucinated ${score.unsupportedFindings}`,
            `drift ${score.severityDriftSourceIds.length}`,
            `collapse ${score.duplicateCollapses}`,
          ].join(" - ")
          console.log(`  [synth] ${c.id.padEnd(30)} ${mark} (${score.modelUsed} - ${score.elapsedMs}ms${score.failureReason ? ` - FAIL:${score.failureReason}` : ""})`)
          if (process.env.SYNTH_RETENTION_DEBUG && (score.recall < 1 || score.falsePositivesKept > 0 || score.unsupportedFindings > 0)) {
            console.log(`      missed=${score.missedSourceIds.join(",") || "-"} drift=${score.severityDriftSourceIds.join(",") || "-"} misdiagnosed=${score.misdiagnosedSourceIds.join(",") || "-"}`)
          }
        }
      }
      const summary = summarizeSynthRetentionResults(scores)
      console.log("")
      console.log(`SYNTH RETENTION - model=${SYNTH_CONFIG.primary} - ${REPEATS}x/case`)
      console.log(formatSynthRetentionSummary(summary))
    },
    SYNTH_RETENTION_CASES.length * REPEATS * PER_CASE_TIMEOUT_MS + 60_000,
  )
})
