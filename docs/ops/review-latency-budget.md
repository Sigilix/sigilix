# Review pipeline latency budget

**Status**: Living document. Updated when a phase target shifts or new telemetry surfaces a regression.
**Owner**: Sigilix Engine team.
**Linear**: [SIG-220](https://linear.app/sigilix/issue/SIG-220).

---

## Why this exists

After SIG-216 shipped (2026-05-25), the founder observed that Sigilix bot reviews on PRs got visibly slower:

- The Sigilix Check used to appear in GitHub's UI almost instantly after a push. Post-SIG-216 it took 5–10 min for the Check to even initialize.
- End-to-end review time grew from ~5.5 min to ~8–10 min.

Two compounding factors were identified:

1. SIG-216 added the inline `handlePrOverview` call inside `handlePrReviewEnsemble` — `await`-ed before `submitReview` to preserve the CodeRabbit-style "walkthrough then review" ordering. That serializes ~28s onto the review handler's critical path (telemetry-confirmed on PR #176: `pr-review-inline-overview-posted elapsed_ms=28548`).
2. The pre-SIG-218 outage produced a transient queue backlog of `VECTOR_UPSERT_ERROR` retries that pushed new webhooks behind retrying jobs.

This doc captures the target time-budget per pipeline phase, flags the levers we have to compress each phase, and records which lever we ship first.

---

## Pipeline phases + targets

The numbers below are wall-clock targets, not p50 / p99 confidence intervals (we don't have enough data points for that yet). Treat them as the budget the next push should fit inside.

| # | Phase | Surface | Target | Observed (post-SIG-216) | Source / lever |
|---|---|---|---|---|---|
| 1 | Webhook receipt → ack | GitHub waits for 200 | ≤ 200ms | ~50ms | Already-good. Hard requirement: <10s before GitHub retries. |
| 2 | Webhook ack → "Sigilix" check appears | Customer-visible | **≤ 5s** | 5–30s (was 2–30s pre-SIG-216) | **Lever 5** below. |
| 3 | Check appears → specialist fan-out starts | Internal | ≤ 5s | ~1–3s | DO routing + retrieval cache warmup. Existing. |
| 4 | Specialist fan-out | Internal | ≤ 180s | ~100–270s (slowest role) | **Lever 2** below. |
| 5 | Synthesizer pass | Internal | ≤ 60s | ~22–60s | Within budget. |
| 6 | Inline overview generation | Customer-visible | ≤ 90s | ~28s (confirmed PR #176) | Inside review handler critical path (SIG-216). **Lever 1** below. |
| 7 | Post-overview head re-check | Internal | ≤ 1s | ~0.5–1s | Defense in depth. **Lever 4** below. |
| 8 | `submitReview` | Customer-visible | ≤ 10s | ~3–10s | GitHub API latency, not ours. |
| 9 | Check completes | Customer-visible | ≤ 2s | ~1–2s | Within budget. |
| — | **End-to-end (push → review visible)** | Customer-visible | **≤ 360s (6 min)** | ~480–600s (8–10 min) | Composite of the above. |

---

## Levers identified

Each lever is rated by (a) impact on end-to-end latency or perceived latency and (b) implementation risk.

### Lever 1 — move inline overview off the critical path

**Surface**: `src/lib/triage-pr-review-ensemble.ts:3890–3954` (the `runInlineOverviewWithRetry` invocation).

**What**: today the overview is `await`-ed immediately before `submitReview` to preserve "walkthrough then review" ordering. ~28s on the wall clock.

**Options**:
- Move to `ctx.waitUntil` after `submitReview`. Saves ~28s end-to-end. Breaks ordering — overview may land AFTER the review on the GitHub timeline.
- Fire overview FIRST via `ctx.waitUntil`, then `await` review. Usually overview lands first but ordering isn't guaranteed.
- Switch overview to a smaller / faster model. Risk: lower-quality overviews.

**Recommendation**: defer. The ordering guarantee was a SIG-216 design decision — re-litigating it in a latency PR is the wrong forum. If we ever drop the ordering guarantee, this is the lever that captures it.

**Status**: not shipping.

### Lever 2 — tighten the specialist fan-out

**Surface**: `src/lib/triage-pr-review-ensemble.ts:345` (`SPECIALIST_TIMEOUT_MS = 270_000`) and `:431` (`PER_ATTEMPT_TIMEOUT_MS = 60_000`).

**What**: fan-out waits for the slowest role to either finish or exhaust retries. Telemetry on a recent dogfood PR showed `logic` role at `fanoutElapsedMs=106565` with a `60_000`-ms per-attempt abort. That's the per-attempt cap firing on attempt 1, then retry attempts adding up.

**Options**:
- Tighten per-attempt cap (60s → 45s). Risk: more aborts forcing retries → may not help and could hurt.
- Reduce retry count on the slowest role. Saves time but risks empty verdicts.
- Move `logic` to a faster model (current per SIG-4 lineup is `deepseek-v4-pro:cloud`, known to be slow ~2–5 min per query).
- Add a "min-specialists" early exit: if 3 of 4 specialists return AND we have enough signal, fire synth without the 4th.

**Recommendation**: defer to a dedicated PR with shadow-mode bake-off. This is the highest-impact lever but the riskiest — fan-out tightening is exactly where empty-verdict regressions hide.

**Status**: not shipping in this PR. Filed as a future Linear item.

### Lever 3 — drain the SIG-218 retry backlog

**Surface**: Cloudflare Queue consumer.

**What**: every PR review pre-SIG-218 hotfix crashed with `VECTOR_UPSERT_ERROR`. Each crash → CF Queue retries → backlog.

**Recommendation**: transient. The retry budgets exhaust within ~24h. Verify drained via `wrangler tail` ~2026-05-27. If still piling up, bump consumer concurrency or shorten DLQ.

**Status**: passive monitoring. No code change.

### Lever 4 — drop the post-overview head re-check

**Surface**: `src/lib/triage-pr-review-ensemble.ts:3964–3983`.

**What**: after the inline overview returns and before `submitReview`, re-check the PR head via GitHub API. Adds ~0.5–1s. SIG-216 added this as defense-in-depth against head moves landing during the overview's Ollama window.

**Recommendation**: defer. Marginal savings vs. the race-condition risk surfaced. The pre-overview guards inside the overview handler already cover the bulk of the race window.

**Status**: not shipping.

### Lever 5 — create the check upstream in the DO's `handleEnqueue`

**Surface**: `src/index.ts:1208` (current dispatcher-level call) → moved into `PrReviewRunDO.handleEnqueue` (`src/do/pr-review-run.ts`) on the `create | supersede` paths, and the resulting `checkRunId` is threaded through `RunState` + the pr-review queue message + the retry-alarm requeue.

**What**: today the "Sigilix · In progress" check is created at the dispatcher level — after the queue consumer dequeues the `pr-review` message. The webhook → queue → consumer → dispatcher chain costs 2–30s of perceived latency before the customer sees any signal in the GitHub UI. The naive fix — call `startInProgressCheckRun` directly inside the worker fetch handler — would orphan checks on three branches (DO dedupe of webhook replays, the pause/ignore gate, the dispatcher's sensitive-repo skip). Creating the check INSIDE `handleEnqueue` once `decideEnqueueAction` returns `create | supersede` avoids all three: pause/ignore + dedupe never reach this code, and the dispatcher's sensitive-repo branch + the watchdog's terminal-failure path get explicit tear-down calls.

**Trade-offs**:
- The DO's `/enqueue` route (which the webhook already awaits, see `src/do/webhook-enqueue.ts:123`) does an extra GitHub API call (~500ms–1s) before returning. Still well under GitHub's 10s ack threshold; wrapped in a `Promise.race` with a 3s timeout so GitHub API degradation can't push the webhook ack past the redelivery threshold.
- The `checkRunId` has to thread through `RunState` + the pr-review queue message into the dispatcher so the existing `completeCheckRun` call closes the right row.
- Orphan risk: if the queue consumer never runs (dead worker, etc.), the check stays `in_progress` until the DO's watchdog terminal-failure path fires and closes it (now wired in this PR). The existing `cancelStaleInProgressChecks` also cleans up on the next push to the same head SHA.

**Recommendation**: **ship this lever first.** Highest perceived-latency win, lowest implementation risk, no model-quality risk.

**Status**: this PR. See [Shipping plan](#shipping-plan).

---

## Shipping plan

### This PR (SIG-220)

Lever 5 only. The latency budget doc lands here; the code change moves `startInProgressCheckRun` from `dispatchJob` into `PrReviewRunDO.handleEnqueue` (on the `create | supersede` paths) and threads `checkRunId` through `RunState` + the pr-review queue message + the retry-alarm requeue. The new `attachExistingCheckRun` helper in `src/lib/pr-review-check-run.ts` lets the dispatcher + watchdog rebuild a check-run handle off the installation id.

**Acceptance**:
- Next push triggers the Sigilix Check within ~5s in the GitHub UI.
- Existing pipeline behavior unchanged for legacy queue messages without `checkRunId` (backwards-compatible fallback in the dispatcher).
- Regression tests in `tests/do-pr-review-sig-220-check-init.test.ts` (DO `handleEnqueue` create/supersede/dedupe + retry-alarm forwarding + watchdog terminal closure) and `tests/dispatch-job-check-run-lifecycle.test.ts` (dispatcher attach-vs-create branching + sensitive-repo skip closing the upstream check).

### Follow-ups (not in this PR)

- Lever 2 (fan-out tightening) — shadow-mode bake-off in a dedicated ticket.
- Watchdog cron for orphan in-progress checks (only if Lever 5 produces real orphans in prod).
- Lever 1 (overview off critical path) — only if the ordering guarantee is renegotiated.

---

## Measurement

Telemetry events to watch in `wrangler tail` after each lever ships:

- `pr-review-check-run-created` — captures (head_sha, check_run_id, timestamp). Compare against webhook delivery timestamp to validate phase 2 target.
- `specialist-fanout-summary` — `fanoutElapsedMs` is the canonical phase-4 measure.
- `pr-review-inline-overview-posted` — `elapsed_ms` is the canonical phase-6 measure.
- `pr-review-check-run-completed` — close-of-loop; (webhook delivery → this event) is the end-to-end target.

Manual verification gate before closing this ticket:

1. Open a dogfood PR; push a commit.
2. Confirm the "Sigilix" check appears in the PR's Checks tab within 5s.
3. Confirm the full review still lands within end-to-end budget (~6 min).
4. Founder sign-off that "the bot feels fast again."
