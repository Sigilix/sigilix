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
**Progress: 13/13 opened · 1/13 reviewed · 0/13 scored.**

Spread: security ×4, logic ×4, perf ×2, tests ×1, control ×1 · tiers T1 ×2, T2 ×5,
T3 ×3, T4 ×2 · 4 precision traps + 1 clean control.

## Per-tier recall (real-world batch)

_Recall by difficulty tier — the floor-to-ceiling read. Filled as PRs are scored._

| Tier | Planted recall items | Sigilix caught | CodeRabbit | Greptile |
| --- | --- | --- | --- | --- |
| T1 · published | — | — | — | — |
| T2 · moderate | — | — | — | — |
| T3 · hard | — | — | — | — |
| T4 · novel | — | — | — | — |

## Per-category results (real-world batch)

_Recall = planted recall items caught; FP-rate = findings on trap/clean code ÷ total
findings; Precision = true findings ÷ total findings._

| Category | Recall | Precision | FP-rate |
| --- | --- | --- | --- |
| Security | — | — | — |
| Logic | — | — | — |
| Performance | — | — | — |
| Tests | — | — | — |
| **Overall** | — | — | — |

## Competitive snapshot (head-to-head, this batch)

_From `compare-reviewers summary` once all PRs are labeled. To be pasted into
[PR #415](https://github.com/Sigilix/sigilix/pull/415) / `docs/believability-baseline.md`
as the measured real-world column alongside its curated estimate._

| Metric | CodeRabbit | Greptile | **Sigilix** |
| --- | --- | --- | --- |
| Recall (planted bugs caught) | — | — | — |
| Precision (true / flagged) | — | — | — |
| FP noise (findings on safe code, per PR) | — | — | — |
| Unique real catches (only this tool) | — | — | — |

**The moat (hypothesis under test):** CodeRabbit trades recall for quiet; Greptile
trades quiet for recall. This batch tests whether Sigilix holds the **high-recall AND
low-FP** quadrant on realistic PRs — and how far up the T3/T4 difficulty curve it
reaches before the others.

## Layer B — per-specialist K=12 baselines (live prod path)

_Re-run of the believability-baseline corpora (PR #415) on current `main`._

| Specialist | Recall | FP-rate (post-gate) |
| --- | --- | --- |
| Logic | — | — |
| Security | — | — |
| Performance | — | — |
| Tests | — | — |

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
