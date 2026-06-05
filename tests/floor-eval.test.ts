// Floor eval harness (SIG-114 ruler). Runs each deterministic security floor
// against its independent vuln/safe corpus and reports precision / recall /
// FP-rate, then ASSERTS the SIG-245 bar: ZERO false positives on the safe set.
//
// This is the measurement that lets us decide the shadow→post flip WITHOUT
// external dogfood traffic (our own repo never exercises these sinks). Run:
//   npx vitest run tests/floor-eval.test.ts
// and read the printed table.

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst, type AstNode } from "../src/lib/ast-rules/walker"
import type { AstRule, AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"
import { FLOOR_EVALS } from "./floor-eval-corpus"

const SAMPLE_PATH = "src/routes/handler.ts" // a real request path (NOT a skipped test path)

function fires(rule: AstRule, source: string): boolean {
  // Fail LOUD on a misconfigured rule (no nodeTypes) — otherwise it would never
  // be visited and silently deflate recall as phantom FNs (Sigilix #355).
  if (rule.nodeTypes.length === 0) throw new Error(`rule ${rule.id} declares no nodeTypes`)
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed for sample: ${r.reason}\n${source}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of rule.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = rule.visit(n, { path: SAMPLE_PATH, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out.length > 0
}

interface FloorResult {
  id: string
  cwe: string
  tp: number; fp: number; tn: number; fn: number
  precision: number; recall: number; fpRate: number
  fpSamples: string[]; fnSamples: string[]
}

function evaluate(): FloorResult[] {
  return FLOOR_EVALS.map((f) => {
    let tp = 0, fp = 0, tn = 0, fn = 0
    const fpSamples: string[] = []
    const fnSamples: string[] = []
    for (const s of f.vuln) { if (fires(f.rule, s)) tp++; else { fn++; fnSamples.push(s) } }
    for (const s of f.safe) { if (fires(f.rule, s)) { fp++; fpSamples.push(s) } else tn++ }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
    const fpRate = fp + tn === 0 ? 0 : fp / (fp + tn)
    return { id: f.id, cwe: f.cwe, tp, fp, tn, fn, precision, recall, fpRate, fpSamples, fnSamples }
  })
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

describe("floor eval (SIG-114 ruler) — precision/recall over an independent corpus", () => {
  const results = evaluate()

  it("prints the per-floor report", () => {
    const lines: string[] = []
    lines.push("")
    lines.push("┌─ DETERMINISTIC SECURITY FLOOR EVAL ─────────────────────────────────────────┐")
    lines.push("floor                          CWE                    TP/FN  FP/TN  prec  recall  FP-rate")
    let TP = 0, FP = 0, TN = 0, FN = 0
    for (const r of results) {
      TP += r.tp; FP += r.fp; TN += r.tn; FN += r.fn
      lines.push(
        `${r.id.padEnd(30)} ${r.cwe.padEnd(22)} ${`${r.tp}/${r.fn}`.padEnd(6)} ${`${r.fp}/${r.tn}`.padEnd(6)} ` +
        `${pct(r.precision).padStart(4)}  ${pct(r.recall).padStart(6)}  ${pct(r.fpRate).padStart(6)}`,
      )
      for (const s of r.fpSamples) lines.push(`    ⚠ FALSE POSITIVE: ${s.replace(/\n/g, " ").slice(0, 90)}`)
      for (const s of r.fnSamples) lines.push(`    · missed (FN): ${s.replace(/\n/g, " ").slice(0, 90)}`)
    }
    const recall = TP + FN === 0 ? 1 : TP / (TP + FN)
    const fpRate = FP + TN === 0 ? 0 : FP / (FP + TN)
    const precision = TP + FP === 0 ? 1 : TP / (TP + FP)
    lines.push("─────────────────────────────────────────────────────────────────────────────")
    lines.push(`OVERALL: ${TP} TP · ${FN} FN · ${FP} FP · ${TN} TN  →  precision ${pct(precision)} · recall ${pct(recall)} · FP-rate ${pct(fpRate)}`)
    lines.push("└─────────────────────────────────────────────────────────────────────────────┘")
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"))
    expect(results.length).toBe(7)
  })

  // THE bar (SIG-245): zero false positives on the safe corpus. A floor that
  // fires on idiomatic safe code would post a false REQUEST_CHANGES at `post`.
  it("has ZERO false positives across the entire safe corpus", () => {
    const offenders = results.filter((r) => r.fp > 0)
    const detail = offenders
      .map((r) => `${r.id}: ${r.fp} FP — ${r.fpSamples.map((s) => s.slice(0, 70)).join(" | ")}`)
      .join("\n")
    expect(offenders.length, `floors with false positives:\n${detail}`).toBe(0)
  })

  // Each floor must catch a solid majority of its canonical vulnerable patterns
  // (floors are fail-closed, so some FNs are acceptable, but a floor that misses
  // most real vulns isn't earning its keep).
  it("each floor has recall >= 75% on its vulnerable corpus", () => {
    const weak = results.filter((r) => r.recall < 0.75).map((r) => `${r.id}: recall ${pct(r.recall)}`)
    expect(weak).toEqual([])
  })
})
