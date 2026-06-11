# SIG-397 — Recall regression harness: frozen dense-PR fixture + scorer — implementation spec

**Status:** spec / pre-implementation. Parent: SIG-369 (adaptive review budget), lane: SIG-392 (deep recall).
**Branch:** `sig-397-recall-harness`. **Touches:** `evals/` only (no engine behavior change).

## Goal

A re-runnable scorer that, given a PR's posted review findings, emits **recall / precision / high-severity-FP** against a frozen, hand-verified ground truth — so every SIG-392 lever (L1 re-sweep, L2 invariant lens, L3 per-unit fanout, L4 critic) must prove its delta before enforcement. No more eyeballed scoring.

## Source of truth

- **Fixture PR:** GitHub `Sigilix/sigilix-e2e-fullstack#20` (head branch `pr/11-payments-refunds`, commit `2a3bc30`, CLOSED). The PR *number* is 20; the branch name is historical — do not conflate.
- **Ground truth:** `docs/superpowers/specs/2026-06-09-benchmark-fullstack-pr20-groundtruth.md` (RECONCILED: post DeepSeek-v4-pro adversarial label audit + blind code-reviewer hunt). **19 real-bug rows (b1–b19) + 4 traps (t1–t4)** + 2 "also genuinely-safe" idioms, **PLUS b20 added by this spec:** webhook HMAC computed over `JSON.stringify(req.body)` (re-serialized, not raw bytes) — verified real in the diff (payments.ts webhook, `const raw = JSON.stringify(req.body)`), caught uniquely by Greptile in the hand scoring. With b20 the fixture reproduces the recorded benchmark exactly (Sigilix 8/20, Greptile 9/20) and matches the tickets' "20 bugs." b20: tier MEDIUM, category security, severity P1.
- **Known inconsistency resolved in code, not prose:** the doc's prose denominators (÷18/÷13/÷6) are stale vs its own table. **The scorer derives ALL denominators from the committed `ground-truth.json` (with b20: 20 rows, 15 P0/P1, 7 UNGODLY) — never from markdown prose.** Hybrid tier labels are canonicalized in the schema: `EASY-MED`→`MEDIUM` (b2), `UNGODLY-MED`→`UNGODLY` (b13, consistent with the doc's own UNGODLY set).

## Deliverables

### 1. `evals/fixtures/` — frozen fixture data (committed)

```
evals/fixtures/
  fullstack-pr20-dense/
    ground-truth.json      # bugs + traps + matchers (schema below)
    findings.sigilix.json  # snapshot of Sigilix's actual posted findings (FixtureFinding[])
    findings.greptile.json # ditto (for cross-tool baseline context)
    findings.coderabbit.json  # empty array — CodeRabbit posted nothing (cooldown); the frozen empty baseline
    pr.diff                # unified diff of the PR at 2a3bc30 (offline reproducibility)
  fullstack-low-density/   # control fixture (see §4)
    ground-truth.json
    findings.*.json
```

`FixtureFinding` extends `NormalizedFinding` with what matching and severity need (per sign-off finding 2 — the capped 280-char excerpt is not enough): `bodyText: string` (full comment body, HTML comments stripped) and `severity: "P0"|"P1"|"P2"|"P3"|null` parsed from the Sigilix severity marker in the body (null for tools without parseable severity).

`ground-truth.json` schema (new `evals/fixture-types.ts`):

```ts
interface FixtureGroundTruth {
  schemaVersion: 1;
  fixture: string;                  // "fullstack-pr20-dense"
  owner: string; repo: string; pr: number; headSha: string;
  bugs: GroundTruthBug[];
  traps: GroundTruthTrap[];
}
interface GroundTruthBug {
  id: string;                       // "b1".."b20"
  title: string;                    // one-line description from the reconciled doc
  paths: string[];                  // file(s) whose change contains the bug
  lineRanges: Array<[number, number]>; // head-sha line spans (derived from the diff during impl)
  tier: "EASY" | "MEDIUM" | "UNGODLY" | "LOW";
  category: "security" | "perf" | "logic" | "tests" | "style";
  severity: "P0" | "P1" | "P2" | "P3";
  match: EquivalenceRule;           // §2
}
interface GroundTruthTrap {
  id: string; title: string; paths: string[];
  lineRanges: Array<[number, number]>;
  match: EquivalenceRule;
  whySafe: string;
}
```

### 2. Equivalence rules — encoded, deterministic (`evals/scorer.ts`)

Rule semantics follow the existing manual convention (README: "group refs into one row when the same fix addresses it"), made mechanical:

```ts
interface EquivalenceRule {
  anyOf: MatcherClause[];           // row matches if ANY clause matches
}
interface MatcherClause {
  // clause matches when: finding.path ∈ row.paths
  //   AND every allKeywords entry hits bodyText (case-insensitive substring/regex)
  //   AND no notKeywords entry hits
  //   AND (if lineRanges given on the clause) finding.line within range ± lineSlack
  allKeywords: string[];            // POSITIVE discriminator — required, never empty (sign-off finding 1)
  notKeywords?: string[];
  lineRanges?: Array<[number, number]>;
  lineSlack?: number;               // default 5
}
```

- A finding **matches a bug row** when any of the row's clauses matches. **Line proximity alone is never sufficient** — every clause requires a positive keyword discriminator, because the charge handler stacks b2/b4/b9/b13/b17 in overlapping lines.
- **Ambiguity is an error, not a tie-break:** if a finding matches >1 row, the scorer throws (and the calibration test fails). Rules must be tightened with `notKeywords` until every frozen finding maps to exactly ≤1 row. Declared bug order is documentation, not a resolution mechanism.
- A finding maps to ≤1 row (same-fix grouping); multiple findings may map to the same row.
- A finding **matches a trap** by the same mechanism — only counts against precision when the finding's parsed severity is a *bug claim* (not an explicit "this is safe" note).
- **Unmatched** findings = hallucination candidates → count against precision; listed in output for human audit (the rules are falsifiable, not silently lossy).
- **Calibration requirement (the key correctness gate):** the encoded rules, run against the three frozen `findings.*.json` snapshots, must reproduce the hand-scored Jun-9 result EXACTLY (sign-off finding 3) — asserted as data, not ranges:
  - **Sigilix:** caught rows = {b1(s1), b2(s5,s7), b3(s2,s13), b6(s9), b7(s8), b9(s4), b11(s10), b13(s14)} = 8/20; trap-flagged = {t1(s3)}; testing-coverage findings (s6,s11,s12,s15) scored per the out-of-table rule below; exact precision numerator/denominator asserted in the test.
  - **Greptile:** caught rows = {b1(g1), b2(g2), b4(g8), b6(g5), b7(g3), b9(g7), b11(g9), b13(g4), b20(g6)} = 9/20; 0 trap flags; 0 high-sev FP.
  - **CodeRabbit:** empty findings, 0/20, no precision (flagged=0 → null).
  - **Out-of-table valid findings:** "ships without tests" coverage findings are true observations that are not bug rows. The ground truth carries an explicit `outOfScope` matcher list (testing-coverage class); findings matching it are excluded from BOTH precision numerator and denominator, and reported separately — neither credited as recall nor punished as hallucination. The exact hand-scored precision (89–92% band) is pinned to one number during implementation once this rule is applied, and that number goes in the test.

### 3. Scorer + CLI

- `evals/scorer.ts` — pure: `score(groundTruth, findings: NormalizedFinding[]): FixtureScore`.
- `FixtureScore`: recall overall (`rowsCaught/20`), recall by severity subset (P0/P1: ÷15), by tier (UNGODLY ÷7), precision, **high-sev-FP count** (trap or unmatched finding asserted at P0/P1 — the believability bar is 0), matched/unmatched/outOfScope detail lists. All denominators computed from the loaded ground-truth JSON.
- Severity of a posted finding: parse from the Sigilix comment body (severity pill/marker) in `normalize.ts` (extend `NormalizedFinding` with optional `severity`); fall back to `null` (excluded from high-sev-FP, included in precision).
- CLI: extend `evals/cli.ts` with `score --fixture fullstack-pr20-dense [--tool sigilix] [--pr OWNER/REPO#N | --findings path.json]`. Default scores the frozen snapshot; `--pr` re-collects live (re-runnable on any new posted review, e.g. after L1 ships and the fixture PR is re-reviewed on a re-opened clone PR).
- **Lever delta contract (sign-off finding 5):** `score` accepts `--baseline <score.json>` and `--label <lever-id>` (e.g. `sig-393-l1-shadow`), writes its full `FixtureScore` as JSON next to the markdown, and when `--baseline` is given emits a delta block: Δrecall overall, ΔP0/P1 recall, ΔUNGODLY recall, Δprecision, Δhigh-sev-FP, and (with `--all`) Δlow-density control. The committed frozen snapshot's score is the canonical baseline file (`evals/fixtures/fullstack-pr20-dense/baseline.sigilix.score.json`). This is the artifact each SIG-392 lever pastes into its PR.
- Output: markdown table to stdout + optional `--out`; shape consistent with `summary.ts` reporting.

### 4. Low-density control

Purpose (from the epic): confirm recall climbs back toward K=12 when bugs don't compete, and ensure deep-lane changes don't overfit the dense fixture. Implementation: promote **`Sigilix-sigilix-e2e-fullstack-17`** (already labeled in `evals/data/`, 5 real rows — low-density 4–5 bug regime, same repo/stack as the dense fixture) to `evals/fixtures/fullstack-low-density/` with the same ground-truth schema + matchers built from its labeled worksheet. The scorer treats it identically; `score --all` reports both and the dense-minus-control delta.

### 5. Tests (vitest, pure — no network)

- Matcher unit tests: per-bug positive (the actual posted finding text that humans matched) + negative (sibling-region finding must NOT cross-match) cases.
- The calibration assertion of §2 (frozen snapshots → exact Jun-9 hand-scored numbers).
- Denominator derivation (20/15/7) from the loaded ground-truth JSON — guards against the prose-vs-table drift recurring.
- Ambiguity guard: a synthetic finding crafted to match two rows must make the scorer throw.
- CLI arg parsing + io path tests, following `evals.test.ts` patterns.

## Non-goals

- No engine/Worker code changes; no new model calls. The harness consumes *posted* reviews.
- Not a general multi-fixture benchmark platform — exactly two fixtures (dense + control). pr/07–pr/11 history stays in `evals/data/` as-is.
- No auto-rescoring in CI against live GitHub (offline determinism; live re-collect is a manual CLI action).

## Risks / notes

- Posted-comment availability: PR #20 is closed, comments persist; snapshots make us immune to deletion.
- ~~HMAC-over-reserialized-body unrepresented~~ RESOLVED: added as b20 (verified real in the diff; reconciles the 8/20 & 9/20 hand scores and the tickets' "20 bugs").
- `evals/` is plain Node tooling (not the Worker); tsconfig/test wiring follows the existing evals.test.ts setup; CI gate is `npm run build` as usual.

## Done when (mirrors Linear AC)

- Fixture + ground truth committed to `evals/fixtures/`.
- `score` emits recall/precision/high-sev-FP + subset recalls, on both fixtures, offline.
- Calibration test reproduces the Jun-9 hand scoring exactly.
- README section documents the lever A/B workflow (run lever in shadow → re-review fixture PR clone → `score --pr` → compare).
