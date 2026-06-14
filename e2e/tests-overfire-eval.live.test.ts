// SIG-344 tests-specialist overfire baseline - replays the corpus through the
// REAL tests specialist (Ollama Turbo) and reports separate raw-specialist and
// current post-gate metrics.
//
//   OLLAMA_API_KEY=ollama_... npm run tests-overfire-eval
//   TESTS_OVERFIRE_REPEATS=12 OLLAMA_API_KEY=... npm run tests-overfire-eval
//
// This is a LIVE test: it makes real model calls and is skipped in normal CI
// without OLLAMA_API_KEY. runShadowSpecialist is read-only: no GitHub/KV/DO.

import { describe, it } from "vitest"
import {
  TESTS_OVERFIRE_CASES,
  applyCurrentTestGate,
  scoreCase,
  stablePromptHash,
  type TestsCaseResult,
  type TestsOverfireCase,
  type TestsScoredFinding,
} from "./tests-overfire-corpus"
import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { buildAddedLineTextByLine, buildDeletedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import { SPECIALIST_CONFIGS, SPECIALIST_TIMEOUT_MS, selectConfigApiKey } from "@/src/lib/triage-pr-review-ensemble"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import {
  mergeTestingFocusHints,
  renderTestingEvidenceBlock,
  type InspectedTestFileFetchResult,
} from "@/src/lib/testing-evidence-pack"

// The production tests specialist can spend 110s each on primary, retry, and
// fallback. Give the eval wrapper a small extra guard so benchmark overhead
// does not misclassify a slow-but-valid production-length case as a timeout.
const PER_CASE_TIMEOUT_MS = SPECIALIST_TIMEOUT_MS + 30_000
const REPEATS = (() => {
  const n = Number(process.env.TESTS_OVERFIRE_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const MODEL_OVERRIDE = process.env.TESTS_OVERFIRE_MODEL?.trim()
const TESTS_CONFIG = MODEL_OVERRIDE
  ? { ...SPECIALIST_CONFIGS.tests, primary: MODEL_OVERRIDE, fallback: null }
  : SPECIALIST_CONFIGS.tests
// SIG-406: key by the effective model shape — a `:cloud` override → OLLAMA_API_KEY,
// an OpenRouter id (the prod default) → OPENROUTER_API_KEY. Suite skips unless the
// SELECTED provider's key is set.
const API_KEY = selectConfigApiKey(TESTS_CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
const fmtRate = (numerator: number, denominator: number): string =>
  denominator > 0 ? pct(numerator / denominator) : "n/a"

function rawFindingsFrom(result: Awaited<ReturnType<typeof runShadowSpecialist>>): TestsScoredFinding[] {
  return (result.rawFindings ?? result.findings).map((f) => {
    const scored: TestsScoredFinding = {
      path: f.path,
      line: f.line,
      score: f.score,
    }
    if ("category" in f && typeof f.category === "string") scored.category = f.category
    if ("headline" in f && typeof f.headline === "string") scored.headline = f.headline
    if ("body" in f && typeof f.body === "string") scored.body = f.body
    if ("testGap" in f && typeof f.testGap === "string") scored.testGap = f.testGap
    if ("inspectedTestFiles" in f && Array.isArray(f.inspectedTestFiles)) {
      scored.inspectedTestFiles = f.inspectedTestFiles.filter((p): p is string => typeof p === "string")
    }
    if ("evidenceRefs" in f && Array.isArray(f.evidenceRefs)) {
      scored.evidenceRefs = f.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
    }
    if ("failureExample" in f && typeof f.failureExample === "string") scored.failureExample = f.failureExample
    return scored
  })
}

function testingEvidenceBlockForCase(c: TestsOverfireCase): string {
  if (c.testingEvidenceBlock.length === 0) return ""

  const contentByPath = { ...(c.inspectedTestContentByPath ?? {}) }
  const fetchResult: InspectedTestFileFetchResult = {
    contentByPath,
    failedPaths: [],
    budgetOmittedPaths: [],
    truncatedPaths: [],
    totalChars: Object.values(contentByPath).reduce((sum, body) => sum + body.length, 0),
  }
  const pack = mergeTestingFocusHints(
    c.testingEvidence,
    buildAddedLineTextByLine(c.diff),
    buildDeletedLineTextByLine(c.diff),
  )
  return renderTestingEvidenceBlock(pack, fetchResult) || c.testingEvidenceBlock
}

async function runCase(
  c: TestsOverfireCase,
  apiKey: string,
): Promise<{
  raw: TestsCaseResult
  postGate: TestsCaseResult
  errored: boolean
}> {
  const userMessage = buildSpecialistInitialMessage({
    prNumber: 0,
    title: `Update ${c.path.split("/").pop() ?? c.path}`,
    body: "",
    diff: c.diff,
    retrievalSnapshot: "",
    namespace: "eval",
    ...(c.testingEvidenceBlock.length > 0 ? { testingEvidenceBlock: testingEvidenceBlockForCase(c) } : {}),
  })
  let rawFindings: TestsScoredFinding[] = []
  let errored = false
  let tag = ""
  let shadowResult: Awaited<ReturnType<typeof runShadowSpecialist>> | undefined
  try {
    const r = await runShadowSpecialist({
      role: "tests",
      shadowConfig: TESTS_CONFIG,
      apiKey,
      systemPrompt: SPECIALIST_PROMPTS.tests,
      userMessage,
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_CASE_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "eval", prNumber: 0, headSha: "0".repeat(40) },
    })
    shadowResult = r
    rawFindings = rawFindingsFrom(r)
    if (!r.verdictOk || r.failureReason) errored = true
    tag = `${rawFindings.length}f - ${r.modelUsed} - ${r.elapsedMs}ms${r.failureReason ? ` - FAIL:${r.failureReason}` : ""}`
  } catch (e) {
    errored = true
    tag = `ERROR ${e instanceof Error ? e.message : String(e)}`
  }
  const postGateFindings = applyCurrentTestGate(c, rawFindings)
  const raw = scoreCase(c, rawFindings)
  const postGate = scoreCase(c, postGateFindings)
  const rawMark =
    c.label === "vuln" ? (raw.caught ? "raw caught" : "raw MISSED") : raw.falsePositive ? "raw FP" : "raw clean"
  const gateMark =
    c.label === "vuln"
      ? postGate.caught
        ? "gate caught"
        : "gate MISSED"
      : postGate.falsePositive
        ? "gate FP"
        : "gate clean"
  console.log(`  [${c.label.padEnd(4)}] ${c.id.padEnd(36)} ${rawMark.padEnd(10)} / ${gateMark.padEnd(11)} (${tag})`)
  if (errored && process.env.TESTS_OVERFIRE_DEBUG && shadowResult?.failureRawAnswer) {
    console.log(`      raw-error: ${shadowResult.failureRawAnswer.slice(0, 1200).replace(/\s+/g, " ")}`)
  }
  if (
    !errored &&
    process.env.TESTS_OVERFIRE_DEBUG &&
    (raw.falsePositive || (c.label === "vuln" && (!raw.caught || !postGate.caught)))
  ) {
    for (const f of rawFindings) {
      console.log(
        `      -> score=${f.score} ${f.category ?? "?"} ${f.path}:${f.line} - ${f.headline ?? ""}${f.body ? ` :: ${String(f.body).slice(0, 200)}` : ""}`,
      )
    }
  }
  return { raw, postGate, errored }
}

describe.skipIf(!API_KEY)(
  "tests overfire baseline (LIVE - needs OLLAMA_API_KEY or OPENROUTER_API_KEY, K-repeated)",
  () => {
    it(
      "measures tests-specialist P0/P1 recall + raw/post-gate FP-rate and precision",
      async () => {
        const onlyIds =
          process.env.TESTS_OVERFIRE_ONLY?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? []
        const cases = onlyIds.length ? TESTS_OVERFIRE_CASES.filter((c) => onlyIds.includes(c.id)) : TESTS_OVERFIRE_CASES
        const perCase = new Map<
          string,
          {
            rawHits: number
            gateHits: number
            rawPositive: number
            gatePositive: number
            runs: number
            errors: number
          }
        >()
        for (const c of cases)
          perCase.set(c.id, {
            rawHits: 0,
            gateHits: 0,
            rawPositive: 0,
            gatePositive: 0,
            runs: 0,
            errors: 0,
          })
        for (let k = 0; k < REPEATS; k++) {
          for (const c of cases) {
            const { raw, postGate, errored } = await runCase(c, API_KEY as string)
            const e = perCase.get(c.id)!
            if (errored) {
              e.errors++
              continue
            }
            e.runs++
            if (c.label === "vuln") {
              if (raw.caught) {
                e.rawHits++
                e.rawPositive++
              }
              if (postGate.caught) {
                e.gateHits++
                e.gatePositive++
              }
            } else {
              if (!raw.falsePositive) e.rawHits++
              else e.rawPositive++
              if (!postGate.falsePositive) e.gateHits++
              else e.gatePositive++
            }
          }
        }
        const vuln = cases.filter((c) => c.label === "vuln")
        const safe = cases.filter((c) => c.label === "safe")
        const scored = (cs: typeof vuln): typeof vuln => cs.filter((c) => perCase.get(c.id)!.runs > 0)
        const sv = scored(vuln),
          ss = scored(safe)
        const rate = (id: string, k: "rawHits" | "gateHits"): number => {
          const e = perCase.get(id)!
          return e.runs ? e[k] / e.runs : 0
        }
        const mean = (cs: typeof vuln, k: "rawHits" | "gateHits"): number =>
          cs.reduce((s, c) => s + rate(c.id, k), 0) / (cs.length || 1)
        const rawRecall = mean(sv, "rawHits")
        const gateRecall = mean(sv, "gateHits")
        const rawClean = mean(ss, "rawHits")
        const gateClean = mean(ss, "gateHits")
        const rawTp = sv.reduce((s, c) => s + perCase.get(c.id)!.rawPositive, 0)
        const gateTp = sv.reduce((s, c) => s + perCase.get(c.id)!.gatePositive, 0)
        const rawFp = ss.reduce((s, c) => s + perCase.get(c.id)!.rawPositive, 0)
        const gateFp = ss.reduce((s, c) => s + perCase.get(c.id)!.gatePositive, 0)
        const totalErrors = [...perCase.values()].reduce((s, e) => s + e.errors, 0)
        const droppedCases = vuln.length - sv.length + (safe.length - ss.length)
        const marker = (id: string, k: "rawHits" | "gateHits"): string => {
          const e = perCase.get(id)!
          return e.runs === 0 ? "!" : e[k] === e.runs ? "Y" : e[k] === 0 ? "N" : "~"
        }
        const suffix = (id: string): string => {
          const e = perCase.get(id)!
          return e.errors ? `  [${e.errors} err]` : ""
        }
        const lines: string[] = [
          "",
          `TESTS OVERFIRE - model=${TESTS_CONFIG.primary} - prompt=${stablePromptHash(SPECIALIST_PROMPTS.tests)} - ${REPEATS}x/case`,
        ]
        lines.push("")
        lines.push("SPECIALIST RAW OUTPUT (human-labeled oracle):")
        lines.push(
          `  recall ${pct(rawRecall)}  clean-on-safe ${pct(rawClean)}  FP-rate ${pct(1 - rawClean)}  precision ${fmtRate(rawTp, rawTp + rawFp)}`,
        )
        lines.push("POST-GATE CURRENT SURFACE (after evaluateTestFinding):")
        lines.push(
          `  recall ${pct(gateRecall)}  clean-on-safe ${pct(gateClean)}  FP-rate ${pct(1 - gateClean)}  precision ${fmtRate(gateTp, gateTp + gateFp)}${totalErrors ? `  ${totalErrors} errored attempt(s) excluded` : ""}${droppedCases ? `  ${droppedCases} case(s) all-errored` : ""}`,
        )
        lines.push("")
        lines.push("per VULN case (caught / runs):")
        for (const c of vuln) {
          const e = perCase.get(c.id)!
          lines.push(
            `  ${marker(c.id, "rawHits")}/${marker(c.id, "gateHits")} ${c.id.padEnd(36)} raw ${e.rawHits}/${e.runs} - gate ${e.gateHits}/${e.runs}  (${c.bugClass})${suffix(c.id)}`,
          )
        }
        lines.push("per SAFE case (clean / runs):")
        for (const c of safe) {
          const e = perCase.get(c.id)!
          lines.push(
            `  ${marker(c.id, "rawHits")}/${marker(c.id, "gateHits")} ${c.id.padEnd(36)} raw ${e.rawHits}/${e.runs} - gate ${e.gateHits}/${e.runs}  (${c.bugClass})${suffix(c.id)}`,
          )
        }
        console.log(lines.join("\n"))
      },
      TESTS_OVERFIRE_CASES.length * REPEATS * PER_CASE_TIMEOUT_MS + 60_000,
    )
  },
)
