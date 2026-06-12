# Reviewer head-to-head comparison

_Generated 2026-06-12T02:36:37.872Z · 7 PR(s) collected, 6 labeled · 34 labeled issues._

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
| Sigilix | 32 | 17 | 17 | 0 | 100.0% | 51.5% | 14 | 0 |
| CodeRabbit | 20 | 20 | 19 | 1 | 95.0% | 57.6% | 16 | 1 |
| Greptile | 9 | 0 | 0 | 0 | — | 0.0% | 0 | 0 |

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

