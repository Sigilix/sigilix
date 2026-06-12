# Reviewer head-to-head comparison

_Generated 2026-06-12T04:41:23.844Z · 13 PR(s) collected, 12 labeled · 50 labeled issues._

## Outcome Matrix

| outcome | count | % of issues |
|---------|------:|------------:|
| real_bug | 19 | 38.0% |
| noise | 31 | 62.0% |
| **total** | **50** | |

## Per-Tool Precision And Recall

Precision = real bugs flagged ÷ everything the tool flagged. Recall = real bugs flagged ÷ all ground-truth real bugs.

| tool | comments | flagged issues | real | noise | precision | recall | unique real | only noise |
|------|---------:|---------------:|-----:|------:|----------:|-------:|------------:|-----------:|
| Sigilix | 41 | 29 | 12 | 17 | 41.4% | 63.2% | 4 | 17 |
| CodeRabbit | 21 | 20 | 14 | 6 | 70.0% | 73.7% | 3 | 5 |
| Greptile | 19 | 19 | 10 | 9 | 52.6% | 52.6% | 1 | 8 |

Ground-truth real bugs: **19**; missed by all compared tools: **0**.

## Overlap

| combination | real | noise | total |
|-------------|-----:|------:|------:|
| coderabbit | 3 | 5 | 8 |
| coderabbit+greptile | 3 | 1 | 4 |
| greptile | 1 | 8 | 9 |
| sigilix | 4 | 17 | 21 |
| sigilix+coderabbit | 2 | 0 | 2 |
| sigilix+coderabbit+greptile | 6 | 0 | 6 |

Pairwise overlap counts include all-three rows.

| pair | shared issues |
|------|--------------:|
| sigilix+coderabbit | 8 |
| sigilix+greptile | 6 |
| coderabbit+greptile | 10 |

## By category

| category | issues | real bugs | real-bug rate |
|----------|-------:|----------:|--------------:|
| security | 12 | 7 | 58.3% |
| perf | 4 | 4 | 100.0% |
| logic | 18 | 8 | 44.4% |
| tests | 12 | 0 | 0.0% |
| style | 4 | 0 | 0.0% |

