# SIG-161 labeling guide

> The protocol for labeling Sigilix's 200-finding calibration dataset.
> Sibling: `DESIGN.md` (the threshold-gate design this dataset calibrates).

This file is the labeler's operating manual. Anyone labeling — founder, Claude pre-labeling, or a future rater — reads this and follows it exactly. Disagreements between labelers are resolved by re-reading this guide, not by debating the specific finding.

## 1. What you're labeling

Each row in `labels.csv` is one finding emitted by Sigilix's synth specialist. Your job for each row: assign a label of `TP`, `FP`, or `borderline`, plus a one-sentence reason.

This is not a code review. You're not deciding whether to merge the PR. You're deciding whether **Sigilix's claim about this code is correct**.

## 2. Label definitions

### TP — true positive

The finding identifies a real defect. Concretely:
- Correctness: the code does the wrong thing (off-by-one, wrong branch taken, broken invariant, unhandled edge case the diff introduced).
- Security: the code has a real vulnerability — exploitable today or under realistic conditions.
- Performance: the code has a real regression — measurable or analytic (concrete complexity bound, named hot path).
- Missing test: the diff added non-trivial logic (branches, error paths, state transitions) that has no test in this PR.

You'd label TP if, on a real PR:
- You'd fix the issue before merging, OR
- You'd file a follow-up issue to track it, OR
- You'd ask the author to address it before approving.

### FP — false positive

The finding's claim is wrong. Concretely:
- The code behaves correctly under the conditions the finding describes.
- The finding asserts a property the code does not exhibit ("this is O(n²)" on linear code; "this leaks user input" on a sanitized path).
- The finding's claim cannot be verified from the diff + reasonable context — the model invented a problem.
- The finding describes a trivial source file as needing tests ("ships without tests" on a pure constants module).
- The finding nitpicks style or taste while claiming a real defect.

You'd label FP if, on a real PR:
- You'd dismiss the finding as wrong, OR
- You'd reply asking the bot to retract, OR
- The finding describes behavior that's intentional and correct.

### borderline

The finding is neither clearly TP nor clearly FP. Typical shapes:
- "Depends on intent" — the same code might be a bug in one repo and intended in another, and the diff/context doesn't tell you which.
- The finding identifies a real issue but at the wrong line/file (anchoring drift).
- The finding's claim is technically true but operationally meaningless ("this could leak memory in a long-running process" on a request-scoped handler).
- The finding overstates severity (real issue but at score 4 when it should be score 2).

Borderline is a real category, not a dodge. Use it when you genuinely can't decide. Target rate ≤ 10%.

If you find yourself labeling more than 15% borderline, stop and re-read the definitions. The TP/FP split is the calibration signal; too much borderline noise undermines the protocol.

## 3. How to label one finding

Per finding, expect ~30 seconds:

1. **Read the headline + category.** Form a hypothesis: "this sounds like a TP / FP."
2. **Read the body.** Does the body's claim match the headline? Common FP shape: headline says "race condition" but body describes a stylistic concern.
3. **Open the cited line.** Click `path:line` in the row's `pr_url` (the row links to the original finding's GitHub URL). Read the cited line + 10 lines above and below.
4. **Decide.** Apply the label definitions in §2. Trust your first read; if you're not sure after 60 seconds, label `borderline`.
5. **Write the reason.** One sentence. Forms:
   - TP: "Real off-by-one — loop iterates one past the end of `items`."
   - FP: "Code calls `await` correctly — finding misread the async chain."
   - borderline: "Could be a bug if `userId` is null but unclear from the diff whether callers guarantee that."

The reason is for audit later. You're not justifying to anyone right now; you're capturing your reasoning for future-you (or someone re-litigating the threshold months from now).

## 4. Don't do these

- **Don't apply hindsight.** Some findings are on PRs that have since been merged. Don't penalize a finding because the merged code "obviously" works — judge from the diff at review time. If you needed the merged code to decide, the finding is borderline.
- **Don't punish for verbosity.** The body might be verbose, hedging, or use weasel words. Judge the claim, not the prose. A clear TP buried in three paragraphs is still TP.
- **Don't reward for verbosity.** A confident-sounding paragraph asserting an FP claim is still FP. The model is good at writing confidently about things that aren't true.
- **Don't worry about severity in the label.** Severity is `score` (a separate field). A real but low-severity finding is TP. Severity calibration is a different exercise.
- **Don't worry about anchoring.** A correctly-claimed finding anchored to a slightly-off line is still TP (anchoring is SIG-127's domain, not this calibration's).
- **Don't second-guess.** You are the source of truth. The bot's confidence-5 self-report doesn't override your judgment.

## 5. Edge cases

### The finding is technically right but useless

Example: "This function doesn't have a JSDoc comment." Technically a coverage gap; operationally not something you'd fix.

Treat as FP. The bot's job is to surface what you'd actually act on. Useless-but-correct is the worst defect class for trust because it trains the reader to dismiss findings.

(Sigilix's negative constraints already ban docstring findings in the prompt, so these should be rare. If they appear, the prompt is leaking.)

### The finding is right but mis-categorized

Example: a "performance" finding that's really a "logic" finding. The claim is correct; the category is wrong.

Treat as TP. The label is about correctness of the claim, not the metadata. Mis-categorization is a separate signal we can mine later.

### The finding is on a line the diff didn't change

The bot is supposed to anchor to changed lines only. If it anchored to a pre-existing line, it leaked.

If the claim is true about the cited line, that's still TP — the bug exists. If the claim is wrong because of the surrounding pre-existing context, FP.

Note this in the reason: "TP — leaked to pre-existing code but the claim is correct."

### The finding repeats another finding on the same row

The synth specialist deduplicates, but sometimes two findings overlap on the same root cause with different anchors.

Label each independently — they may have different `gateScore` inputs (different specialist sources, different evidence). The calibration is per-finding, not per-issue.

### The finding's body cites evidence that doesn't exist

Example: "see CWE-89" but no CWE-89 applies; "the test in `tests/foo.test.ts` is missing assertion X" but `tests/foo.test.ts` doesn't exist.

FP. Hallucinated evidence is the worst FP class — it's the bot fabricating authority.

### You disagree with Sigilix's negative constraints

Example: the bot fired a `Consider` finding (banned by the prompt's negative constraints), but the underlying concern is legitimate.

Score the finding's correctness on its merits — TP if the claim is right, FP if not. Don't penalize for the rule violation in the label. The rule violation is a separate signal.

## 6. Workflow

### Setup

```bash
cd sigilix
npm run collect-sig-161-findings -- \
  --repo Sigilix/sigilix:60 \
  --repo Rubberfit/rubberfit:30 \
  --out .claude/research/sig-161-labeling/findings-source.jsonl
```

> The corpus committed at `.claude/research/sig-161-labeling/findings-source.jsonl` (76 findings as of 2026-05-25) was produced with this EXACT invocation. Re-running with different `--repo` arguments will yield a different distribution; if expanding the corpus, prefer ADDING new findings rather than regenerating from scratch (per §7).

This pulls findings from the last ~60 dogfood PRs + ValidationMetricsDO rejections + Rubberfit sample. The output is immutable — don't edit it.

### Optional pre-labeling (faster)

If founder time is tight:

```bash
pnpm tsx scripts/prelabel-sig-161.ts --input findings-source.jsonl --output labels-claude.csv
```

This script (Claude-implemented in PR 4 if founder picks the hybrid option) reads each finding + diff + cited lines and emits a `TP`/`FP`/`borderline` label with a one-sentence rationale. Founder reviews, not labels — accept, override, or flip to borderline — which is ~3-4x faster than labeling from scratch.

Claude's pre-labels are persistent in `labels-claude.csv` even after founder review, for audit.

### Labeling

Open `labels.csv` in a spreadsheet. The columns:

| Column | What to fill |
| --- | --- |
| `findingId` | (pre-filled, don't edit) |
| `prUrl` | (pre-filled, click to open the finding) |
| `headline`, `body`, `path`, `line`, `score`, `category` | (pre-filled, don't edit) |
| `label` | `TP` / `FP` / `borderline` — your call |
| `labelReason` | One sentence, see §3 |
| `labelerInitials` | `dm` for founder, `cc` for Claude pre-label, `dm-override` for founder overriding Claude |
| `labelDate` | `YYYY-MM-DD` |

Save as CSV. Commit at the end of each labeling session (don't wait for all 200).

### Quality check

After labeling, before running calibration:

```bash
pnpm tsx scripts/check-sig-161-labels.ts
```

Validates:
- Every finding has a non-empty label.
- Every label is one of `TP`, `FP`, `borderline`.
- Every label has a non-empty `labelReason`.
- Stratification (§7c in DESIGN.md) is roughly met — flags if any cell is under-represented.
- Borderline rate ≤ 15% — flags if higher.

Fix the flags, re-run, then run calibration.

### Calibration

```bash
pnpm tsx scripts/calibrate-sig-161.ts \
  --findings .claude/research/sig-161-labeling/findings-source.jsonl \
  --labels .claude/research/sig-161-labeling/labels.csv \
  --output .claude/research/sig-161-labeling/calibration-report.md
```

Outputs:
- Recommended threshold (or "calibration failed at N=200" with diagnostic).
- FPR + recall at threshold candidates `0.60` through `1.00` in `0.02` steps.
- Wilson 95% CI for FPR at each candidate.
- Per-category breakdown.
- Confusion matrix at the recommended threshold.

The report is committed to the repo (`calibration-report.md`). The recommended threshold lands in KV (`config:gate-threshold:v1`) via `wrangler kv:key put` when founder approves the report; the logistic-regression model artifact lands in KV (`config:gate-model:v1`) the same way. Both reads are cached for 60s in the Worker, so the threshold update takes effect on the next request cycle without a redeploy. See DESIGN.md §9 for the full storage rationale.

## 7. Re-labeling

If the threshold underperforms in shadow mode (FPR in production is materially higher than the calibration estimated):
- Add new findings to the labeled set (don't relabel old ones).
- Recompute threshold.
- This is iterative — the dataset is a living thing, not a one-shot.

If the labeling guide itself changes (some edge case got sharpened):
- Mark the change in this guide's git history.
- Don't relabel retroactively unless the change materially affects the borderline boundary. Stale labels under an old guide are still informative.

## 8. The labeling sets the threshold; you set the labels

Calibration is mechanical. The labels are not. Treat each label as "would I, the customer, want Sigilix to have posted this?" That's the only question. Everything else falls out.
