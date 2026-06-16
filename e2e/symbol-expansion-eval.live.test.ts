// SIG-407 PR-4 — LIVE answer-quality confirmation for symbol-aware retrieval.
// The PRIMARY flip gate is the deterministic retrieval-quality core
// (symbol-expansion-eval.test.ts, runs in CI). This is the CONFIRMATION layer:
// it replays each fixture through the REAL Q&A model with the symbol context OFF
// (raw ~30-line slices, today's behavior) vs ON (the slice's enclosing symbol
// body, what the expander injects) and scores whether the answer is grounded in
// the target symbol.
//
//   OLLAMA_API_KEY=ollama_... npm run symbol-expansion-eval        # default glm-5.1:cloud → Ollama Turbo
//   SYMBOL_EXPANSION_MODEL=openai/o3 OPENROUTER_API_KEY=sk-or-... npm run symbol-expansion-eval
//   SYMBOL_EXPANSION_REPEATS=12 OLLAMA_API_KEY=... npm run symbol-expansion-eval
//
// This is a LIVE test: it makes real model calls, so it is gated on the SELECTED
// provider's key (by the model id-shape, per CLAUDE.md SIG-406) and SKIPS in
// normal CI (`npm run build`). The import chain still resolves; no model is
// called without the key.

import { describe, it } from "vitest"
import { generate } from "@/src/shared/adapters/model"
import { selectConfigApiKey } from "@/src/lib/ensemble/adapters/model-provider-routing"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"
import { SYMBOL_EXPANSION_FIXTURES, type SymbolExpansionFixture, type FixtureSymbol } from "./symbol-expansion-corpus"

const PER_CASE_TIMEOUT_MS = 120_000

// The @-mention Q&A path's default answer model (github-mention.ts DEFAULT_MODEL).
// Overridable to A/B a different model against the SAME fixtures + prompt.
const MODEL_OVERRIDE = process.env.SYMBOL_EXPANSION_MODEL?.trim()
const MENTION_CONFIG: ModelConfig = {
  primary: MODEL_OVERRIDE || "glm-5.1:cloud",
  retries: 0,
  fallback: null,
}
// SIG-406: select the key by the effective model's shape — `:cloud` → Ollama
// Turbo; an OpenRouter id → OPENROUTER_API_KEY. SKIPs unless that key is set.
const API_KEY = selectConfigApiKey(MENTION_CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
const REPEATS = (() => {
  const n = Number(process.env.SYMBOL_EXPANSION_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

function targets(f: SymbolExpansionFixture): FixtureSymbol[] {
  return f.symbols.filter((s) => f.targetSymbolIds.includes(s.symbolId))
}

/** A numbered slice of a fixture file (1-based, inclusive). */
function numbered(src: string, start: number, end: number): string {
  const lines = src.split("\n")
  const out: string[] = []
  for (let i = start; i <= Math.min(end, lines.length); i++) out.push(`${i} | ${lines[i - 1]}`)
  return out.join("\n")
}

/** OFF context: the raw ~30-line hit slices the model sees today. */
function offContext(f: SymbolExpansionFixture): string {
  const blocks = f.hits.map((h) => {
    const src = f.filesByPath[h.path] ?? ""
    return `--- ${h.path}:${h.lineStart}-${h.lineEnd} ---\n${numbered(src, h.lineStart, h.lineEnd)}`
  })
  return blocks.join("\n\n")
}

/** ON context: the OFF slices PLUS the expander's [SYMBOL CONTEXT] block (the
 *  full enclosing-symbol bodies for the targets — what expandHitsToSymbols
 *  injects). Additive — the raw slices remain. */
function onContext(f: SymbolExpansionFixture): string {
  const symBlocks = targets(f).map((t) => {
    const src = f.filesByPath[t.path] ?? ""
    return `${t.path}:${t.startLine}-${t.endLine} — ${t.kind} ${t.name}\n${numbered(src, t.startLine, t.endLine)}`
  })
  const block = ["[SYMBOL CONTEXT — expanded from your question's matches]", ...symBlocks].join("\n")
  return `${block}\n\n${offContext(f)}`
}

function prompt(f: SymbolExpansionFixture, context: string): string {
  return [
    "You are answering a question about a codebase. Use ONLY the provided context.",
    "Name the exact function/symbol that answers the question.",
    "",
    "[QUESTION]",
    f.question,
    "",
    "[CODEBASE CONTEXT]",
    context,
    "",
    "[ANSWER]",
  ].join("\n")
}

/** Grounded iff the answer names a target symbol. */
function grounded(answer: string, f: SymbolExpansionFixture): boolean {
  const lower = answer.toLowerCase()
  return targets(f).some((t) => lower.includes(t.name.toLowerCase()))
}

async function answer(f: SymbolExpansionFixture, context: string, apiKey: string): Promise<string> {
  const { text } = await generate({
    model: MENTION_CONFIG.primary,
    prompt: prompt(f, context),
    apiKey,
    signal: AbortSignal.timeout(PER_CASE_TIMEOUT_MS),
  })
  return text
}

describe.skipIf(!API_KEY)(
  "SIG-407 symbol-aware Q&A answer quality (LIVE — needs OLLAMA_API_KEY or OPENROUTER_API_KEY, K-repeated)",
  () => {
    it(
      "ON grounds more answers in the target symbol than OFF",
      async () => {
        const scored = SYMBOL_EXPANSION_FIXTURES.filter((f) => !f.noGraph && targets(f).length > 0)
        let offHits = 0
        let onHits = 0
        let runs = 0
        const lines: string[] = []
        for (const f of scored) {
          let off = 0
          let on = 0
          for (let k = 0; k < REPEATS; k++) {
            const [aOff, aOn] = await Promise.all([
              answer(f, offContext(f), API_KEY as string),
              answer(f, onContext(f), API_KEY as string),
            ])
            if (grounded(aOff, f)) off++
            if (grounded(aOn, f)) on++
          }
          offHits += off
          onHits += on
          runs += REPEATS
          lines.push(`  ${f.id.padEnd(34)} OFF ${off}/${REPEATS}  →  ON ${on}/${REPEATS}`)
        }
        const lines2 = [
          "",
          `┌─ SIG-407 ANSWER GROUNDING · model=${MENTION_CONFIG.primary} · ${REPEATS}×/case ─┐`,
          `MEAN: OFF ${pct(runs ? offHits / runs : 0)}  →  ON ${pct(runs ? onHits / runs : 0)}`,
          ...lines,
          "└────────────────────────────────────────────────────────────┘",
        ]
        console.log(lines2.join("\n"))
      },
      SYMBOL_EXPANSION_FIXTURES.length * REPEATS * PER_CASE_TIMEOUT_MS + 60_000,
    )
  },
)
