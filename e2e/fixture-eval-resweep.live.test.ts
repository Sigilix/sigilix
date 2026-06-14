// SIG-393 — region re-sweep PROTOTYPE (LIVE: real specialists via Ollama
// Turbo). Measures the lever before any engine code exists:
//
//   pass 1: the four specialists review the full fixture diff (the
//           SIG-398 baseline path).
//   pass 2: for every region (file) where pass 1 produced ≥1 finding,
//           each role re-reviews ONLY that region's diff slice with a
//           guidance block listing what pass 1 already found there and
//           the instruction to enumerate every OTHER issue.
//
// Scored per repeat: pass-1-only vs pass-1 ∪ re-sweep, plus the rows
// ONLY the re-sweep caught. Verdict artifact: rowFlips of the union
// against the committed local-minimal baseline — the lever's win is
// frontier rows (0/8 in baseline) flipping up with high-sev FP noted.
//
//   OLLAMA_API_KEY=… RESWEEP_REPEATS=8 npx vitest run e2e/fixture-eval-resweep.live.test.ts
//
// Same context-gap rule as the baseline: minimal context, union upper
// bound, ungated — compare against baseline.local-minimal.json ONLY.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { scoreFixture } from "@/evals/scorer"
import { rowFlips, unionFixtureFindings, type LocalBaseline } from "@/evals/local-adapter"
import {
  FIXTURES_DIR,
  foldRuns,
  loadFixture,
  splitDiffByFile,
  splitSectionIntoRegions,
  type DiffRegion,
  type RepeatOutcome,
} from "@/e2e/fixture-eval-lib"
import {
  PER_ROLE_TIMEOUT_MS,
  buildFixtureMessage,
  hasAnyEvalApiKey,
  rolesFromEnv,
  runRole,
} from "@/e2e/fixture-eval-runner"

// SIG-406: gate on EITHER provider key; runRole picks the matching key per role shape.
const HAS_KEY = hasAnyEvalApiKey()
const FIXTURE_NAME = process.env.FIXTURE_EVAL_FIXTURE ?? "fullstack-pr20-dense"
const REPEATS = (() => {
  const n = Number(process.env.RESWEEP_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const ROLES = rolesFromEnv(process.env.FIXTURE_EVAL_ROLES)
const OUT_DIR = join(process.cwd(), "e2e", ".fixture-eval-out")
// "file" = last night's variant (whole-file slices); "window" = finer
// regions for big files (~55 added lines, 8 overlap) — the b4/b17/b19/b20
// experiment. Same prompt, only region size changes.
const GRANULARITY = process.env.RESWEEP_GRANULARITY === "file" ? "file" : "window"

function resweepGuidance(region: string, alreadyFound: readonly string[]): string {
  return [
    `RE-SWEEP PASS — a prior review pass already examined this PR and flagged the following issues in \`${region}\`:`,
    ...alreadyFound.map((h) => `- ${h}`),
    "",
    "Your job in THIS pass: re-examine this file's diff and report every OTHER genuine issue in it.",
    "Assume more issues exist than the list above — dense changes hide secondary bugs behind the loudest one.",
    "Do NOT re-report the issues listed above. Do NOT pad with stylistic nits: only genuine defects",
    "(correctness, security, data integrity, contract violations) you can ground in the visible code.",
  ].join("\n")
}

describe.skipIf(!HAS_KEY)(`SIG-393 re-sweep prototype — ${FIXTURE_NAME} (LIVE)`, () => {
  it(
    `pass1 + region re-sweep ×${REPEATS}, scored against the frozen truth`,
    { timeout: (PER_ROLE_TIMEOUT_MS * 2 + 60_000) * REPEATS },
    async () => {
      const fixture = loadFixture(FIXTURE_NAME)
      const diffByFile = splitDiffByFile(fixture.diff)
      const pass1Message = buildFixtureMessage({ title: fixture.prTitle, diff: fixture.diff })
      const baseline = JSON.parse(
        readFileSync(join(FIXTURES_DIR, FIXTURE_NAME, "baseline.local-minimal.json"), "utf8"),
      ) as LocalBaseline
      mkdirSync(OUT_DIR, { recursive: true })

      const pass1Outcomes: RepeatOutcome[] = []
      const unionOutcomes: RepeatOutcome[] = []
      const lines: string[] = []
      for (let repeat = 1; repeat <= REPEATS; repeat++) {
        // ── pass 1: full-diff review, all roles ──
        const p1 = await Promise.all(ROLES.map((role) => runRole({ role, userMessage: pass1Message })))
        const p1Findings = unionFixtureFindings(p1.map((r) => r.findings))
        const p1Errored = ROLES.filter((_, i) => p1[i]!.errored)

        // ── regions: files with ≥1 pass-1 finding (trap/oos hits included —
        // prod's re-sweep would not know which findings the gates will keep),
        // expanded to windows for big files when GRANULARITY="window" ──
        const flaggedPaths = [...new Set(p1Findings.map((f) => f.path).filter((p): p is string => p !== null))].filter(
          (p) => diffByFile.has(p),
        )
        const regions: DiffRegion[] = flaggedPaths.flatMap((path) =>
          GRANULARITY === "window"
            ? splitSectionIntoRegions(path, diffByFile.get(path)!)
            : [{ label: path, path, slice: diffByFile.get(path)!, newLineRange: [1, Number.MAX_SAFE_INTEGER] }],
        )

        // ── pass 2: per region × role, scoped slice + already-found guidance.
        // The "already found" list is filtered to the region's line span (±3
        // for anchor slack); line-less findings count for every window. ──
        const resweepJobs = regions.flatMap((region) => {
          const [lo, hi] = region.newLineRange
          const found = p1Findings
            .filter((f) => f.path === region.path && (f.line === null || (f.line >= lo - 3 && f.line <= hi + 3)))
            .map((f) => f.excerpt)
          const message = buildFixtureMessage({
            title: fixture.prTitle,
            diff: region.slice,
            guidance: resweepGuidance(region.label, found),
          })
          return ROLES.map((role) => ({ role, message, region: region.label }))
        })
        const p2 = await Promise.all(
          resweepJobs.map((j) => runRole({ role: j.role, userMessage: j.message, refRole: `resweep-${j.role}` })),
        )
        const p2Findings = unionFixtureFindings(p2.map((r) => r.findings))

        // ── score both variants; persist BEFORE scoring ──
        const union = [...p1Findings, ...p2Findings]
        writeFileSync(
          join(OUT_DIR, `resweep.${GRANULARITY}.run${repeat}.pass1.json`),
          JSON.stringify(p1Findings, null, 2) + "\n",
        )
        writeFileSync(
          join(OUT_DIR, `resweep.${GRANULARITY}.run${repeat}.union.json`),
          JSON.stringify(union, null, 2) + "\n",
        )
        const p1Score = scoreFixture(fixture.truth, "sigilix", p1Findings)
        const unionScore = scoreFixture(fixture.truth, "sigilix", union)
        pass1Outcomes.push({ repeat, score: p1Score, erroredRoles: p1Errored as string[], elapsedMs: 0 })
        unionOutcomes.push({ repeat, score: unionScore, erroredRoles: p1Errored as string[], elapsedMs: 0 })

        const newRows = unionScore.overall.caughtIds.filter((id) => !p1Score.overall.caughtIds.includes(id))
        const line =
          `repeat ${repeat}/${REPEATS}: pass1 ${p1Score.overall.caught}/20 → union ${unionScore.overall.caught}/20 ` +
          `(+${newRows.length}: ${newRows.join(",") || "none"}) | regions: ${regions.length} | ` +
          `extra calls: ${resweepJobs.length} | hiSevFP ${p1Score.highSevFalsePositives.length}→${unionScore.highSevFalsePositives.length}` +
          (p1Errored.length > 0 ? ` | errored: ${p1Errored.join(",")}` : "")
        lines.push(line)
        console.log(`[resweep] ${line}`)
      }

      // ── verdict: flips of the union vs the committed baseline ──
      const unionFold = foldRuns({
        fixture: FIXTURE_NAME,
        repeats: REPEATS,
        generatedAt: new Date().toISOString(),
        outcomes: unionOutcomes,
      })
      const pass1Fold = foldRuns({
        fixture: FIXTURE_NAME,
        repeats: REPEATS,
        generatedAt: new Date().toISOString(),
        outcomes: pass1Outcomes,
      })
      const flips = rowFlips({ baseline, current: { repeats: REPEATS, perRow: unionFold.perRow } })
      const report = [
        `## SIG-393 re-sweep prototype — ${FIXTURE_NAME} (K=${REPEATS})`,
        "",
        "> minimal context, ungated union — verdict reads vs baseline.local-minimal.json row flips ONLY.",
        "",
        ...lines.map((l) => `- ${l}`),
        "",
        `pass1 perRow:  ${JSON.stringify(pass1Fold.perRow)}`,
        `union perRow:  ${JSON.stringify(unionFold.perRow)}`,
        `baseline perRow: ${JSON.stringify(baseline.perRow)} (K=${baseline.repeats})`,
        "",
        `**flippedUp vs baseline:** ${flips.flippedUp.join(", ") || "(none)"}`,
        `**flippedDown vs baseline:** ${flips.flippedDown.join(", ") || "(none)"}`,
        `hiSevFP totals: pass1 ${pass1Fold.aggregate.highSevFpTotal} → union ${unionFold.aggregate.highSevFpTotal} (across ${REPEATS} repeats)`,
      ].join("\n")
      const reportPath = join(OUT_DIR, `resweep.${GRANULARITY}.report.md`)
      writeFileSync(reportPath, report + "\n")
      console.log(report)
      console.log(`[resweep] report → ${reportPath}`)

      expect(unionOutcomes.length).toBe(REPEATS)
    },
  )
})
