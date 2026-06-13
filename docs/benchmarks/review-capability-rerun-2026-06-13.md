# Review-capability benchmark — rerun on new main (new models)

_Measured 2026-06-13. **Rerun of the 13-PR difficulty-tiered batch** (same e2e PRs, same
planted-bug diffs, unchanged answer key) after the SIG-318/389/392/395 refactor + model
swap (synth → `gemma4:31b`, lens-first split + invariant lens on, deterministic
near-duplicate / coverage-stamp collapse). Fresh Sigilix reviews were forced with
`/sigilix full review` (forceFresh) under the deployed new models; CodeRabbit + Greptile are
unchanged and serve as the consistency anchor. Scored with the new `evals/` harness
(collect → label → summary). The prior old-main run (PR #494, closed as built on stale main)
is the baseline._

## Headline — new models vs old run

| Tool | Precision | Recall | FP noise/PR | Flagged | Unique real |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Sigilix (new)** | **48.4%** | **83.3%** | 1.23 | 31 | 3 |
| Sigilix (old) | 41.4% | 63.2% | 1.31 | 29 | 4 |
| CodeRabbit (new / old) | 70.0% / 70.0% | 77.8% / 73.7% | 0.46 | 20 | 1 |
| Greptile (new / old) | 52.6% / 52.6% | 55.6% / 52.6% | 0.69 | 19 | 0 |

**Sigilix recall jumped +20pp (63% → 83%) — now the highest of the three, ahead of
CodeRabbit (78%).** Precision improved +7pp (41% → 48%) but still trails CodeRabbit (70%).
CodeRabbit/Greptile barely moved (same diffs, unchanged tools) — a clean sanity check that
the deltas are real, not labeling drift. 0 bugs missed by all three.

## What got better

- **Dedup-collapse works.** The old run's duplicate-finding problem is largely fixed: #27
  IDOR went from **3 near-identical findings → 1**; #21 authz from **5 (with dupes + FPs) → 1
  clean finding**.
- **Caught two it missed before.** #28 **TOCTOU race** (previously missed — fired an authz
  FP instead) and #20 **cache-key collision (T4)** (previously caught only by CodeRabbit) are
  now both caught.
- **F1 XSS surfaced inline.** Previously summary-only; now named in an inline finding
  (still tagged `testing`, but it's there).
- **Higher recall on secondary real issues** — the new models also surface more genuine
  minor findings (non-indexable `ILIKE`, incomplete pagination cursor, div-by-zero on
  `daysTotal=0`, stale-render flash), which lifts measured recall.
- **Tests over-fire reduced.** Gone on #21/#19; on #22 the glue-trap no longer draws a
  "needs tests" over-fire (the SIG-347 target) — though it drew a different speculative
  finding instead. Clean control (#24) still silent — hallucination floor held.

## What regressed or persists

- **B5 token-bucket drift (T4) is now MISSED.** The new models flagged the unbounded-Map +
  an `anon`-fallback non-issue instead of the refill-remainder drift — a **recall regression**
  (it was caught last run; CodeRabbit + Greptile still catch it).
- **B1 SQLi inline gap WORSENED.** The SQLi is still only in the review summary, and this run
  no inline finding even names it (last run it was at least bundled into a tests finding).
  The P0 still isn't an inline security comment.
- **New hallucination.** #18 `UserDetail` drew a "Stored XSS" finding on `{user.name}` /
  `{user.bio}` — but React auto-escapes JSX text (no `dangerouslySetInnerHTML`). A clean
  false positive.
- **More verbose.** #26/#28/#29 now carry 6–7 findings each — lots of "unhandled rejection",
  "no input validation", and speculative notes. This is the bulk of the remaining 16 noise
  findings and the reason precision is still well behind CodeRabbit.

## Planted-bug recall (the 11 designed bugs)

Flat at **9/11** both runs, but the composition shifted — the new models climbed the
difficulty curve while dropping two:

| | Old models | New models |
| --- | --- | --- |
| Caught | B1*, B2, B4, B5, F1*, F2, F3, FS1, FS3 | B2, **B3**, B4, F1, F2, F3, **F4**, FS1, FS3 |
| Missed | B3, F4 | **B5**, B1 |

\* old run surfaced B1/F1 only in the summary or bundled into a tests finding.
New models **gained the harder T3/T4 (TOCTOU, cache-collision)** but **lost B5 (token-bucket
drift) and the SQLi inline anchor**.

## ⚠️ Honest caveat

Same as the original batch: 13 hand-authored adversarial PRs, small N, our answer key is the
ground truth, labeling is judgment (the verbose "unhandled rejection / no validation" findings
are labeled noise as pervasive low-value patterns — a stricter or looser call would move
Sigilix's precision a few points). The defensible apples-to-apples real-world numbers remain
the live dogfood `/metrics/fp-rate` + the SIG-245 bar. **Net read: the model swap is a clear
win on recall (now best-in-class) and a modest precision gain; the remaining gap to CodeRabbit
is verbosity (over-eager secondary findings) + the SQLi inline-surfacing bug, not detection.**

_Full audit trail: `evals/data/*.json` + `*.worksheet.md`; machine report:
`rerun-report-2026-06-13.md`; planted-bug ground truth: `answer-key.md`._
