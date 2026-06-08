// SIG-318 (PR 1) — the PR-review ensemble's timeout budget (domain layer).
//
// PURE constants + their load-time invariants. No env, network, or storage.
// The interlocking timeout schedule — specialist → synth → (in-headroom) retry,
// all inside the orchestrator wall, which itself stays under Cloudflare Queues'
// 900s consumer ceiling — plus the module-load assertions that a misconfigured
// budget fails fast at import rather than silently losing reviews in prod.
//
// Moved verbatim from `triage-pr-review-ensemble.ts` and re-exported there, so
// existing importers and the runtime fail-fast are unchanged. The five inline
// module-load `if (…) throw` checks are refactored into one pure, exported
// function (`assertEnsembleBudgetInvariants`) so every bad permutation is
// unit-testable; it is invoked once below with the real values, preserving the
// original throw-at-import behavior.

// Phase 4a.3 timeout schedule (rebalanced 2026-05-06 after Phase 4a.2
// telemetry validation, ARC-171). The Phase 4a.1 sizing (180s) was
// based on "median successful logic latency = 78s" — but that figure
// excluded the failed-aborted runs that were silently capped at 90s
// pre-Phase-4a.1 and 180s pre-Phase-4a.3. Real post-4a.2 telemetry
// (PR #45 record) showed `deepseek-v4-pro:cloud` consistently doing 2
// primary attempts of ~90s each, exhausting the 180s budget mid-
// second-attempt and killing the cross-provider fallback before it
// could fire.
//
// SIG-234 (2026-05-26): tightened 270s → 185s. The new lineup
// retires `deepseek-v4-pro:cloud` from the logic primary slot
// (was the 100-270s wall-time floor). New primaries fit a
// realistic worst case of 3 attempts × 60s per-attempt cap = 180s,
// rounded up to 185s for the 1s inter-attempt retry-backoff slack
// asserted by the budget-invariant test below. The pre-tighten 270s
// was a comfort budget for the v4-pro slow path; with v4-flash +
// qwen3-coder-next + minimax-m2.5 + glm-5.1, we don't need it. The
// static invariant test regression-guards the budget arithmetic.
//
// Pre-SIG-234 history: sized to fit `2 primary attempts (2×90s) +
// retry backoff (~1s) + 1 cross-provider fallback attempt (~80s,
// kimi-k2.5:cloud)` = 261s, rounded up to 270s for slack.
//
// SIG-287 (2026-05-30): bumped 185s → 250s → 370s over successive passes.
// Live telemetry showed logic aborting mid-generation at its per-attempt cap on
// 13k+-tok prompts (graph+symbol+retrieval context) while security/perf/tests
// finish in 4-25s — logic is the unique long-pole. 110s, then 240s, each STILL
// left it INTERMITTENT (available on some reviews, aborted on others). A
// thorough logic pass legitimately takes minutes (CodeRabbit/Greptile too);
// founder ruling: availability+believability outrank speed, reviews up to ~8 min
// are fine, the only HARD ceiling is Cloudflare's 900s queue-consumer limit.
// 370s fits logic's 360s per-attempt within the invariant (370+325+195 = 890 ≤
// 895; synth trimmed 420→325 to make room — it was wildly over-provisioned).
// Other roles finish fast, so the higher wall is pure headroom for them.
export const SPECIALIST_TIMEOUT_MS = 370_000
// ARC-283: synth budget bumped from 180s → 420s after PR #93's own
// review timed out at 180s on a 900-line diff + 27 new tests.
// Sigilix's product positioning is "yes cost more time for BETTER,
// more THOUGHT-OUT reviews" — timing out is a non-starter when
// specialists already returned cleanly and the merge step just
// needed more time. 420s comfortably handles 3-4× the diff size
// that timed out at 180s. Pre-ARC-283 telemetry showed synth at
// 22-100s on small/medium PRs; the 420s ceiling matches the
// product brand without leaving runaway resource budgets open.
//
// SIG-287 (2026-05-30): trimmed 420s → 325s to free budget for logic's 360s
// per-attempt. Synth was over-provisioned — telemetry shows it at 22-100s, so
// the 325s primary + the 160s in-headroom retry is still 3-5× the observed p95.
export const SYNTHESIZER_TIMEOUT_MS = 325_000
// ARC-278 + ARC-283: cap for the one-shot synth RETRY budget. Lives
// INSIDE the reserved headroom — the retry is "use what's left in
// the headroom envelope, don't extend the orchestrator wall."
//
// Pre-ARC-283: 30s. That was enough for parse/provenance retries
// (the model already produced output, just needed to re-emit
// cleanly) but useless when primary timed out on actual model
// latency — the retry would just timeout again in 30s.
//
// Post-ARC-283: 160s. A retry that fires after a primary timeout
// now has a real shot at completing; a retry that fires after a
// parse/provenance failure still completes fast (those don't need
// the full budget). Trimmed from 170s → 160s on Sigilix's own
// PR #94 review catch to make room for pre-flight retrieval in
// the headroom envelope (see invariant block below).
//
// Budget math (current — post-SIG-287):
//   SPECIALIST (370) + SYNTHESIZER (325) + RESERVED_HEADROOM (195) = 890
//   Inside the 195s headroom: pre-flight (15) + retry (160) + finalize (20).
//   So `RESERVED_HEADROOM_MS` is NOT spent in addition to retry —
//   pre-flight, retry, AND finalize all carve out of it. The second
//   module-load invariant below verifies that arithmetic.
export const SYNTHESIZER_RETRY_TIMEOUT_MS = 160_000
// Reserved for pre-flight retrieval + diff parse + stale-head guards +
// telemetry write — AND, post-ARC-278, for the synth retry call when
// it fires. The orchestrator must always have at least this much
// headroom beyond (specialist + synth) so a slow Vectorize round-trip
// doesn't eat into the synth budget.
//
// ARC-283 + Sigilix PR #94 catch: bumped 40s → 195s. The 195s budget
// breakdown: pre-flight retrieval (15s, see RETRIEVAL_PREFLIGHT_TIMEOUT_MS) +
// synth retry (160s) + finalize reserve (20s). Pre-Sigilix-catch
// version was 190s — short by exactly the 15s pre-flight, which
// caused worst-case wall-clock to overshoot the orchestrator by 5s
// and abort the run during finalize (reintroducing the very failure
// mode ARC-283 was meant to eliminate).
export const RESERVED_HEADROOM_MS = 195_000
// Current (post-SIG-287): 370 + 325 + 195 = 890, with 5s slack inside
// the orchestrator. Cloudflare queue consumer ceiling is 900s, so the
// 895s budget stays just inside the platform limit while
// extending the per-review wall-clock from 8.2 min → 14.9 min.
// Phase B (DO-alarm-driven synth) lifts the queue ceiling entirely;
// tracked in ARC-283. For now, 895s comfortably absorbs the diffs
// that pre-ARC-283 was burning out on.
export const ORCHESTRATOR_TIMEOUT_MS = 895_000

// Cap the pre-flight Vectorize round-trip so a slow retrieval can't
// silently consume the synth budget. Failed pre-flight is non-fatal
// per v3.1 §8 — specialists fall back to empty snapshot.
export const RETRIEVAL_PREFLIGHT_TIMEOUT_MS = 15_000

// Phase 4a.4 (ARC-175): cap each individual model attempt inside
// `runWithRetryAndFallback` so a single slow primary call can't eat
// the entire `SPECIALIST_TIMEOUT_MS` budget and starve the retry +
// fallback. Telemetry on PR #47 (Phase 4a.3 era) showed v4-pro logic
// stalling for the full 270s on a single attempt with `attempts=1` —
// the budget extension just gave the primary more rope.
//
// ARC-283 B1a: tightened 85s → 60s based on real-run telemetry from
// PR #96 (the B0 dogfood capture). Observed healthy logic specialist
// latency on two clean runs was 28s and 57s — the 85s cap was way
// above the natural distribution. Tightening to 60s:
//
//   - Gives healthy attempts (28-57s observed) ~3-30s of margin —
//     still completes successfully.
//   - Cuts each failed-primary attempt's wasted wall-clock by 25s.
//     Worst-case retry-chain compresses from 256s → 181s per role.
//   - The 9-min P99 outliers on PR #94 came from a specialist's
//     retry chain hitting the full 85s × 3 attempts. At 60s the
//     same chain would take 181s — saving ~75s per offending role.
//
// Math under the new cap: 2 × 60s primary + ~1s backoff + 60s
// fallback = ~181s, fits comfortably within the 370s SPECIALIST
// budget (189s slack).
export const PER_ATTEMPT_TIMEOUT_MS = 60_000
// Graph RPC budget: graph context is purely additive; a slow DO call must
// not consume orchestrator wall time. Env-tunable via
// OPENCLAW_GRAPH_RPC_TIMEOUT_MS (e.g. for integration test overrides).
// Default 2500 ms is generous for a local DO RPC but tight enough that a
// hung worker doesn't delay the review.
export const GRAPH_RPC_TIMEOUT_MS = 2_500
// SIG-286: wall-clock budget for the shadow graph-context expansion (one DO RPC
// + in-process body slicing, no GitHub reads in PR1). Composed with
// orchCtrl.signal so a stuck DO can never delay the review.
export const GRAPH_EXPANSION_TIMEOUT_MS = 3_000

// ARC-278 + ARC-283 retry budget invariant — pre-flight retrieval +
// synth retry + finalize ALL share the RESERVED_HEADROOM_MS envelope.
// The orchestrator's wall-clock budget is laid out as:
//
//   [ pre-flight ] [ specialists (parallel) ] [ synth primary ]
//                                              [ synth retry  ]
//                                              [ finalize     ]
//
// Pre-flight runs INSIDE the orchestrator timer (orchTimer starts
// BEFORE preflightRetrieval — verified by tracing the orchCtrl
// usage). It does NOT extend specialist/synth — but it DOES consume
// orchestrator wall-clock, so it has to be charged against headroom.
//
// Sigilix's PR #94 self-review caught the pre-ARC-283-fix-up version
// (HEADROOM=190) missing the 15s pre-flight allowance — worst-case
// wall-clock was 895s vs 890s orchestrator, aborting the run during
// finalize. The third invariant below regression-guards that math.
//
// Pre-ARC-283 finalize was budgeted at 5s; ARC-283 bumped to 20s to
// defend against slower telemetry writes / daily-budget increments /
// cache writes when synth produces a large finding set.
//
// Exported per Sigilix's PR #94 follow-up finding (orphaned on the
// merged PR, picked up here as ARC-288): the test that pins the
// synth-retry budget invariant must import the same constant the
// runtime guard uses, not a hardcoded duplicate that can drift the
// next time the budget changes.
export const SYNTH_RETRY_FINALIZE_RESERVE_MS = 20_000

// Cloudflare Queues consumer wall — the entire orchestrator runs
// inside the queue consumer's request handler, which the platform
// caps at 900s. Tracked separately from the orchestrator invariant
// because a future bump that ignores the platform ceiling would
// silently lose every review on production.
//
// SIG-318: exported (was module-private in the god-file) so the invariant unit
// test imports the same ceiling the guard uses (ARC-288 convention). NOT
// re-exported by triage-pr-review-ensemble.ts — the god-file's public surface
// is unchanged; only callers that reference the budget domain directly see it.
export const CF_QUEUE_CONSUMER_CEILING_MS = 900_000

// ARC-283 Phase B1b review pass — shadow tail grace cap.
//
// The orchestrator's `finally` block awaits any in-flight shadow
// promises so it can emit `shadow-verdict-comparison` telemetry on
// every exit path. Pre-grace, those awaits cleared the `orchTimer`
// FIRST, which meant `orchCtrl.signal` no longer autonomously fired
// — a pathologically slow shadow could run for up to ~180s
// (60s per-attempt × (retries + 1) + fallback) AFTER prod returned.
//
// Worst case math: prod returns at the orchestrator-timeout edge
// (895s) and the shadow happens to be in the middle of its
// fallback attempt. Without a tail cap, the queue consumer would
// have to wait the full 180s for shadow to finalize, blowing past
// the 900s CF Queues consumer ceiling → worker hard-killed mid-
// await → message re-delivered → duplicate review.
//
// The cap is RELATIVE to when the finally block STARTS, not
// absolute from handler start. Value chosen as the maximum we can
// afford without violating the CF ceiling:
//
//   CF_QUEUE_CONSUMER_CEILING_MS - ORCHESTRATOR_TIMEOUT_MS
//   = 900_000 - 895_000
//   = 5_000ms
//
// At 5s a healthy shadow that's milliseconds-from-settling still
// emits its comparison; a pathological one gets cut short with a
// `shadow-cut-short` event and the prod return is unaffected.
// Total worst-case wall-clock = 895s + 5s = 900s, exactly at the
// CF ceiling but not over it.
//
// Exported so the helper's unit test can race against the same
// budget the runtime guard uses, mirroring the
// `SYNTH_RETRY_FINALIZE_RESERVE_MS` convention earlier in this file.
export const SHADOW_FINALIZE_GRACE_MS = 5_000

// ── Load-time budget invariants ───────────────────────────────────────────
//
// Refactored from the five inline module-load `if (…) throw` checks that
// previously sat between these constants. Same arithmetic, same throw messages
// — now a pure function so each bad permutation is exercisable in a unit test
// (the inline form could only ever observe the one valid permutation).

/** The timeout constants the budget invariants constrain. */
export interface EnsembleBudgetTimeouts {
  specialistMs: number
  synthesizerMs: number
  synthesizerRetryMs: number
  reservedHeadroomMs: number
  orchestratorMs: number
  retrievalPreflightMs: number
  synthRetryFinalizeReserveMs: number
  cfQueueConsumerCeilingMs: number
  shadowFinalizeGraceMs: number
}

/**
 * Throws if any timeout-budget invariant is violated. Invoked at module load
 * with the real constants (fail-fast on a misconfigured build) and exercised
 * with bad permutations in `tests/ensemble-budget.test.ts`.
 */
export function assertEnsembleBudgetInvariants(b: EnsembleBudgetTimeouts): void {
  // Static budget invariant — guarantees the synth always has its full budget
  // regardless of pre-flight + diff-parse + stale-head latency.
  if (b.specialistMs + b.synthesizerMs + b.reservedHeadroomMs > b.orchestratorMs) {
    throw new Error(
      `[ensemble] timeout invariant violated: ` +
        `SPECIALIST_TIMEOUT_MS (${b.specialistMs}) + ` +
        `SYNTHESIZER_TIMEOUT_MS (${b.synthesizerMs}) + ` +
        `RESERVED_HEADROOM_MS (${b.reservedHeadroomMs}) ` +
        `must be ≤ ORCHESTRATOR_TIMEOUT_MS (${b.orchestratorMs}).`,
    )
  }
  // ARC-278 + ARC-283 retry budget invariant — synth retry + finalize share
  // the reserved-headroom envelope.
  if (b.synthesizerRetryMs + b.synthRetryFinalizeReserveMs > b.reservedHeadroomMs) {
    throw new Error(
      `[ensemble] synth-retry budget invariant violated: ` +
        `SYNTHESIZER_RETRY_TIMEOUT_MS (${b.synthesizerRetryMs}) + ` +
        `SYNTH_RETRY_FINALIZE_RESERVE_MS (${b.synthRetryFinalizeReserveMs}) ` +
        `must be ≤ RESERVED_HEADROOM_MS (${b.reservedHeadroomMs}).`,
    )
  }
  // Sigilix PR #94 catch — pre-flight is the third consumer of the headroom
  // envelope alongside retry + finalize.
  if (
    b.retrievalPreflightMs +
      b.synthesizerRetryMs +
      b.synthRetryFinalizeReserveMs >
    b.reservedHeadroomMs
  ) {
    throw new Error(
      `[ensemble] headroom-envelope invariant violated: ` +
        `RETRIEVAL_PREFLIGHT_TIMEOUT_MS (${b.retrievalPreflightMs}) + ` +
        `SYNTHESIZER_RETRY_TIMEOUT_MS (${b.synthesizerRetryMs}) + ` +
        `SYNTH_RETRY_FINALIZE_RESERVE_MS (${b.synthRetryFinalizeReserveMs}) ` +
        `must be ≤ RESERVED_HEADROOM_MS (${b.reservedHeadroomMs}).`,
    )
  }
  // Cloudflare Queues consumer wall — the orchestrator runs inside the queue
  // consumer's request handler, which the platform caps at 900s.
  if (b.orchestratorMs >= b.cfQueueConsumerCeilingMs) {
    throw new Error(
      `[ensemble] queue-ceiling invariant violated: ` +
        `ORCHESTRATOR_TIMEOUT_MS (${b.orchestratorMs}) ` +
        `must be < CF_QUEUE_CONSUMER_CEILING_MS (${b.cfQueueConsumerCeilingMs}). ` +
        `Phase B (DO-alarm-driven synth, tracked in ARC-283) lifts this ceiling entirely.`,
    )
  }
  // Shadow tail grace — a pathologically slow shadow finalize must not push the
  // queue consumer past the CF ceiling.
  if (b.shadowFinalizeGraceMs + b.orchestratorMs > b.cfQueueConsumerCeilingMs) {
    throw new Error(
      `[ensemble] shadow-grace invariant violated: ` +
        `SHADOW_FINALIZE_GRACE_MS (${b.shadowFinalizeGraceMs}) + ` +
        `ORCHESTRATOR_TIMEOUT_MS (${b.orchestratorMs}) ` +
        `must be ≤ CF_QUEUE_CONSUMER_CEILING_MS (${b.cfQueueConsumerCeilingMs}). ` +
        `A pathologically slow shadow tail can otherwise push the queue ` +
        `consumer past the 900s ceiling → worker hard-killed → message re-delivered.`,
    )
  }
}

// Fail fast at import: a misconfigured budget throws at module load, not at
// runtime (mirrors the original inline checks). triage-pr-review-ensemble.ts
// value-imports these constants, so this assertion fires whenever the ensemble
// module graph loads.
assertEnsembleBudgetInvariants({
  specialistMs: SPECIALIST_TIMEOUT_MS,
  synthesizerMs: SYNTHESIZER_TIMEOUT_MS,
  synthesizerRetryMs: SYNTHESIZER_RETRY_TIMEOUT_MS,
  reservedHeadroomMs: RESERVED_HEADROOM_MS,
  orchestratorMs: ORCHESTRATOR_TIMEOUT_MS,
  retrievalPreflightMs: RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  synthRetryFinalizeReserveMs: SYNTH_RETRY_FINALIZE_RESERVE_MS,
  cfQueueConsumerCeilingMs: CF_QUEUE_CONSUMER_CEILING_MS,
  shadowFinalizeGraceMs: SHADOW_FINALIZE_GRACE_MS,
})
