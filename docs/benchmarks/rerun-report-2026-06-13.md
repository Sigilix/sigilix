# Reviewer head-to-head comparison

_Generated 2026-06-13T03:43:43.478Z · 13 PR(s) collected, 12 labeled · 44 labeled issues._

## Outcome Matrix

| outcome | count | % of issues |
|---------|------:|------------:|
| real_bug | 18 | 40.9% |
| noise | 26 | 59.1% |
| **total** | **44** | |

## Per-Tool Precision And Recall

Precision = real bugs flagged ÷ everything the tool flagged. Recall = real bugs flagged ÷ all ground-truth real bugs.

| tool | comments | flagged issues | real | noise | precision | recall | unique real | only noise |
|------|---------:|---------------:|-----:|------:|----------:|-------:|------------:|-----------:|
| Sigilix | 35 | 31 | 15 | 16 | 48.4% | 83.3% | 3 | 13 |
| CodeRabbit | 21 | 20 | 14 | 6 | 70.0% | 77.8% | 1 | 4 |
| Greptile | 19 | 19 | 10 | 9 | 52.6% | 55.6% | 0 | 5 |

Ground-truth real bugs: **18**; missed by all compared tools: **0**.

## Overlap

| combination | real | noise | total |
|-------------|-----:|------:|------:|
| coderabbit | 1 | 4 | 5 |
| coderabbit+greptile | 2 | 1 | 3 |
| greptile | 0 | 5 | 5 |
| sigilix | 3 | 13 | 16 |
| sigilix+coderabbit | 4 | 0 | 4 |
| sigilix+coderabbit+greptile | 7 | 1 | 8 |
| sigilix+greptile | 1 | 2 | 3 |

Pairwise overlap counts include all-three rows.

| pair | shared issues |
|------|--------------:|
| sigilix+coderabbit | 12 |
| sigilix+greptile | 11 |
| coderabbit+greptile | 11 |

## By category

| category | issues | real bugs | real-bug rate |
|----------|-------:|----------:|--------------:|
| security | 9 | 6 | 66.7% |
| perf | 6 | 4 | 66.7% |
| logic | 24 | 8 | 33.3% |
| tests | 2 | 0 | 0.0% |
| style | 3 | 0 | 0.0% |

