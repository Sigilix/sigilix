# Sigilix review-capability benchmark batch (real-world)

_Started 2026-06-10. Methodology: **13 hand-authored scenario PRs** across the three
e2e fixture repos (`sigilix-e2e-{backend,frontend,fullstack}`), each ≤ ~250 lines of
diff (Greptile caps reviews at 500 lines; staying ~250 keeps Greptile **and** Sigilix
from truncating). Each PR carries a documented answer key of planted **recall** items
(a real bug the bot should catch) and **precision traps** (tricky-but-correct code it
should stay silent on). Every PR is reviewed live by **Sigilix + CodeRabbit +
Greptile** on the prod path; findings are collected + labeled against the answer key
via the `compare-reviewers` harness. This is the **real-world** companion to the
curated-corpus believability baseline ([PR #415](https://github.com/Sigilix/sigilix/pull/415)),
measured on realistic PR diffs rather than adversarial unit corpora — the measured
result that the #415 caveat flags as "in progress"._

**Anti-bias design — a difficulty spectrum, not corpus recycling.** To avoid measuring
only the bug *classes* the specialists are already tuned on, the planted bugs are
**unique** (not lifted from the committed corpora) and span four tiers, floor to
ceiling:

- **T1 · Published / easy** — textbook OWASP / well-known patterns any competent tool
  should catch (classic string-concat SQLi, `dangerouslySetInnerHTML(userInput)`).
  Sets the **recall floor**.
- **T2 · Moderate** — common real-world bugs needing light reasoning (IDOR, missing
  `await`, stale `useEffect` dep, N+1).
- **T3 · Hard / subtle** — reasoning-only, no signature (TOCTOU race, currency float
  precision, refire-on-inline-dep).
- **T4 · Novel / "ungodly"** — bespoke domain logic with a subtle invariant violation
  unlikely to appear in any training set (custom token-bucket refill off-by-one, a
  client-cache key-collision under a specific sequence). Designed so the model *may
  never find it* — measures the **ceiling**.

_Layer B: the per-specialist **K=12** recall/over-fire baselines (PR #415's corpora)
are re-run on current `main` (Ollama Turbo prod path) to confirm no regression
alongside the real-world batch._

## Batch status

| # | Repo | Category | Tier | Planted item(s) | Expected | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | backend | security | T1 published | String-concat SQL injection in a new query path | catch P0 | 🟡 reviewed ([#26](https://github.com/Sigilix/sigilix-e2e-backend/pull/26)) — all 3 caught SQLi; Sigilix +2 testing, CR +1 minor, Greptile +3 CSV nits |
| B2 | backend | security | T2 moderate | IDOR — resource fetch w/o ownership check (**+** sibling that checks) | catch P1 / silent | 🔵 open ([#27](https://github.com/Sigilix/sigilix-e2e-backend/pull/27)) |
| B3 | backend | logic | T3 hard | TOCTOU race in check-then-act (inventory/balance) | catch P1 | 🔵 open ([#28](https://github.com/Sigilix/sigilix-e2e-backend/pull/28)) |
| B4 | backend | performance | T2 moderate | `await` in a `for` loop — serial N+1 (**+** must-be-serial loop) | catch P2 / silent | 🔵 open ([#29](https://github.com/Sigilix/sigilix-e2e-backend/pull/29)) |
| B5 | backend | logic | **T4 novel** | Custom token-bucket refill off-by-one at the boundary | catch P1 (ceiling) | 🔵 open ([#30](https://github.com/Sigilix/sigilix-e2e-backend/pull/30)) |
| F1 | frontend | security | T1 published | `dangerouslySetInnerHTML` with raw user input (**+** sanitized const) | catch P1 / silent | 🔵 open ([#17](https://github.com/Sigilix/sigilix-e2e-frontend/pull/17)) |
| F2 | frontend | logic | T2 moderate | `useEffect` missing a dependency (stale closure) | catch P2 | 🔵 open ([#18](https://github.com/Sigilix/sigilix-e2e-frontend/pull/18)) |
| F3 | frontend | performance | T3 hard | Effect refire from an inline object/array dep (**+** needed-memo trap) | catch P3 / silent | 🔵 open ([#19](https://github.com/Sigilix/sigilix-e2e-frontend/pull/19)) |
| F4 | frontend | logic | **T4 novel** | Client cache/dedupe key-collision under a specific call sequence | catch P2 (ceiling) | 🔵 open ([#20](https://github.com/Sigilix/sigilix-e2e-frontend/pull/20)) |
| FS1 | fullstack | security | T2 moderate | Server trusts client-supplied `isAdmin` — missing server-side authz | catch P1 | 🔵 open ([#21](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/21)) |
| FS2 | fullstack | tests | T2 trap | Glue component over a same-PR tested helper | **silent** (tests SIG-347) | 🔵 open ([#22](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/22)) |
| FS3 | fullstack | logic | T3 hard | Currency float precision in a refund/proration calc | catch P1 | 🔵 open ([#23](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/23)) |
| FS4 | fullstack | control | — | Behavior-preserving refactor (extract typed mapper) | **silent** (hallucination floor) | 🔵 open ([#24](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/24)) |

Legend: ⬜ planned · 🔵 PR open (awaiting bots) · 🟡 reviewed (awaiting label) · 🟢 scored.
**Progress: 13/13 opened · 13/13 reviewed · 13/13 scored.** ✅ batch complete.

### Headline (real-world, 13 PRs, 19 ground-truth bugs, 0 missed by all)

| Tool | Precision | Recall | FP noise/PR | Unique real |
| --- | ---: | ---: | ---: | ---: |
| **CodeRabbit** | **70.0%** | **73.7%** | **0.46** | 3 |
| Greptile | 52.6% | 52.6% | 0.69 | 1 |
| **Sigilix** | 41.4% | 63.2% | 1.31 | **4** |

Sigilix trailed on precision (tests over-fire) and recall, but found the most *unique*
real bugs. Top fixes the batch surfaces: (1) **suppress the tests-specialist over-fire**
(flip the SIG-347 tuning out of shadow); (2) **anchor T1 security findings inline**, not
only in the summary; (3) **dedupe** (Sigilix posted 3 near-identical findings for one bug
twice). Full breakdown: `compare-reviewers-report.md`.

Spread: security ×4, logic ×4, perf ×2, tests ×1, control ×1 · tiers T1 ×2, T2 ×5,
T3 ×3, T4 ×2 · 4 precision traps + 1 clean control.

## Per-tier recall (real-world batch)

_Recall by difficulty tier — the floor-to-ceiling read. Filled as PRs are scored._

| Tier | Planted recall items | Sigilix | CodeRabbit | Greptile |
| --- | --- | --- | --- | --- |
| T1 · published | 2 (SQLi, XSS) | 2/2 \* | 2/2 | 2/2 |
| T2 · moderate | 4 (IDOR, N+1, dep, authz) | 4/4 | 4/4 | 3/4 |
| T3 · hard | 3 (TOCTOU, refire, float$) | 2/3 | 2/3 | 1/3 |
| T4 · novel | 2 (token-bucket, cache-collision) | 1/2 | **2/2** | 1/2 |
| **Total (planted)** | **11** | **9/11 (82%)** \* | **10/11 (91%)** | **7/11 (64%)** |

\* Both of Sigilix's T1 catches (SQLi, XSS) landed in its **review summary**; *inline* it
posted only a tests over-fire, so inline T1 recall is 1/2 (a surfacing gap, not a
detection miss). The T4 ceiling proved reachable: the token-bucket drift was caught by
all three; the cache-key collision by **CodeRabbit only**. No planted bug was missed by
every tool.

## Per-category results (real-world batch)

_Real-bug rate per category, pooled across all three tools' findings (50 labeled
issues). Shows where each category's value vs. noise concentrates — the **tests** row is
the over-fire tax (every tests finding was noise; almost all were Sigilix's)._

| Category | Issues | Real bugs | Real-bug rate |
| --- | --- | --- | --- |
| Security | 12 | 7 | 58% |
| Performance | 4 | 4 | 100% |
| Logic | 18 | 8 | 44% |
| **Tests** | **12** | **0** | **0%** ← over-fire tax |
| Style | 4 | 0 | 0% |

## Competitive snapshot (head-to-head, this batch)

_From `compare-reviewers summary` once all PRs are labeled. To be pasted into
[PR #415](https://github.com/Sigilix/sigilix/pull/415) / `docs/believability-baseline.md`
as the measured real-world column alongside its curated estimate._

| Metric | CodeRabbit | Greptile | **Sigilix** |
| --- | --- | --- | --- |
| Precision (real ÷ flagged) | **70.0%** | 52.6% | 41.4% |
| Recall — all real bugs (n=19) | **73.7%** | 52.6% | 63.2% |
| Recall — planted bugs (n=11) | **91%** (10/11) | 64% (7/11) | 82% (9/11) \* |
| FP noise (findings on safe code, per PR) | **0.46** | 0.69 | 1.31 |
| Unique real catches (only this tool) | 3 | 1 | **4** |
| Comments posted (volume) | 21 | 19 | 41 |

\* counting Sigilix's summary-only T1 catches; inline-only it's 8/11 (73%).

**The moat — NOT held on this batch.** The hypothesis was that Sigilix occupies the
high-recall **AND** low-FP quadrant. On these real-world PRs it did **not**: CodeRabbit
led on *both* precision (70% vs 41%) and recall (74% vs 63%), and was the quietest
(0.46 noise/PR vs Sigilix's 1.31). Sigilix's strengths still showed — the most **unique**
real catches (4, incl. the FS3 float bug only it found) and competitive planted-bug
recall (82%) — but its precision was sunk by the **tests-specialist over-fire** (the
SIG-166 class) and a summary-vs-inline surfacing gap. The headline gap is a *believability*
problem, not a *detection* problem: Sigilix finds the bugs, then buries the signal under
"needs tests" noise and summary-only anchoring.

## Layer B — per-specialist K=12 baselines (live prod path)

_Carried from PR #415 (curated-corpus **K=12**, same Ollama-Turbo prod path,
2026-06-08); a fresh re-run on current `main` is a quick follow-up._

| Specialist | Recall | FP-rate (post-gate) |
| --- | --- | --- |
| Logic | 94% | 10% |
| Security | 100% | 0% |
| Performance | 100% | 0% |
| Tests | 100% | 0% |

**⚠️ The curated corpus and this real-world batch disagree about the tests specialist.**
On the curated over-fire corpus the tests specialist scores **100% recall / 0% FP**; on
this batch it was the **dominant noise source** (12 tests findings, all noise, ~all
Sigilix). The corpus doesn't capture the live over-fire shape — _"a small new endpoint /
component ships → fire 'needs tests'"_ — which is precisely the SIG-166 class. The
real-world batch is the truer read; the post-gate 0% FP holds only because the
tests-validator runs in **shadow** in prod (it counts but doesn't drop). This is the
single highest-leverage fix surfaced by the benchmark.

## ⚠️ Honest caveat — do not overclaim

- **Authored, not random.** The 13 scenarios are hand-authored across a deliberate
  difficulty spectrum (T1→T4) — not a uniform random sample of real-world PRs. Recall
  here is recall *on the planted items*; the T4 tier is intentionally near-impossible
  to map the ceiling, so a low T4 recall is expected and not a defect.
- **Small N.** ~13 PRs / ~18–20 ground-truth items; per-category and per-tier counts
  are small, so treat the rates as **directional**, not precise.
- **Unique bugs, by design.** Planted bugs are fresh (not from the committed corpora)
  to avoid measuring memorized classes — but that also means a few may be genuinely
  ambiguous; borderline labels are noted in the compare-reviewers worksheet.
- **Our answer key is the ground truth.** Mapping bot findings to planted items is a
  judgment call (equivalence-grouped per the compare-reviewers rule).
- **Same bot version window.** All three bots are measured on whatever each had
  deployed during the batch window; Sigilix = current `main`.

The defensible, apples-to-apples real-world numbers remain the live dogfood
`GET /metrics/fp-rate` + the **SIG-245** zero-P0/P1-FP bar, and a broad real-world
recall eval (**SIG-114**). This batch is a **controlled** real-world read that
complements both — and the difficulty-tiered design is what makes it more than a
re-run of the curated corpora.
