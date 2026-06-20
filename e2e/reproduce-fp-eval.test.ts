// SIG-477 — the REPRODUCED false-positive + recall EVAL.
//
// There is no organic PR traffic to "soak" over (sole engineer, pre-beta), so we
// MANUFACTURE the data: a curated, adversarially-verified corpus of pure-function
// fixtures (e2e/reproduce-fp-corpus.json) is run through the REAL pipeline —
// source-reconstruction → the QuickJS execution harness — and we measure how the
// `reproduced` verdict behaves per ground-truth class:
//
//   - `bug`     — a real off-by-one/boundary bug + the correct fix → SHOULD reproduce.
//                 reproduced-rate = RECALL of the wedge (informational).
//   - `noop`    — CORRECT code + a behavior-PRESERVING change (equivalent rewrite /
//                 rename / cosmetic). Reproducing one is a HARNESS OVER-FIRE → the
//                 load-bearing FP-safety invariant: this rate MUST be 0 (hard-asserted).
//   - `modelfp` — CORRECT code + a behavior-CHANGING wrong "fix" (a model FP on correct
//                 code). The harness proves buggy≠fix, NOT buggy-is-wrong, so these CAN
//                 reproduce; the rate quantifies how load-bearing the GROUNDING
//                 precondition is (in prod the eligibility grounding gate filters
//                 ungrounded guesses BEFORE the harness — this eval runs the harness in
//                 isolation, so it is the WORST CASE). Informational, not asserted.
//
// This is deterministic (no model, fixed fixtures + fixed battery) and runs the real
// sandbox, so it doubles as a permanent FP-safety regression guard. Full report via
// `npm run reproduce-fp-eval`.

import { describe, it, expect } from "vitest"
import corpus from "./reproduce-fp-corpus.json"
import { reconstructPureLogicPair } from "@/src/lib/ensemble/app/reconstruct-pure-logic"
import { runPureLogicHarness } from "@/src/lib/reproduce/harness-purelogic"

interface Fixture {
  name: string
  source: string
  anchorLineText: string
  suggestedReplacement: string
  truth: "bug" | "noop" | "modelfp"
  bucket: string
}

interface FixtureOutcome {
  name: string
  bucket: string
  status: "reproduced" | "inconclusive" | "skipped"
  detail: string
}

/** 1-based line number of the (unique) anchor line in source, or null when it is absent
 *  or ambiguous (exact match first, then a trimmed match). */
function lineOf(source: string, anchorLineText: string): number | null {
  const lines = source.split(/\r?\n/)
  const exact = lines.flatMap((l, i) => (l === anchorLineText ? [i + 1] : []))
  if (exact.length === 1) return exact[0] ?? null
  const t = anchorLineText.trim()
  const trimmed = lines.flatMap((l, i) => (l.trim() === t ? [i + 1] : []))
  return trimmed.length === 1 ? (trimmed[0] ?? null) : null
}

/** Run ONE fixture through reconstruction → the harness, returning the verdict. */
async function outcomeFor(f: Fixture): Promise<FixtureOutcome> {
  const base = { name: f.name, bucket: f.bucket }
  const line = lineOf(f.source, f.anchorLineText)
  if (line === null) return { ...base, status: "skipped", detail: "anchor-not-unique" }
  const pair = reconstructPureLogicPair(f.source, {
    path: "fixture.ts",
    line,
    startLine: line,
    suggestedReplacement: f.suggestedReplacement,
  })
  if (pair === null) return { ...base, status: "skipped", detail: "no-reconstruct" }
  const res = await runPureLogicHarness({ failureExample: pair.buggy, suggestedReplacement: pair.fixed })
  return { ...base, status: res.status, detail: res.detail }
}

describe("REPRODUCED false-positive + recall eval (SIG-477)", () => {
  it("reproduces real bugs, never over-fires on behavior-preserving changes", async () => {
    const fixtures = (corpus as { fixtures: Fixture[] }).fixtures
    expect(fixtures.length, "corpus should not be empty").toBeGreaterThan(0)

    const byTruth: Record<string, FixtureOutcome[]> = { bug: [], noop: [], modelfp: [] }
    for (const f of fixtures) {
      const outcome = await outcomeFor(f)
      ;(byTruth[f.truth] ??= []).push(outcome)
    }

    const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`)
    for (const truth of ["bug", "noop", "modelfp"] as const) {
      const rows = byTruth[truth] ?? []
      if (rows.length === 0) continue
      const repro = rows.filter((r) => r.status === "reproduced").length
      const inconcl = rows.filter((r) => r.status === "inconclusive").length
      const skipped = rows.filter((r) => r.status === "skipped").length
      const label =
        truth === "bug" ? "recall" : truth === "noop" ? "OVER-FIRE (must be 0)" : "worst-case (grounding-gated in prod)"
      console.log(
        `[fp-eval] ${truth.padEnd(8)} reproduced ${repro}/${rows.length} (${pct(repro, rows.length)}) ${label} · inconclusive ${inconcl} · skipped ${skipped}`,
      )
    }

    // Diagnostic: which real bugs did NOT reproduce (recall misses), if any.
    const bugMisses = (byTruth.bug ?? []).filter((r) => r.status !== "reproduced")
    if (bugMisses.length > 0) {
      console.log(
        `[fp-eval] bug misses: ${bugMisses.map((r) => `${r.name}(${r.bucket}:${r.status}/${r.detail})`).join(", ")}`,
      )
    }

    // FP-SAFETY (hard gate): a behavior-PRESERVING change must NEVER reproduce.
    const overfires = (byTruth.noop ?? []).filter((r) => r.status === "reproduced")
    expect(overfires, `noop (behavior-preserving) fixtures must not reproduce: ${JSON.stringify(overfires)}`).toEqual(
      [],
    )
  }, 120_000)
})
