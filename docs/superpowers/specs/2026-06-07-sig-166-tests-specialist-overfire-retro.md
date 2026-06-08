# SIG-166 — Tests-specialist over-fire retrospective + precision-tuning spec (SIG-347)

**Status:** Implemented (SIG-347 PR 1 — cross-check + ratio damper + telemetry + this retro). The dogfood CI gate (AC #5) ships as PR 2.
**Ticket:** [SIG-166](https://linear.app/sigilix/issue/SIG-166) (epic) · [SIG-347](https://linear.app/sigilix/issue/SIG-347) (this work)
**Project:** Sigilix Engine — believability before design partners ([SIG-245](https://linear.app/sigilix/issue/SIG-245)).
**Builds on:** SIG-91 (sibling classification), SIG-113 (testing-evidence pack + citation gate), SIG-111 (specificity gate), SIG-128 (helper-coverage), SIG-159 / SIG-208 (structural-glue suppression for both classes), SIG-119/SIG-152 (shadow-telemetry endpoints).

---

## Why this retro exists

The tests specialist's "lacks coverage / needs more tests" over-fires have been a
recurring credibility problem on *every* recent dogfood PR despite **three**
independent fixes shipping. Each fix closed the **last-observed** over-fire class —
and a new one surfaced the next week. The founder framing (2026-05-23):

> *"the over-firing issue is happening consistently again so we need to do some deep
> tuning."*

This document captures **why each prior fix was insufficient** so the team stops
shipping patch-on-patch and starts shipping **safety belts proactively**. It is a
"Done when" deliverable of the epic.

## The arc — each fix scoped to the last-observed class

| Fix (date) | What it suppressed | What still over-fired after | Why the next class slipped through |
| -- | -- | -- | -- |
| **SIG-91** (05-19) | "no tests exist" when a sibling test was in the same diff | "no tests exist" on files whose sibling test wasn't in *this* PR | The classifier only looked at the in-diff file set; a repo-wide sibling was invisible. |
| **SIG-128** (05-21) | `glue-covered-by-helper`: "needs integration tests" when changed logic delegates to **same-PR tested helpers** (status `all`) | Over-fire when a wrapper delegates to a **mix** of same-PR + pre-existing helpers (status `partial`) | Suppression keyed on the strict `all` status; `partial` glue had no belt. |
| **SIG-128 PR 6 / SIG-159** (05-23, PR [#143](https://github.com/Sigilix/sigilix/pull/143)) | `glue-covered-by-structure`: structural orchestrator-glue independent of helper-coverage status | "needs coverage" on the **`insufficientClass`** path ("file has tests but this code path doesn't") | The structural-glue branch was scoped to `siblingMissingClass` only — the insufficient-test class bypassed it entirely. |
| **SIG-208** (05-25, PR [#170](https://github.com/Sigilix/sigilix/pull/170)) | Extended structural-glue suppression to **`insufficientClass`** | Over-fire on a **non-glue** file whose code path *is* already covered by an in-diff sibling test (PR [#144](https://github.com/Sigilix/sigilix/pull/144): `parsePrReviewResponse`) | Glue suppression requires the file to *be* orchestrator glue. A real-logic file with a real in-diff test still passed `namesConcreteTarget` + `citesRealInspectedTest` → KEEP. |

**The pattern:** every fix was a *reaction* to the most recent labeled FP, scoped
exactly to that FP's shape, with no belt anticipating the adjacent shape. The
suppression surface grew one class at a time while the FP frontier kept moving.

## The lesson: belts before bugs

A suppression heuristic that can drop a true positive is a recall liability. The
discipline this epic adopts: **every new suppression heuristic ships with its own
safety belt(s)** so it cannot suppress a real finding —

- a **scope belt** (only fire on the exact evidence shape the FP has),
- a **specificity belt** (require a concrete, non-generic cited target), and
- a **bound belt** (a line-count cap, a confidence floor, or "never drop — only
  de-emphasize").

The gates already lean hard toward KEEP (the SIG-108 review caught real findings
being dropped). SIG-347's additions preserve that bias.

## What SIG-347 adds (the proactive belts)

### AC #2 — sibling-test identifier cross-check (`cross-referenced-in-sibling-test`)

The direct fix for the PR #144 frontier. In the `insufficientClass` keep path
(`evaluateTestFinding`), before emitting, scan the **in-diff sibling test** of the
finding's own source path for the finding's cited identifier. A word-boundary hit ⇒
the "existing tests are insufficient" claim is an over-fire and the finding is
**suppressed** — *demote-not-drop* at the call site (see the belt note below), not a
hard delete.

Belts: (1) **in-diff, sibling-scoped only** — only the test paired with the finding's
source in `siblingMappings`, and only when that test is in `testFilesChanged` *with*
fetched content, is scanned; an unrelated changed test that mentions the same token
never suppresses, and a real "new code path uncovered by a pre-existing test" finding
survives; (2) **headline-scoped, concrete-identifier only** — the cited
identifier is extracted from the finding's *headline* (its primary subject), must
be backticked, identifier-shaped, length ≥ 4, and not in a generic stoplist
(`null`/`error`/`data`/…). A symbol mentioned only in passing body prose never
triggers a drop; (3) **word boundary** — `parse` never matches inside `parseFoo`.

**Accepted recall trade-off (stated honestly):** "referenced by the in-diff test"
is treated as a strong coverage signal, so a genuinely-uncovered *branch* of an
otherwise-referenced symbol can be suppressed. This is bounded by the three belts
above **and** by the fact that this is **demote-not-drop** — at the call site a
failed-gate testing finding is demoted to a non-blocking body note in `enforce`
(the residual real gap stays visible), kept inline in `shadow` — and **shadow-first**
(shares `OPENCLAW_TESTS_VALIDATOR_MODE`, so nothing drops in prod until an explicit
flip). The dogfood FPR/recall gate (PR 2) measures this directly before any flip.

### AC #3 — diff-test-ratio damper

When the PR's diff is itself test-heavy (substantive added test-to-source line
ratio > 0.3), a surviving testing finding is much more likely to be noise. Damp a
**kept** testing finding's confidence by one point.

Belt: **never drops and never hides** — only lowers severity by one, and is
**floored at 2** (a 2→1 damp would route the finding into the advisory/hidden
bucket, so a score-2 nit is left untouched; only the loud score≥3 over-fires are
quieted: a real score-5 finding stays an actionable 4). Runs *after* the
specificity gate, so it only touches findings the gate already kept, and clones
(never mutates the synth-aliased finding telemetry holds).

### AC #4 — per-drop-reason telemetry + `GET /metrics/test-suppressions`

Every drop reason already flows through `onTestFindingDropped` →
`pr-review-finding-rejected-validation` (gate `tests`) → the shared
`ValidationMetricsDO`. The new endpoint is a **focused projection** of that DO's
tests gate: per-reason `{wouldDrop, kept, suppressionRate}` + the testing-category
roll-up, so the suppression rate of each heuristic (including the two new ones) is
measurable post-deploy without scraping Worker logs. No new storage — reuses the
SIG-119 DO and bearer token.

## Over-fire audit (PRs #138, #142, #143, #144)

For each observed over-fire: which suppression heuristic *should* have fired, why it
didn't pre-SIG-347, and the regression pin. (The PR subject is incidental — these
are PRs the **bot reviewed** and over-fired on.)

| Reviewed PR | Over-fire shape | Heuristic that should fire | Why it didn't (pre-fix) | Regression pin |
| -- | -- | -- | -- | -- |
| [#138](https://github.com/Sigilix/sigilix/pull/138) (sig-156 cron) | "lacks coverage" on glue whose logic delegates to same-PR tested helpers | `glue-covered-by-helper` (status `all`) | Pre-SIG-128 the helper-coverage status didn't exist | `tests/validate-test-finding.test.ts` — "DROPS an insufficient-test finding on a status:'all' glue file (SIG-166-1)" |
| [#142](https://github.com/Sigilix/sigilix/pull/142) (sig-160 withdrawal) | "needs more tests" on a test-heavy change already adding coverage | AC #3 ratio damper (de-emphasis) + glue suppression | No diff-wide ratio signal existed; only per-file class checks | `tests/test-ratio-damper.test.ts` + the AC #3 integration pins. *Note:* the verbatim finding text wasn't recovered from the ticket; this PR is represented by the class-level damper pins, not a byte-exact reproduction. |
| [#143](https://github.com/Sigilix/sigilix/pull/143) (sig-128 PR6 — the fix itself) | residual `insufficientClass` glue bypass after `glue-covered-by-structure` shipped for `siblingMissingClass` only | `glue-covered-by-structure` on the insufficient class | The structural-glue branch was scoped to `siblingMissingClass` | `tests/validate-test-finding.test.ts` — "DROPS an insufficient-test finding on a structurallyGlue:true glue file with status 'partial' (SIG-166-1)" |
| [#144](https://github.com/Sigilix/sigilix/pull/144) (sig-162+164) | `parsePrReviewResponse` "kind coercion untested" on a **non-glue** file whose in-diff test covers it | **AC #2 cross-check** (`cross-referenced-in-sibling-test`) | Glue suppression can't fire on a real-logic file; the finding passed `namesConcreteTarget` + `citesRealInspectedTest` → KEEP | `tests/validate-test-finding.test.ts` — "DROPS the PR #144 over-fire: `parsePrReviewResponse` cited while an in-diff test references it" |

## Deferred to PR 2 (AC #5 — epic close-out)

Label the bot's findings on 5 dogfood PRs (target ≥ 95% TP / ≤ 5% FPR on
testing-class findings) and add a synthetic-fixture suite to CI that fails the build
when the testing-class FPR exceeds 5%. Sequenced **after** PR 1 so the gate is
calibrated against the post-tuning bot, not the bot it's about to change. Closing
the epic is gated on that FPR target being met against the improved behavior.
