# SIG-114 PR 2 — Ground-truth FP-rate / precision eval harness

Status: PR 2 of the SIG-114 epic. Date: 2026-05-29.

## What this is

A precision / false-positive-rate harness over a **hand-labeled corpus** — the
*ceiling* number that PR 1's dismissal-based rate (a floor) cannot give. Where
PR 1 asks "what fraction of posted findings were *dismissed*" (a lower bound),
this asks "what fraction of posted findings were *actually wrong*" against
TP/FP/borderline ground-truth labels.

It builds directly on the existing **SIG-161 labeling corpus** (committed under
`.claude/research/sig-161-labeling/`): `findings-source.jsonl` (76 findings) ×
`labels-claude.csv` (43 TP / 31 FP / 2 borderline). No re-curation — SIG-114 PR 2
turns that corpus into a measured, CI-bounded, reusable regression number, and
connects the SIG-114 (measurement) and SIG-161 (calibration) tracks.

## First ground-truth baseline (the committed corpus, 76 findings)

| Group | TP | FP | Borderline | FP rate | Wilson 95% | Meets <10%? |
|---|--:|--:|--:|--:|---|---|
| **overall** | 43 | 31 | 2 | **41.9%** | [31.3%, 53.3%] | NO |
| security | 3 | 5 | 2 | 62.5% | [30.6%, 86.3%] | insufficient-n |
| tests | 4 | 4 | 0 | 50.0% | [21.5%, 78.5%] | insufficient-n |
| testing | 23 | 17 | 0 | 42.5% | [28.5%, 57.8%] | NO |
| logic | 4 | 2 | 0 | 33.3% | [9.7%, 70.0%] | insufficient-n |
| performance | 8 | 3 | 0 | 27.3% | [9.7%, 56.6%] | insufficient-n |
| error-handling | 1 | 0 | 0 | 0.0% | [0.0%, 79.3%] | insufficient-n |

**Two caveats keep it honest** (in the report + here): the corpus is
**historical** (PRs #98–112, May 20–25 — *before* SIG-281's grounding gate and
the over-fire fixes), and **underpowered** (N=76 vs SIG-161's planned 200, so
only `overall` and `testing` clear min-n=20). SIG-161's target: **FPR ≤ 10%**
(stage-1), **≤ 5%** (stage-2). The value is the regression curve: re-run as the
corpus expands with *recent* findings to see whether the fixes drove 42% down.

## How it works

- `joinFindingsToLabels(findings, labels)` — join by `findingId`; findings
  without a label and labels without a finding are surfaced (never silently
  merged); first label wins on a duplicate.
- `computeEvalReport(join, {minN, target})` — FP rate = `fp/(tp+fp)` (borderline
  excluded from the point estimate), precision = `1 - fpRate`, Wilson 95% CI,
  overall + per-category. `meets-target` is **worst-case**: borderline counted
  as potentially-FP (mirrors PR 1's unlabeled handling), so "meets" only holds
  if it holds even when every borderline is an FP.
- min-n (default 20): below that, the rate is shown but flagged `insufficient-n`.

## Files

- `src/lib/fp-rate/eval.ts` — pure core (join + metrics + CSV/markdown render).
- `scripts/fp-eval.ts` — `npm run fp-eval` (reads the committed corpus; no
  network, fully reproducible).
- `tests/fp-eval.test.ts` — 8 tests.

Reuses PR 1's `wilsonInterval` (`bakeoff-report.ts`).

## Deferred

- **Expand the corpus** with recent (post-SIG-281) findings + re-label → measures
  the *current* engine, not just the May baseline (this is SIG-161 stage-2 work).
- Per-specialist (vs per-category) breakdown via the `sigilixFid` → telemetry
  `sourceSpecialists` join — blocked for the historical corpus (its telemetry has
  aged past the 30-day TTL); becomes possible for fresh findings.
- Wire the eval number into the live surface / trend (SIG-114 PR 4 + close-out).
