// Subtle-logic recall baseline via a DIRECT Ollama endpoint (the LAN box / any
// /api/chat) — used when the Turbo key isn't available locally. Reuses the REAL
// logic prompt + parser + scorer; only the transport differs from
// logic-recall-eval.live.test.ts (which goes through runShadowSpecialist → Turbo).
// Faithful approximation: same model id (deepseek-v4-flash:cloud), same system +
// user messages, same PR_REVIEW_SCHEMA, same parser. No retry ladder.
//
//   LOGIC_RECALL_OLLAMA_URL=http://<host>:11434/api/chat \
//     npx vitest run tests/logic-recall-lan.live.test.ts
//   (override the model via LOGIC_RECALL_MODEL; defaults to the logic primary)

import { describe, it } from "vitest"
import {
  LOGIC_RECALL_CASES,
  scoreCase,
  aggregate,
  type CaseResult,
  type ScoredFinding,
} from "./logic-recall-corpus"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "../src/prompts/pr-review-specialists"
import { parsePrReviewResponse } from "../src/lib/triage-pr-review"
import { PR_REVIEW_SCHEMA } from "../src/lib/schemas"

// The endpoint being set IS the enable signal (no hard-coded host in the repo).
const URL = process.env.LOGIC_RECALL_OLLAMA_URL
const MODEL = process.env.LOGIC_RECALL_MODEL ?? "deepseek-v4-flash:cloud"
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

async function runCase(c: (typeof LOGIC_RECALL_CASES)[number]): Promise<CaseResult> {
  const systemPrompt = SPECIALIST_PROMPTS.logic
  // Minimal context (diff only) — omits the optional graph/retrieval/guidance
  // blocks prod also passes, so this is a LOWER BOUND on prod recall (CodeRabbit #358).
  const userMessage = buildSpecialistInitialMessage({
    prNumber: 0, title: c.id, body: "", diff: c.diff, retrievalSnapshot: "", namespace: "eval",
  })
  let findings: ScoredFinding[] = []
  let tag = ""
  try {
    const res = await fetch(URL as string, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        stream: false,
        think: false,
        format: PR_REVIEW_SCHEMA,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(180_000),
    })
    const json = (await res.json()) as { message?: { content?: string } }
    const content = json.message?.content ?? ""
    const verdict = parsePrReviewResponse(content)
    findings = (verdict?.findings ?? []).map((f) => ({ path: f.path, line: f.line, score: f.score }))
    tag = `${findings.length}f${verdict ? "" : " · UNPARSEABLE"}`
  } catch (e) {
    tag = `ERROR ${e instanceof Error ? e.message : String(e)}`
  }
  const result = scoreCase(c, findings)
  const mark = c.label === "vuln" ? (result.caught ? "✓ caught" : "✗ MISSED") : result.falsePositive ? "✗ FALSE-POS" : "✓ clean"
  // eslint-disable-next-line no-console
  console.log(`  [${c.label.padEnd(4)}] ${c.id.padEnd(26)} ${mark.padEnd(11)} (${tag})`)
  return result
}

describe.skipIf(!URL)("subtle-logic recall baseline (LIVE via direct Ollama)", () => {
  it(
    "measures recall + FP-rate over the corpus",
    async () => {
      const results: CaseResult[] = []
      for (const c of LOGIC_RECALL_CASES) results.push(await runCase(c))
      const r = aggregate(results)
      const lines: string[] = ["", `┌─ SUBTLE-LOGIC RECALL BASELINE · ${MODEL} ─────────────┐`]
      lines.push(`OVERALL: recall ${pct(r.recall)} (${r.caught}/${r.vulnTotal})  ·  FP-rate ${pct(r.fpRate)} (${r.falsePositives}/${r.safeTotal})`)
      lines.push("by bug class:")
      for (const [cls, b] of Object.entries(r.byClass)) lines.push(`  ${cls.padEnd(18)} ${b.caught}/${b.total}  ${pct(b.total ? b.caught / b.total : 0)}`)
      lines.push("missed (vuln):")
      for (const res of r.results.filter((x) => x.label === "vuln" && !x.caught)) lines.push(`  · ${res.id} (${res.bugClass})${res.nearestLine !== null ? ` — nearest @${res.nearestLine}` : " — none on path"}`)
      lines.push("false positives (safe):")
      for (const res of r.results.filter((x) => x.label === "safe" && x.falsePositive)) lines.push(`  ⚠ ${res.id} (${res.bugClass}) @${res.nearestLine}`)
      lines.push("└──────────────────────────────────────────────────────────┘")
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"))
    },
    LOGIC_RECALL_CASES.length * 180_000 + 60_000,
  )
})
