// SIG-311 security-overfire baseline — replays the corpus through the REAL
// security specialist (Ollama Turbo) and reports raw P0/P1 FP rate plus the
// post-usage-gate inline P0/P1 FP rate.
//
//   OLLAMA_API_KEY=ollama_... npm run security-overfire-eval
//   SECURITY_OVERFIRE_REPEATS=12 OLLAMA_API_KEY=... npm run security-overfire-eval
//
// This is a LIVE test: it makes real model calls and is skipped in normal CI
// without OLLAMA_API_KEY. runShadowSpecialist is read-only: no GitHub/KV/DO.

import { describe, it } from "vitest"
import {
  SECURITY_OVERFIRE_CASES,
  applySecurityUsageGate,
  scoreCase,
  type SecurityCaseResult,
  type SecurityOverfireCase,
  type SecurityScoredFinding,
} from "./security-overfire-corpus"
import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { SPECIALIST_CONFIGS } from "@/src/lib/triage-pr-review-ensemble"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"

const API_KEY = process.env.OLLAMA_API_KEY
const PER_CASE_TIMEOUT_MS = 180_000
const REPEATS = (() => {
  const n = Number(process.env.SECURITY_OVERFIRE_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const MODEL_OVERRIDE = process.env.SECURITY_OVERFIRE_MODEL?.trim()
const SECURITY_CONFIG = MODEL_OVERRIDE
  ? { ...SPECIALIST_CONFIGS.security, primary: MODEL_OVERRIDE, fallback: null }
  : SPECIALIST_CONFIGS.security
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

function rawFindingsFrom(result: Awaited<ReturnType<typeof runShadowSpecialist>>): SecurityScoredFinding[] {
  return (result.rawFindings ?? result.findings).map((f) => {
    const scored: SecurityScoredFinding = {
      path: f.path,
      line: f.line,
      score: f.score,
    }
    if ("category" in f && typeof f.category === "string") scored.category = f.category
    if ("headline" in f && typeof f.headline === "string") scored.headline = f.headline
    if ("body" in f && typeof f.body === "string") scored.body = f.body
    if ("cweId" in f && typeof f.cweId === "string") scored.cweId = f.cweId
    if ("evidenceId" in f && typeof f.evidenceId === "string") scored.evidenceId = f.evidenceId
    if ("independentAssessment" in f && typeof f.independentAssessment === "string") {
      scored.independentAssessment = f.independentAssessment
    }
    return scored
  })
}

async function runCase(
  c: SecurityOverfireCase,
  apiKey: string,
): Promise<{
  raw: SecurityCaseResult
  postGate: SecurityCaseResult
  errored: boolean
}> {
  const userMessage = buildSpecialistInitialMessage({
    prNumber: 0,
    title: `Update ${c.path.split("/").pop() ?? c.path}`,
    body: "",
    diff: c.diff,
    retrievalSnapshot: "",
    namespace: "eval",
    ...(c.securityFactsBlock ? { deterministicChecksBlock: c.securityFactsBlock } : {}),
  })
  let rawFindings: SecurityScoredFinding[] = []
  let errored = false
  let tag = ""
  try {
    const r = await runShadowSpecialist({
      role: "security",
      shadowConfig: SECURITY_CONFIG,
      apiKey,
      systemPrompt: SPECIALIST_PROMPTS.security,
      userMessage,
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_CASE_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "eval", prNumber: 0, headSha: "0".repeat(40) },
    })
    rawFindings = rawFindingsFrom(r)
    if (!r.verdictOk || r.failureReason) errored = true
    tag = `${rawFindings.length}f · ${r.modelUsed} · ${r.elapsedMs}ms${r.failureReason ? ` · FAIL:${r.failureReason}` : ""}`
  } catch (e) {
    errored = true
    tag = `ERROR ${e instanceof Error ? e.message : String(e)}`
  }
  const postGateFindings = applySecurityUsageGate(c, rawFindings)
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
  console.log(`  [${c.label.padEnd(4)}] ${c.id.padEnd(30)} ${rawMark.padEnd(10)} / ${gateMark.padEnd(11)} (${tag})`)
  if (!errored && process.env.SECURITY_OVERFIRE_DEBUG && (raw.falsePositive || (c.label === "vuln" && !raw.caught))) {
    for (const f of rawFindings) {
      console.log(
        `      ↳ score=${f.score} ${f.category ?? "?"} ${f.path}:${f.line} ${f.cweId ?? ""} — ${f.headline ?? ""}${f.body ? ` :: ${String(f.body).slice(0, 200)}` : ""}`,
      )
    }
  }
  return { raw, postGate, errored }
}

describe.skipIf(!API_KEY)(
  "security usage-vs-mention overfire baseline (LIVE — needs OLLAMA_API_KEY, K-repeated)",
  () => {
    it(
      "measures security-specialist P0/P1 recall + raw/post-gate inline FP-rate",
      async () => {
        const onlyIds =
          process.env.SECURITY_OVERFIRE_ONLY?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? []
        const cases = onlyIds.length
          ? SECURITY_OVERFIRE_CASES.filter((c) => onlyIds.includes(c.id))
          : SECURITY_OVERFIRE_CASES
        const perCase = new Map<string, { rawHits: number; gateHits: number; runs: number; errors: number }>()
        for (const c of cases) perCase.set(c.id, { rawHits: 0, gateHits: 0, runs: 0, errors: 0 })
        for (let k = 0; k < REPEATS; k++) {
          for (const c of cases) {
            const { raw, postGate, errored } = await runCase(c, API_KEY as string)
            const e = perCase.get(c.id)!
            if (errored) {
              e.errors++
              continue
            }
            e.runs++
            if (c.label === "vuln" ? raw.caught : !raw.falsePositive) e.rawHits++
            if (c.label === "vuln" ? postGate.caught : !postGate.falsePositive) e.gateHits++
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
        const totalErrors = [...perCase.values()].reduce((s, e) => s + e.errors, 0)
        const droppedCases = vuln.length - sv.length + (safe.length - ss.length)
        const marker = (id: string, k: "rawHits" | "gateHits"): string => {
          const e = perCase.get(id)!
          return e.runs === 0 ? "!" : e[k] === e.runs ? "✓" : e[k] === 0 ? "✗" : "~"
        }
        const suffix = (id: string): string => {
          const e = perCase.get(id)!
          return e.errors ? `  [${e.errors} err]` : ""
        }
        const lines: string[] = [
          "",
          `┌─ SECURITY OVERFIRE · model=${SECURITY_CONFIG.primary} · ${REPEATS}×/case ─────────────┐`,
        ]
        lines.push(
          `RAW:       recall ${pct(rawRecall)}  · clean-on-safe ${pct(rawClean)}  (FP-rate ${pct(1 - rawClean)})`,
        )
        lines.push(
          `POST-GATE: recall ${pct(gateRecall)}  · inline-clean ${pct(gateClean)}  (inline-FP-rate ${pct(1 - gateClean)})${totalErrors ? `  · ${totalErrors} errored attempt(s) excluded` : ""}${droppedCases ? ` · ${droppedCases} case(s) all-errored` : ""}`,
        )
        lines.push("per VULN case (caught / runs):")
        for (const c of vuln) {
          const e = perCase.get(c.id)!
          lines.push(
            `  ${marker(c.id, "rawHits")}/${marker(c.id, "gateHits")} ${c.id.padEnd(30)} raw ${e.rawHits}/${e.runs} · gate ${e.gateHits}/${e.runs}  (${c.bugClass})${suffix(c.id)}`,
          )
        }
        lines.push("per SAFE case (clean / runs):")
        for (const c of safe) {
          const e = perCase.get(c.id)!
          lines.push(
            `  ${marker(c.id, "rawHits")}/${marker(c.id, "gateHits")} ${c.id.padEnd(30)} raw ${e.rawHits}/${e.runs} · gate ${e.gateHits}/${e.runs}  (${c.bugClass})${suffix(c.id)}`,
          )
        }
        lines.push("└──────────────────────────────────────────────────────────┘")
        console.log(lines.join("\n"))
      },
      SECURITY_OVERFIRE_CASES.length * REPEATS * PER_CASE_TIMEOUT_MS + 60_000,
    )
  },
)
