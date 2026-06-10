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
  type CaseResult,
  type ScoredFinding,
} from "./logic-recall-corpus"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import { parsePrReviewResponse } from "@/src/lib/triage-pr-review"
import { PR_REVIEW_SCHEMA } from "@/src/shared/domain/schemas"

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
    if (!verdict && process.env.LOGIC_RECALL_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`    RAW[${c.id}] len=${content.length}: ${content.slice(0, 900).replace(/\n/g, " ")}`)
    }
  } catch (e) {
    tag = `ERROR ${e instanceof Error ? e.message : String(e)}`
  }
  const result = scoreCase(c, findings)
  const mark = c.label === "vuln" ? (result.caught ? "✓ caught" : "✗ MISSED") : result.falsePositive ? "✗ FALSE-POS" : "✓ clean"
  // eslint-disable-next-line no-console
  console.log(`  [${c.label.padEnd(4)}] ${c.id.padEnd(26)} ${mark.padEnd(11)} (${tag})`)
  return result
}

// The logic specialist is NON-DETERMINISTIC run-to-run (even at temperature 0), so
// a single pass over N=16 is too noisy to tune against. Repeat each case K times
// (LOGIC_RECALL_REPEATS, default 1) and report the CATCH-RATE per case — a stable
// per-case signal that separates real weak spots from run-to-run variance.
const REPEATS = (() => { const n = Number(process.env.LOGIC_RECALL_REPEATS ?? 1); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1 })()

describe.skipIf(!URL)("subtle-logic recall baseline (LIVE via direct Ollama)", () => {
  it(
    "measures recall + FP-rate over the corpus (K-repeated)",
    async () => {
      const perCase = new Map<string, { hits: number; runs: number }>()
      for (const c of LOGIC_RECALL_CASES) perCase.set(c.id, { hits: 0, runs: 0 })
      for (let k = 0; k < REPEATS; k++) {
        for (const c of LOGIC_RECALL_CASES) {
          const r = await runCase(c)
          const e = perCase.get(c.id) as { hits: number; runs: number }
          e.runs++
          // "hit" = a GOOD outcome: vuln caught, or safe stayed clean.
          if (c.label === "vuln" ? r.caught : !r.falsePositive) e.hits++
        }
      }
      const vuln = LOGIC_RECALL_CASES.filter((c) => c.label === "vuln")
      const safe = LOGIC_RECALL_CASES.filter((c) => c.label === "safe")
      const rate = (id: string): number => { const e = perCase.get(id)!; return e.runs ? e.hits / e.runs : 0 }
      const meanRecall = vuln.reduce((s, c) => s + rate(c.id), 0) / (vuln.length || 1)
      const meanClean = safe.reduce((s, c) => s + rate(c.id), 0) / (safe.length || 1)
      const lines: string[] = ["", `┌─ SUBTLE-LOGIC RECALL · ${MODEL} · ${REPEATS}×/case ─────────────┐`]
      lines.push(`MEAN: recall ${pct(meanRecall)}  ·  clean-on-safe ${pct(meanClean)}  (FP-rate ${pct(1 - meanClean)})`)
      lines.push("per VULN case (caught / runs):")
      for (const c of vuln) { const e = perCase.get(c.id)!; lines.push(`  ${e.hits === e.runs ? "✓" : e.hits === 0 ? "✗" : "~"} ${c.id.padEnd(26)} ${e.hits}/${e.runs}  (${c.bugClass})`) }
      lines.push("per SAFE case (clean / runs):")
      for (const c of safe) { const e = perCase.get(c.id)!; lines.push(`  ${e.hits === e.runs ? "✓" : e.hits === 0 ? "✗" : "~"} ${c.id.padEnd(26)} ${e.hits}/${e.runs}  (${c.bugClass})`) }
      lines.push("└──────────────────────────────────────────────────────────┘")
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"))
    },
    LOGIC_RECALL_CASES.length * REPEATS * 180_000 + 60_000,
  )
})
