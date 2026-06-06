# Sigilix vs CodeRabbit — head-to-head comparison

> ⚠️ **PROVISIONAL — worked example, not the SIG-70 decision dataset.** These 6 PRs
> are from the `sigilix-e2e-{backend,frontend,fullstack}` fixture repos and the
> real/noise labels are an **agent first-pass**, to demonstrate the tool end-to-end on
> live dual-bot data. Re-judge before relying on the numbers. Caveats:
> - Fixture PRs contain *planted* bugs, so almost everything is genuinely real →
>   near-100% precision here is an artifact of the corpus, not field behavior. Real
>   PRs will show more noise.
> - "ships without tests" findings are labeled **real** (valid, actionable) and land in
>   the `tests` category — that's why Sigilix's profile skews to coverage prompts while
>   CodeRabbit's skews to concrete logic/security bugs. Decide separately whether
>   coverage nudges should count as "real" for the keep/drop call.
> - The actual decision needs ~30 PRs that **both** bots reviewed (the dogfood repo
>   `Sigilix/sigilix` is the richest source) with **your** labels.
>
> Regenerate the body with `npm run compare-reviewers -- summary` (this banner is
> manual and won't survive a regen).

_Generated 2026-06-06T08:27:47.090Z · 6 PR(s) collected, 6 labeled · 34 labeled issues._

## Label matrix

| label | count | % of issues |
|-------|------:|------------:|
| sigilix_only_real_bug | 14 | 41.2% |
| sigilix_only_noise | 0 | 0.0% |
| cr_only_real_bug | 16 | 47.1% |
| cr_only_noise | 1 | 2.9% |
| both_real | 3 | 8.8% |
| both_noise | 0 | 0.0% |
| **total** | **34** | |

## Per-bot precision

Precision = real bugs ÷ everything the bot flagged.

| bot | flagged | real | noise | precision |
|-----|--------:|-----:|------:|----------:|
| Sigilix | 17 | 17 | 0 | 100.0% |
| CodeRabbit | 20 | 19 | 1 | 95.0% |

Overlap (both bots flagged the same issue): **3** (8.8% of issues).

## Decision support

What dropping CodeRabbit would cost vs. save:

- **Cost** — real bugs only CodeRabbit caught: **16**
- **Save** — CodeRabbit-only noise comments removed: **1**
- For reference, real bugs only Sigilix caught: 14; Sigilix-only noise: 0

## By category

| category | issues | real bugs | real-bug rate |
|----------|-------:|----------:|--------------:|
| security | 11 | 11 | 100.0% |
| perf | 1 | 1 | 100.0% |
| logic | 14 | 14 | 100.0% |
| tests | 7 | 7 | 100.0% |
| style | 1 | 0 | 0.0% |

