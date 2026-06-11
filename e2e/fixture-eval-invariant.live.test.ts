// SIG-395 — cross-cutting invariant lens PROTOTYPE (LIVE: real model via
// Ollama Turbo). Measures the lens before any engine code exists.
//
// The target class, proven by SIG-393's granularity experiment: five dense-
// fixture rows (b4, b8, b16, b19, b20) resist scoped re-sweep at EVERY
// region size — they are not saturation, they are invariant violations a
// per-region lens structurally can't see (error contracts, wire-contract
// drift, data scoping, discriminant totality, signature-over-raw-bytes).
// This lens asks invariant questions over the WHOLE diff instead.
//
//   OLLAMA_API_KEY=… INVARIANT_REPEATS=8 npx vitest run e2e/fixture-eval-invariant.live.test.ts
//
// Per repeat: pass1 (the four specialists, the SIG-398 baseline path) + ONE
// invariant-lens call (logic-role model config — the strongest reasoner —
// with a custom system prompt composed from the prod shared blocks, so the
// output rides the same structured-output schema). Scored three ways:
// pass1, lens-alone, union. Verdict = rowFlips vs the committed baseline.
// Same context rule as ever: minimal context, ungated union upper bound.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { SPECIALIST_CONFIGS } from "@/src/lib/triage-pr-review-ensemble"
import { SHARED_NEGATIVE_CONSTRAINTS, SHARED_OUTPUT_INSTRUCTIONS } from "@/src/prompts/specialists/shared"
import { scoreFixture } from "@/evals/scorer"
import {
  rowFlips,
  shadowFindingsToFixtureFindings,
  unionFixtureFindings,
  type LocalBaseline,
  type LocalRawFinding,
} from "@/evals/local-adapter"
import { FIXTURES_DIR, foldRuns, loadFixture, type RepeatOutcome } from "@/e2e/fixture-eval-lib"
import { PER_ROLE_TIMEOUT_MS, buildFixtureMessage, rolesFromEnv, runRole } from "@/e2e/fixture-eval-runner"

const API_KEY = process.env.OLLAMA_API_KEY
const FIXTURE_NAME = process.env.FIXTURE_EVAL_FIXTURE ?? "fullstack-pr20-dense"
const REPEATS = (() => {
  const n = Number(process.env.INVARIANT_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const ROLES = rolesFromEnv(process.env.FIXTURE_EVAL_ROLES)
const OUT_DIR = join(process.cwd(), "e2e", ".fixture-eval-out")

// v2 (after the K=8 v1 verdict): ONE whole-diff call re-saturates like
// pass-1 — the model gravitates to the loud bugs despite the derive-then-
// sweep instruction. v2 fans out PER INVARIANT FAMILY: each call derives
// and sweeps exactly ONE family (the deterministic-floor lesson — one
// narrow question swept exhaustively beats one broad mandate). Families
// are generic (taxonomy-derived, not fixture-coached). Calls run
// concurrently; output contract identical (prod shared blocks).
const INVARIANT_FAMILIES: ReadonlyArray<{ id: string; charge: string }> = [
  {
    id: "units",
    charge:
      "UNITS & REPRESENTATION: a single canonical unit/representation per quantity (e.g. integer minor units for money, one timestamp format, one ID shape). Find every producer/consumer in the diff that disagrees with the convention the diff itself establishes.",
  },
  {
    id: "data-scoping",
    charge:
      "DATA SCOPING: when any endpoint restricts data access by an ownership key (tenant/customer/user scoping in its query or handler), EVERY sibling endpoint touching the same data class must scope the same way. Enumerate every data-touching endpoint in the diff and check each one against the scoping rule the most-careful sibling establishes.",
  },
  {
    id: "discriminant-totality",
    charge:
      "DISCRIMINANT TOTALITY: for every discriminated union / enum / event-type field declared in the diff, every consumer must handle or explicitly reject each arm. List the arms, list the consumers, and flag any consumer that silently treats all arms the same.",
  },
  {
    id: "error-contracts",
    charge:
      "ERROR CONTRACTS: sibling handlers establish status/shape conventions for not-found / invalid-input / failure paths. Enumerate each handler's failure paths and flag any that return the success shape or status on a failure path the siblings handle properly.",
  },
  {
    id: "crypto-integrity",
    charge:
      "CRYPTO/INTEGRITY DISCIPLINE: signatures/HMACs must be computed over exactly the bytes received (never a re-serialization); secrets must fail closed when unconfigured; comparisons must be constant-time. Check every signature/secret/comparison site in the diff against these.",
  },
  {
    id: "wire-contracts",
    charge:
      "WIRE/TYPE CONTRACTS: declared types/interfaces/casing versus what the code actually returns, casts, or serializes. Flag every raw cast or response that bypasses the declared shape (a cast that silences the type system is a violation site, not a style choice).",
  },
]

function familyPrompt(family: { id: string; charge: string }): string {
  return `${SHARED_NEGATIVE_CONSTRAINTS}

You are a CONSISTENCY AUDITOR with exactly ONE charge in this review. Other reviewers cover everything else; you must NOT report anything outside your charge.

YOUR CHARGE — ${family.charge}

Method: derive the concrete rule(s) of your charge from THIS diff (the diff's own types, contracts, and most-careful sibling code define the convention), then sweep EVERY changed file for violations of those rules — especially sites that look locally fine and are only wrong relative to the rule established elsewhere. Quote both sides in each finding: the rule-establishing site and the violating site. Report ONLY grounded violations of your charge; if the diff establishes no such rule and contains no violation, return zero findings — an empty result is a correct result.

${SHARED_OUTPUT_INSTRUCTIONS}`
}

describe.skipIf(!API_KEY)(`SIG-395 invariant lens prototype — ${FIXTURE_NAME} (LIVE)`, () => {
  it(
    `pass1 + invariant lens ×${REPEATS}, scored against the frozen truth`,
    { timeout: (PER_ROLE_TIMEOUT_MS + 60_000) * REPEATS },
    async () => {
      const fixture = loadFixture(FIXTURE_NAME)
      const userMessage = buildFixtureMessage({ title: fixture.prTitle, diff: fixture.diff })
      const baseline = JSON.parse(
        readFileSync(join(FIXTURES_DIR, FIXTURE_NAME, "baseline.local-minimal.json"), "utf8"),
      ) as LocalBaseline
      mkdirSync(OUT_DIR, { recursive: true })

      const unionOutcomes: RepeatOutcome[] = []
      const lensOnlyOutcomes: RepeatOutcome[] = []
      const lines: string[] = []
      for (let repeat = 1; repeat <= REPEATS; repeat++) {
        // pass1 (4 roles) + the lens call run CONCURRENTLY — the lens needs
        // no pass-1 input (unlike re-sweep), so a prod version adds ~zero
        // wall-clock to the fanout.
        const [p1, lens] = await Promise.all([
          Promise.all(ROLES.map((role) => runRole({ role, userMessage, apiKey: API_KEY! }))),
          Promise.all(
            INVARIANT_FAMILIES.map(async (family) => {
              try {
                const r = await runShadowSpecialist({
                  role: "logic", // strongest reasoning model config
                  shadowConfig: SPECIALIST_CONFIGS.logic,
                  apiKey: API_KEY!,
                  systemPrompt: familyPrompt(family),
                  userMessage,
                  chatEnabled: "on",
                  signal: AbortSignal.timeout(PER_ROLE_TIMEOUT_MS),
                  perfCtx: { owner: "eval", repo: "fixture-eval", prNumber: 0, headSha: "0".repeat(40) },
                })
                const raw = (r.rawFindings ?? []) as readonly LocalRawFinding[]
                const errored = !r.verdictOk || r.failureReason !== undefined
                return {
                  findings: errored ? [] : shadowFindingsToFixtureFindings(`inv-${family.id}`, raw),
                  errored,
                }
              } catch {
                return { findings: [] as ReturnType<typeof shadowFindingsToFixtureFindings>, errored: true }
              }
            }),
          ).then((perFamily) => ({
            findings: unionFixtureFindings(perFamily.map((f) => f.findings)),
            errored: perFamily.every((f) => f.errored),
          })),
        ])
        const p1Findings = unionFixtureFindings(p1.map((r) => r.findings))
        const erroredRoles = [
          ...ROLES.filter((_, i) => p1[i]!.errored),
          ...(lens.errored ? ["invariant"] : []),
        ] as string[]

        const union = [...p1Findings, ...lens.findings]
        writeFileSync(join(OUT_DIR, `invariant.run${repeat}.lens.json`), JSON.stringify(lens.findings, null, 2) + "\n")
        writeFileSync(join(OUT_DIR, `invariant.run${repeat}.union.json`), JSON.stringify(union, null, 2) + "\n")
        const p1Score = scoreFixture(fixture.truth, "sigilix", p1Findings)
        const lensScore = scoreFixture(fixture.truth, "sigilix", lens.findings)
        const unionScore = scoreFixture(fixture.truth, "sigilix", union)
        unionOutcomes.push({ repeat, score: unionScore, erroredRoles, elapsedMs: 0 })
        lensOnlyOutcomes.push({ repeat, score: lensScore, erroredRoles, elapsedMs: 0 })

        const newRows = unionScore.overall.caughtIds.filter((id) => !p1Score.overall.caughtIds.includes(id))
        const line =
          `repeat ${repeat}/${REPEATS}: pass1 ${p1Score.overall.caught}/20 | lens-alone ${lensScore.overall.caught}/20 ` +
          `(${lens.findings.length} findings) | union ${unionScore.overall.caught}/20 (+${newRows.length}: ${newRows.join(",") || "none"}) ` +
          `| hiSevFP ${p1Score.highSevFalsePositives.length}→${unionScore.highSevFalsePositives.length}` +
          (erroredRoles.length > 0 ? ` | errored: ${erroredRoles.join(",")}` : "")
        lines.push(line)
        console.log(`[invariant] ${line}`)
      }

      const unionFold = foldRuns({
        fixture: FIXTURE_NAME,
        repeats: REPEATS,
        generatedAt: new Date().toISOString(),
        outcomes: unionOutcomes,
      })
      const lensFold = foldRuns({
        fixture: FIXTURE_NAME,
        repeats: REPEATS,
        generatedAt: new Date().toISOString(),
        outcomes: lensOnlyOutcomes,
      })
      const flips = rowFlips({ baseline, current: { repeats: REPEATS, perRow: unionFold.perRow } })
      const TARGETS = ["b4", "b8", "b16", "b19", "b20"]
      const report = [
        `## SIG-395 invariant lens prototype — ${FIXTURE_NAME} (K=${REPEATS})`,
        "",
        "> minimal context, ungated union — verdict reads vs baseline.local-minimal.json row flips ONLY.",
        "",
        ...lines.map((l) => `- ${l}`),
        "",
        `lens-alone perRow: ${JSON.stringify(lensFold.perRow)}`,
        `union perRow:      ${JSON.stringify(unionFold.perRow)}`,
        `baseline perRow:   ${JSON.stringify(baseline.perRow)} (K=${baseline.repeats})`,
        "",
        `**target-row scoreboard (the re-sweep-resistant five):** ${TARGETS.map(
          (t) => `${t}:${lensFold.perRow[t] ?? 0}/${REPEATS}`,
        ).join(" · ")}`,
        `**flippedUp vs baseline:** ${flips.flippedUp.join(", ") || "(none)"}`,
        `**flippedDown vs baseline:** ${flips.flippedDown.join(", ") || "(none)"}`,
      ].join("\n")
      const reportPath = join(OUT_DIR, "invariant.report.md")
      writeFileSync(reportPath, report + "\n")
      console.log(report)
      console.log(`[invariant] report → ${reportPath}`)

      expect(unionOutcomes.length).toBe(REPEATS)
    },
  )
})
