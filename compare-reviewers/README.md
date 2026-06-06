# compare-reviewers — Sigilix vs CodeRabbit head-to-head (SIG-70)

A small offline CLI for measuring Sigilix against CodeRabbit on real PRs, so the
keep-or-drop-CodeRabbit decision rests on ~30 PRs of labeled data instead of vibes.

It does three things:

1. **collect** — pull both bots' inline findings off a PR and write a labeling worksheet.
2. **label** — read the worksheet you filled in and fold the labels into the PR's JSON.
3. **summary** — aggregate every labeled PR into a markdown decision report.

Nothing here touches the Worker or production — it only reads GitHub through the
`gh` CLI and writes files under `compare-reviewers/data/`.

A finding is a **top-level inline review comment** from each bot — for Sigilix, only
comments carrying its finding marker (overviews and `@`-mention replies are skipped);
for CodeRabbit, every inline comment **except thread replies** (a reply has
`in_reply_to_id` set), so CodeRabbit's follow-up conversation doesn't inflate its count.

## Prerequisites

- `gh` authenticated for the repo you're measuring (`gh auth status`).

## Workflow

```bash
# 1. Collect a PR's findings (writes data/{owner}-{repo}-{pr}.json + .worksheet.md)
npm run compare-reviewers -- collect --repo Sigilix/sigilix --pr 365
#   shorthand: --repo Sigilix/sigilix#365

# 2. Open data/Sigilix-sigilix-365.worksheet.md and fill in the "## Labels" table.
#    One row per real-world issue. If BOTH bots flagged the same issue, put both
#    refs in one row (e.g. `s2,c4`) and use a both_* label.

# 3. Fold your labels back into the JSON (validates first; refuses to write on error)
npm run compare-reviewers -- label --repo Sigilix/sigilix --pr 365

# …repeat collect+label for ~30 PRs…

# 4. Generate the report across everything collected so far
npm run compare-reviewers -- summary --out compare-reviewers/REPORT.md
```

### The six labels

Each real-world issue gets exactly one:

| label | meaning |
|-------|---------|
| `sigilix_only_real_bug` | only Sigilix flagged it; genuine issue |
| `sigilix_only_noise`    | only Sigilix flagged it; false positive / not worth a comment |
| `cr_only_real_bug`      | only CodeRabbit flagged it; genuine issue |
| `cr_only_noise`         | only CodeRabbit flagged it; false positive |
| `both_real`             | both bots flagged the same genuine issue |
| `both_noise`            | both bots flagged the same non-issue |

…and one topic category: `security` · `perf` · `logic` · `tests` · `style`.

The `label` step validates the worksheet before writing: unknown refs, a finding
labeled twice, a `both_*` row missing one bot's ref, or a `*_only_*` row that
lists the other bot — all are reported and block the write, so a half-labeled set
never lands in the JSON.

## What the report answers

`summary` surfaces the numbers the decision hinges on:

- **Per-bot precision** — real bugs ÷ everything the bot flagged.
- **Overlap** — how often both bots caught the same issue.
- **Cost of dropping CodeRabbit** — real bugs *only* CodeRabbit caught (`cr_only_real_bug`).
- **Saving from dropping CodeRabbit** — CodeRabbit-only noise removed (`cr_only_noise`).
- **By category** — where each bot's value and noise concentrate.

## Data layout

`data/{owner}-{repo}-{pr}.json` is the source of truth (findings + labels) and is
committed — it's the audit trail the decision is built on. `*.worksheet.md` is the
human scratch surface; re-running `collect` leaves an existing worksheet untouched
(delete it to regenerate against refreshed findings).

## Operational: move CodeRabbit to advisory (non-blocking)

SIG-70 also calls for taking CodeRabbit off the required-checks list in branch
protection, so its rate-limit hiccups stop blocking merges during the collection
window. **This is a repo-admin change and is left for the repo owner to apply** —
it is not done by this tool. To apply it, drop CodeRabbit's check from the
`required_status_checks` contexts on the protected branch (GitHub UI →
Settings → Branches, or via the API), keeping `lint`, `evidence / scan`, and
`Workers Builds` required. CodeRabbit still runs and comments; it just no longer
gates the merge.
