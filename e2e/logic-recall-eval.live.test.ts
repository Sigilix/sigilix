// Subtle-logic recall BASELINE (Lane B #6) — replays each corpus diff through the
// REAL logic specialist (Ollama Turbo) and reports recall + FP-rate.
//
//   OLLAMA_API_KEY=ollama_... npm run logic-recall-eval
//   OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE=enforce OLLAMA_API_KEY=... npm run logic-recall-eval
//
// This is a LIVE test: it makes real model calls, so it's gated on OLLAMA_API_KEY
// and SKIPS in normal CI (`npm run build`) — the import chain still resolves via
// vitest's `cloudflare:workers` shim, but no model is called without the key. The
// scoring is the pure logic unit-tested in tests/logic-recall-score.test.ts.
// runShadowSpecialist touches NO GitHub / KV / DO (read-only replay primitive).

import { describe, it } from "vitest"
import {
  LOGIC_RECALL_CASES,
  buildRightFileByPathFromDiff,
  scoreCase,
  type CaseResult,
  type ScoredFinding,
} from "./logic-recall-corpus"
import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { SPECIALIST_CONFIGS, selectConfigApiKey } from "@/src/lib/triage-pr-review-ensemble"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import {
  evaluateLogicClaimRefutation,
  parseLogicClaimRefutationMode,
} from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

const PER_CASE_TIMEOUT_MS = 180_000
// The logic specialist is non-deterministic run-to-run, so repeat each case K
// times (LOGIC_RECALL_REPEATS, default 1) for a stable per-case catch-rate.
const REPEATS = (() => {
  const n = Number(process.env.LOGIC_RECALL_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
// Optional model swap (LOGIC_RECALL_MODEL) — measure a different logic model
// (e.g. deepseek-v4-pro:cloud) against the SAME corpus + prompt + think:false path.
// Defaults to the prod logic primary; when overriding we null the fallback so every
// scored run is the requested model (a fallback would silently mix a 2nd model in).
const MODEL_OVERRIDE = process.env.LOGIC_RECALL_MODEL?.trim()
const LOGIC_CONFIG = MODEL_OVERRIDE
  ? { ...SPECIALIST_CONFIGS.logic, primary: MODEL_OVERRIDE, fallback: null }
  : SPECIALIST_CONFIGS.logic
// SIG-406: select the key by the EFFECTIVE logic model's shape — a `:cloud` override
// (LOGIC_RECALL_MODEL=deepseek-v4-pro:cloud) → Ollama Turbo (no OpenRouter spend); the
// prod default `openai/o3` (or LOGIC_RECALL_MODEL=openai/o3) → OPENROUTER_API_KEY. The
// suite SKIPS unless the SELECTED provider's key is set.
const API_KEY = selectConfigApiKey(LOGIC_CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
const CLAIM_REFUTATION_MODE = parseLogicClaimRefutationMode(process.env.OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE)
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

function applyClaimRefutationPostFilter(
  c: (typeof LOGIC_RECALL_CASES)[number],
  findings: ReadonlyArray<PrReviewFinding>,
): { findings: PrReviewFinding[]; refuted: number } {
  if (CLAIM_REFUTATION_MODE !== "enforce") return { findings: [...findings], refuted: 0 }
  const fullFileByPath = buildRightFileByPathFromDiff(c.diff)
  const kept = findings.filter(
    (f) => evaluateLogicClaimRefutation({ ...f, category: "logic" }, { fullFileByPath }).keep,
  )
  return { findings: kept, refuted: findings.length - kept.length }
}

async function runCase(
  c: (typeof LOGIC_RECALL_CASES)[number],
  apiKey: string,
): Promise<{ result: CaseResult; errored: boolean }> {
  // Minimal context (diff only) — omits the optional graph/retrieval/guidance
  // blocks prod also passes, so this is a LOWER BOUND on prod recall (CodeRabbit #358).
  // The PR title must NOT name the bug: c.id (e.g. "sign-error-withdraw") would coach
  // the model and corrupt the measurement (Codex review). The diff header already shows
  // the path, so a path-derived title leaks nothing new.
  const userMessage = buildSpecialistInitialMessage({
    prNumber: 0,
    title: `Update ${c.path.split("/").pop() ?? c.path}`,
    body: "",
    diff: c.diff,
    retrievalSnapshot: "",
    namespace: "eval",
  })
  let findings: ScoredFinding[] = []
  let rawFindings: ReadonlyArray<{
    path: string
    line: number
    score: number
    headline?: string
    body?: string
  }> = []
  let errored = false
  let tag = ""
  try {
    const r = await runShadowSpecialist({
      role: "logic",
      shadowConfig: LOGIC_CONFIG,
      apiKey,
      systemPrompt: SPECIALIST_PROMPTS.logic,
      userMessage,
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_CASE_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "eval", prNumber: 0, headSha: "0".repeat(40) },
    })
    rawFindings = r.rawFindings ?? r.findings
    const raw = rawFindings as ReadonlyArray<Partial<PrReviewFinding>>
    const filterInput = (r.findings as PrReviewFinding[]).map((f, i) => ({
      ...f,
      headline: raw[i]?.headline ?? f.headline ?? "",
      body: raw[i]?.body ?? f.body ?? "",
    }))
    const filtered = applyClaimRefutationPostFilter(c, filterInput)
    findings = filtered.findings.map((f) => ({ path: f.path, line: f.line, score: f.score }))
    // A non-throwing failure (parse-fail / timeout / fallthrough leaves verdictOk=false
    // and a failureReason) must NOT count as a verdict: an unparsed vuln looks like a
    // miss, an unparsed safe looks clean. Treat it as errored, same as a throw (Codex +
    // code-reviewer). r.findings is already [] when !verdictOk, so scoring is moot.
    if (!r.verdictOk || r.failureReason) errored = true
    const filterTag = filtered.refuted ? `/${r.findings.length} raw, ${filtered.refuted} claim-refuted` : ""
    tag = `${filtered.findings.length}f${filterTag} · ${r.modelUsed} · ${r.elapsedMs}ms${r.failureReason ? ` · FAIL:${r.failureReason}` : ""}`
  } catch (e) {
    errored = true
    tag = `ERROR ${e instanceof Error ? e.message : String(e)}`
  }
  const result = scoreCase(c, findings)
  const mark = errored
    ? "⚠ ERROR"
    : c.label === "vuln"
      ? result.caught
        ? "✓ caught"
        : "✗ MISSED"
      : result.falsePositive
        ? "✗ FALSE-POS"
        : "✓ clean"
  console.log(`  [${c.label.padEnd(4)}] ${c.id.padEnd(26)} ${mark.padEnd(11)} (${tag})`)
  // LOGIC_RECALL_DEBUG_FP: dump the actual finding TEXT on the failure modes —
  // a safe case that over-fired, or a vuln that was missed-but-still-flagged — so we
  // can tell genuine model confusion (a confident wrong bug report) from a scoring
  // artifact (a score-2 nit miscounted) or a plumbing failure. Diagnosis, not scoring.
  if (
    !errored &&
    process.env.LOGIC_RECALL_DEBUG_FP &&
    ((c.label === "safe" && result.falsePositive) || (c.label === "vuln" && !result.caught && rawFindings.length))
  ) {
    for (const f of rawFindings) {
      console.log(
        `      ↳ ${c.label === "safe" ? "FP" : "OFF-TARGET"} score=${f.score} ${f.path}:${f.line} — ${f.headline ?? ""}${f.body ? ` :: ${String(f.body).slice(0, 200)}` : ""}`,
      )
    }
  }
  return { result, errored }
}

describe.skipIf(!API_KEY)(
  "subtle-logic recall baseline (LIVE — needs OLLAMA_API_KEY or OPENROUTER_API_KEY, K-repeated)",
  () => {
    it(
      "measures the logic specialist's recall + FP-rate over the corpus",
      async () => {
        // `runs` counts only attempts that actually returned a verdict; model/API
        // errors are tracked separately so a timeout never masquerades as a clean
        // safe run (Codex review).
        // LOGIC_RECALL_ONLY: comma-separated case ids to run a fast targeted subset
        // (e.g. triaging a few over-fire cases) instead of the whole corpus.
        const onlyIds =
          process.env.LOGIC_RECALL_ONLY?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? []
        const cases = onlyIds.length ? LOGIC_RECALL_CASES.filter((c) => onlyIds.includes(c.id)) : LOGIC_RECALL_CASES
        const perCase = new Map<string, { hits: number; runs: number; errors: number }>()
        for (const c of cases) perCase.set(c.id, { hits: 0, runs: 0, errors: 0 })
        for (let k = 0; k < REPEATS; k++) {
          for (const c of cases) {
            const { result: r, errored } = await runCase(c, API_KEY as string) // sequential — don't hammer the model
            const e = perCase.get(c.id)!
            if (errored) {
              e.errors++
              continue
            }
            e.runs++
            // "hit" = a GOOD outcome: vuln caught, or safe stayed clean.
            if (c.label === "vuln" ? r.caught : !r.falsePositive) e.hits++
          }
        }
        const vuln = cases.filter((c) => c.label === "vuln")
        const safe = cases.filter((c) => c.label === "safe")
        const rate = (id: string): number => {
          const e = perCase.get(id)!
          return e.runs ? e.hits / e.runs : 0
        }
        // A case whose every repeat errored has runs===0 and rate 0 — averaging that 0 into
        // the mean would understate recall / overstate FP (code-reviewer P1). Exclude
        // all-errored cases from the mean denominator, mirroring the per-attempt exclusion.
        const scored = (cs: typeof vuln): typeof vuln => cs.filter((c) => perCase.get(c.id)!.runs > 0)
        const sv = scored(vuln),
          ss = scored(safe)
        const meanRecall = sv.reduce((s, c) => s + rate(c.id), 0) / (sv.length || 1)
        const meanClean = ss.reduce((s, c) => s + rate(c.id), 0) / (ss.length || 1)
        const totalErrors = [...perCase.values()].reduce((s, e) => s + e.errors, 0)
        const droppedCases = vuln.length - sv.length + (safe.length - ss.length)
        const errSuffix = (id: string): string => {
          const e = perCase.get(id)!
          return e.errors ? `  [${e.errors} err]` : ""
        }
        // ✓ all clean/caught · ✗ all wrong · ~ mixed · ⚠ no verdict ever (only errors).
        const marker = (id: string): string => {
          const e = perCase.get(id)!
          return e.runs === 0 ? "⚠" : e.hits === e.runs ? "✓" : e.hits === 0 ? "✗" : "~"
        }
        const postFilter = CLAIM_REFUTATION_MODE === "enforce" ? " · postfilter=logic-claim-refutation" : ""
        const lines: string[] = [
          "",
          `┌─ SUBTLE-LOGIC RECALL · model=${LOGIC_CONFIG.primary} · ${REPEATS}×/case${postFilter} ─────────────┐`,
        ]
        lines.push(
          `MEAN: recall ${pct(meanRecall)}  ·  clean-on-safe ${pct(meanClean)}  (FP-rate ${pct(1 - meanClean)})${totalErrors ? `  · ${totalErrors} errored attempt(s) excluded` : ""}${droppedCases ? ` · ${droppedCases} case(s) all-errored (excluded from mean)` : ""}`,
        )
        lines.push("per VULN case (caught / runs):")
        for (const c of vuln) {
          const e = perCase.get(c.id)!
          lines.push(`  ${marker(c.id)} ${c.id.padEnd(26)} ${e.hits}/${e.runs}  (${c.bugClass})${errSuffix(c.id)}`)
        }
        lines.push("per SAFE case (clean / runs):")
        for (const c of safe) {
          const e = perCase.get(c.id)!
          lines.push(`  ${marker(c.id)} ${c.id.padEnd(26)} ${e.hits}/${e.runs}  (${c.bugClass})${errSuffix(c.id)}`)
        }
        lines.push("└──────────────────────────────────────────────────────────┘")
        console.log(lines.join("\n"))
      },
      LOGIC_RECALL_CASES.length * REPEATS * PER_CASE_TIMEOUT_MS + 60_000,
    )
  },
)
