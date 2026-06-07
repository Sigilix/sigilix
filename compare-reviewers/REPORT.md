# Reviewer head-to-head comparison

> PROVISIONAL — worked example, not the SIG-326 decision dataset. These 6 PRs
> are from the `sigilix-e2e-{backend,frontend,fullstack}` fixture repos and the
> real/noise labels are an agent first-pass, retained to demonstrate the tool
> end-to-end on live dual-bot data. Greptile has not been run on this fixture
> set, so its zero counts below mean "not collected", not "missed everything".
> Re-judge and rerun on the shared Sigilix/CodeRabbit/Greptile PR set before
> relying on the numbers.
>
> Regenerate the body with `npm run compare-reviewers -- summary`; this banner is
> manual and will need to be re-added after regeneration.

_Generated 2026-06-07T14:58:00.441Z · 6 PR(s) collected, 6 labeled · 34 labeled issues._

## Outcome Matrix

| outcome | count | % of issues |
|---------|------:|------------:|
| real_bug | 33 | 97.1% |
| noise | 1 | 2.9% |
| **total** | **34** | |

## Per-Tool Precision And Recall

Precision = real bugs flagged ÷ everything the tool flagged. Recall = real bugs flagged ÷ all ground-truth real bugs.

| tool | comments | flagged issues | real | noise | precision | recall | unique real | only noise |
|------|---------:|---------------:|-----:|------:|----------:|-------:|------------:|-----------:|
| Sigilix | 17 | 17 | 17 | 0 | 100.0% | 51.5% | 14 | 0 |
| CodeRabbit | 20 | 20 | 19 | 1 | 95.0% | 57.6% | 16 | 1 |
| Greptile | 0 | 0 | 0 | 0 | — | 0.0% | 0 | 0 |

Coverage note: Greptile had zero collected comments. Treat recall for those tools as not interpretable until you verify they actually reviewed the sampled PRs.

Ground-truth real bugs: **33**; missed by all compared tools: **0**.

## Overlap

| combination | real | noise | total |
|-------------|-----:|------:|------:|
| coderabbit | 16 | 1 | 17 |
| sigilix | 14 | 0 | 14 |
| sigilix+coderabbit | 3 | 0 | 3 |

Pairwise overlap counts include all-three rows.

| pair | shared issues |
|------|--------------:|
| sigilix+coderabbit | 3 |
| sigilix+greptile | 0 |
| coderabbit+greptile | 0 |

## By category

| category | issues | real bugs | real-bug rate |
|----------|-------:|----------:|--------------:|
| security | 11 | 11 | 100.0% |
| perf | 1 | 1 | 100.0% |
| logic | 14 | 14 | 100.0% |
| tests | 7 | 7 | 100.0% |
| style | 1 | 0 | 0.0% |
