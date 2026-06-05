// Subtle-logic recall BASELINE (Lane B #6) — replays each corpus diff through the
// REAL logic specialist (Ollama Turbo) and reports recall + FP-rate.
//
//   OLLAMA_API_KEY=ollama_... npm run logic-recall-eval
//
// This is a LIVE test: it makes real model calls, so it's gated on OLLAMA_API_KEY
// and SKIPS in normal CI (`npm run build`) — the import chain still resolves via
// vitest's `cloudflare:workers` shim, but no model is called without the key. The
// scoring is the pure logic unit-tested in tests/logic-recall-score.test.ts.
// runShadowSpecialist touches NO GitHub / KV / DO (read-only replay primitive).

import { describe, it } from "vitest"
import {
  LOGIC_RECALL_CASES,
  scoreCase,
  aggregate,
  type CaseResult,
  type ScoredFinding,
} from "./logic-recall-corpus"
import { runShadowSpecialist } from "../src/lib/shadow-bakeoff-runner"
import { SPECIALIST_CONFIGS } from "../src/lib/triage-pr-review-ensemble"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "../src/prompts/pr-review-specialists"

const API_KEY = process.env.OLLAMA_API_KEY
const PER_CASE_TIMEOUT_MS = 180_000
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

async function runCase(c: (typeof LOGIC_RECALL_CASES)[number], apiKey: string): Promise<CaseResult> {
  const userMessage = buildSpecialistInitialMessage({
    prNumber: 0, title: c.id, body: "", diff: c.diff, retrievalSnapshot: "", namespace: "eval",
  })
  let findings: ScoredFinding[] = []
  let tag = ""
  try {
    const r = await runShadowSpecialist({
      role: "logic",
      shadowConfig: SPECIALIST_CONFIGS.logic,
      apiKey,
      systemPrompt: SPECIALIST_PROMPTS.logic,
      userMessage,
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_CASE_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "eval", prNumber: 0, headSha: "0".repeat(40) },
    })
    findings = r.findings.map((f) => ({ path: f.path, line: f.line, score: f.score }))
    tag = `${r.findings.length}f · ${r.modelUsed} · ${r.elapsedMs}ms${r.failureReason ? ` · FAIL:${r.failureReason}` : ""}`
  } catch (e) {
    tag = `ERROR ${e instanceof Error ? e.message : String(e)}`
  }
  const result = scoreCase(c, findings)
  const mark = c.label === "vuln" ? (result.caught ? "✓ caught" : "✗ MISSED") : result.falsePositive ? "✗ FALSE-POS" : "✓ clean"
  // eslint-disable-next-line no-console
  console.log(`  [${c.label.padEnd(4)}] ${c.id.padEnd(26)} ${mark.padEnd(11)} (${tag})`)
  return result
}

describe.skipIf(!API_KEY)("subtle-logic recall baseline (LIVE — needs OLLAMA_API_KEY)", () => {
  it(
    "measures the logic specialist's recall + FP-rate over the corpus",
    async () => {
      const results: CaseResult[] = []
      for (const c of LOGIC_RECALL_CASES) {
        results.push(await runCase(c, API_KEY as string)) // sequential — don't hammer the model
      }
      const r = aggregate(results)
      const lines: string[] = ["", "┌─ SUBTLE-LOGIC RECALL BASELINE (logic specialist) ───────────────────────────┐"]
      lines.push(`OVERALL: recall ${pct(r.recall)} (${r.caught}/${r.vulnTotal})  ·  FP-rate ${pct(r.fpRate)} (${r.falsePositives}/${r.safeTotal})`)
      lines.push("by bug class:")
      for (const [cls, b] of Object.entries(r.byClass)) {
        lines.push(`  ${cls.padEnd(18)} ${b.caught}/${b.total}  ${pct(b.total ? b.caught / b.total : 0)}`)
      }
      lines.push("missed (vuln, not caught):")
      for (const res of r.results.filter((x) => x.label === "vuln" && !x.caught)) {
        lines.push(`  · ${res.id} (${res.bugClass})${res.nearestLine !== null ? ` — nearest @${res.nearestLine}` : " — no finding on path"}`)
      }
      lines.push("false positives (safe, wrongly flagged):")
      for (const res of r.results.filter((x) => x.label === "safe" && x.falsePositive)) {
        lines.push(`  ⚠ ${res.id} (${res.bugClass}) @${res.nearestLine}`)
      }
      lines.push("└─────────────────────────────────────────────────────────────────────────────┘")
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"))
    },
    LOGIC_RECALL_CASES.length * PER_CASE_TIMEOUT_MS + 60_000,
  )
})
