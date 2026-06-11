# evals — reviewer head-to-head (SIG-70/SIG-326)

A small offline CLI for measuring Sigilix, CodeRabbit, and Greptile on shared
PRs, so reviewer-quality claims rest on labeled data instead of vibes.

It does three things:

1. **collect** — pull each tool's inline findings off a PR and write a labeling worksheet.
2. **label** — read the worksheet you filled in and fold the labels into the PR's JSON.
3. **summary** — aggregate every labeled PR into a markdown decision report.

Nothing here touches the Worker or production — it only reads GitHub through the
`gh` CLI and writes files under `evals/data/`.

A finding is a **top-level inline review comment** from each tool. For Sigilix,
only comments carrying its finding marker count as findings (overviews and
`@`-mention replies are skipped). For CodeRabbit and Greptile, every top-level
inline review comment from the configured app login counts as a finding; thread
replies (`in_reply_to_id` set) are skipped so follow-up conversation does not
inflate finding counts.

## Prerequisites

- `gh` authenticated for the repo you're measuring (`gh auth status`).
- Optional: `COMPARE_REVIEWERS_GREPTILE_LOGINS=login1,login2` when Greptile's
  GitHub App login differs from the built-in aliases.

## Workflow

```bash
# 1. Collect a PR's findings (writes data/{owner}-{repo}-{pr}.json + .worksheet.md)
npm run evals -- collect --repo Sigilix/sigilix --pr 365
#   shorthand: --repo Sigilix/sigilix#365

# 2. Open data/Sigilix-sigilix-365.worksheet.md and fill in the "## Labels" table.
#    One row per real-world issue. If multiple tools flagged the same issue,
#    put all refs in one row (e.g. `s2,c4,g1`). Use `none` for a known real bug
#    every compared tool missed.

# 3. Fold your labels back into the JSON (validates first; refuses to write on error)
npm run evals -- label --repo Sigilix/sigilix --pr 365

# …repeat collect+label for ~30 PRs…

# 4. Generate the report across everything collected so far
npm run evals -- summary --out evals/REPORT.md
```

### Outcome labels

Each real-world issue gets exactly one outcome:

| outcome | meaning |
|---------|---------|
| `real_bug` | a genuine issue worth a review comment |
| `noise` | a false positive / not worth a review comment |

…and one topic category: `security` · `perf` · `logic` · `tests` · `style`.

The `findings` cell controls which tools caught the issue:

- `s*` refs are Sigilix findings.
- `c*` refs are CodeRabbit findings.
- `g*` refs are Greptile findings.
- `none` means a ground-truth `real_bug` that every compared tool missed.

The `label` step validates the worksheet before writing: unknown refs, a finding
labeled twice, a blank findings cell, and `noise` rows with `none` all block the
write, so a half-labeled set never lands in the JSON.

### Equivalence rule

Group refs into one row when they describe the same root issue and would be
fixed by the same code change, even if the tools use different wording, severity,
or nearby line anchors. Split them into separate rows when they point to different
root causes or would require different fixes. This rule is the source of truth
for overlap and unique-catch metrics.

## What the report answers

`summary` surfaces the numbers the decision hinges on:

- **Per-tool precision** — real bugs ÷ everything the tool flagged.
- **Per-tool recall** — real bugs a tool caught ÷ all `real_bug` rows,
  including `none` rows.
- **Overlap** — how often tool pairs or all three caught the same issue.
- **Unique real bugs / only noise** — where each tool adds value or friction.
- **By category** — where each tool's value and noise concentrate.

## Data layout

`data/{owner}-{repo}-{pr}.json` is the source of truth (findings + outcomes) and
is committed — it's the audit trail the decision is built on. `*.worksheet.md`
is the human scratch surface; re-running `collect` leaves an existing worksheet
untouched (delete it to regenerate against refreshed findings).

The current JSON schema is `schemaVersion: 2`. Older v1 files are rejected
instead of silently treating Greptile as absent; migrate them by converting
`label` to `outcome`, `bot` to `tool`, and adding `findings.greptile`.

## Frozen recall fixtures + scorer (SIG-397)

`fixtures/` freezes benchmark PRs as **regression fixtures**: a hand-verified
`ground-truth.json` (bug rows + traps, each with an encoded equivalence rule)
plus per-tool snapshots of the actually-posted findings. The `score` command
maps findings to rows mechanically — no eyeballing — and emits the three
metrics every SIG-392 recall lever must report before enforcement:
**recall** (overall + P0/P1 + per-tier), **precision**, and
**high-severity false positives**.

- `fullstack-pr20-dense` — sigilix-e2e-fullstack#20 (head `pr/11-payments-refunds`,
  20 bugs + 4 traps): the multi-bug saturation regime in a bottle. Baseline:
  Sigilix 8/20, 90.9% precision, 1 soft P0 trap flag; Greptile 9/20, 100%;
  CodeRabbit empty (cooldown).
- `fullstack-low-density` — sigilix-e2e-fullstack#17 (5 labeled rows): the
  control. Confirms recall climbs back toward per-fixture levels when bugs
  don't compete, and guards against overfitting levers to the dense fixture.
  Caveat: its truth is the Jun-6 labeling; Greptile re-reviewed later, so its
  post-label findings score as unmatched there.

```bash
# Score the frozen Sigilix snapshot against the dense fixture
npm run evals -- score --fixture fullstack-pr20-dense

# A/B a recall lever: re-review the fixture PR (clone/reopen), then
npm run evals -- score --fixture fullstack-pr20-dense Sigilix/sigilix-e2e-fullstack#NN \
  --save-findings /tmp/lever-run.json \
  --baseline evals/fixtures/fullstack-pr20-dense/baseline.sigilix.score.json \
  --label sig-393-l1-shadow
# → emits the Δ block (Δrecall, ΔP0/P1, ΔUNGODLY, Δprecision, Δhigh-sev-FP)
#   that the lever's PR description pastes.
```

Equivalence rules are **calibration-pinned**: `scorer.test.ts` asserts the
committed rules reproduce the original hand scoring of both fixtures exactly,
ref by ref. If a rule edit shifts any mapping, the suite fails. Ambiguity is a
hard error — a finding matching two rows means the rules must be tightened
(`notKeywords`, `scope: "excerpt"`), never tie-broken. Denominators (20 rows /
15 P0+P1 / 7 UNGODLY) are always derived from the loaded JSON, never prose.

## Operational: move CodeRabbit to advisory (non-blocking)

SIG-70 also calls for taking CodeRabbit off the required-checks list in branch
protection, so its rate-limit hiccups stop blocking merges during the collection
window. **This is a repo-admin change and is left for the repo owner to apply** —
it is not done by this tool. To apply it, drop CodeRabbit's check from the
`required_status_checks` contexts on the protected branch (GitHub UI →
Settings → Branches, or via the API), keeping `lint`, `evidence / scan`, and
`Workers Builds` required. CodeRabbit still runs and comments; it just no longer
gates the merge.
