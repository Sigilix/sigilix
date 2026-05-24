# `src/do/` — Durable-Object PR-review-run state (ARC-190)

Durable Object that owns dedupe + retry state for `pr-review` jobs. Replaces
the legacy 7-day KV `pr-review:<owner>/<repo>#<pr>@<sha>` dedupe key for
automatic webhook reviews.

## Spec / plan

- Spec: `docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-arc-190-durable-objects-webhook-ingest.md`
- Linear: [ARC-190](https://linear.app/arc-and-anchor/issue/ARC-190)

## Files

| File | Role |
|---|---|
| `types.ts` | `RunState`, `RunRecord`, route payloads, `ResolvedDoConfig`. Pure types, zero runtime. |
| `config.ts` | `resolveDoConfig(env)` — env → clamped retry/watchdog/history numerics. Pure. |
| `pr-review-run.ts` | `PrReviewRunDO` class + pure decision helpers. Owns `/enqueue`, `/pickup`, `/run-result`, `/status` routes + `alarm()` (retry + watchdog). |
| `classify-error.ts` | `classifyEnsembleError` / `classifyEnsembleStage` — pure. Shared by the consumer wrapper to map thrown ensemble errors onto `transient \| terminal`. |
| `status-route.ts` | `handleReviewStatusRoute` — public unauth GET `/reviews/<owner>/<repo>/<prNumber>` → DO `/status`. Returns 404 when no state exists. |
| `consumer-wrapper.ts` | `runPrReviewWithDoCallback` — queue-consumer wrapper that posts `/pickup` → runs the ensemble → posts `/run-result`. Bypasses cleanly when the message lacks a string `runId`. |
| `webhook-enqueue.ts` | `enqueuePrReviewJob` — webhook-side DO `/enqueue` call. Awaited (NOT `ctx.waitUntil`) so DO failures bubble up as 503 to GitHub. |

## Retry + watchdog ownership

The DO is the retry source-of-truth. The queue consumer wrapper does NOT
re-throw ensemble errors; it tells the DO via `/run-result` and acks the
queue. The DO schedules a retry alarm for transient verdicts (30s / 90s /
270s backoff, attempts 1 / 2 / 3) and a watchdog alarm whenever a run is
queued or running so missing `/run-result` posts do not silently strand a
run.

Pickup-5xx / pickup-transport failures are the only paths where the
wrapper throws — that lets Cloudflare Queue redeliver the message back
to a fresh `/pickup` attempt without involving the DO retry pipeline.

## Env vars

| Name | Default | Range | Purpose |
|---|---|---|---|
| `OPENCLAW_PR_REVIEW_DO_MAX_RETRIES` | `3` | `[1, 10]` | Retry-alarm cap before terminal `failed`. |
| `OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS` | `1200000` (20 min) | `[60000, 1800000]` | Watchdog horizon per attempt. |
| `OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT` | `10` | `[1, 100]` | FIFO cap on per-PR `RunRecord` history. |

## Telemetry

DO-side events follow spec §5 (`do-review-*` namespace). The webhook
enqueue + consumer wrapper add a few wrapper-side events for failures
they observe locally that the DO can't see:

| Event | Emitted from | When |
|---|---|---|
| `do-review-enqueue-failed` | `webhook-enqueue.ts` | `await stub.fetch("/enqueue")` threw (transport-level). We return 503 to GitHub. |
| `do-review-enqueue-non-ok` | `webhook-enqueue.ts` | DO `/enqueue` returned non-2xx. We return 503 to GitHub. |
| `do-review-consumer-pickup-unexpected-status` | `consumer-wrapper.ts` | `/pickup` returned a 4xx that wasn't `409`/`410` (deploy mismatch / schema bug). Wrapper acks; DO watchdog catches the missing `/run-result`. |
| `do-review-consumer-run-result-non-ok` | `consumer-wrapper.ts` | `/run-result` returned non-2xx. Wrapper swallows; DO watchdog is the safety net. |
| `do-review-consumer-run-result-failed` | `consumer-wrapper.ts` | `/run-result` POST threw (transport-level). Same safety-net story. |

`/pickup` 409/410 paths emit `do-review-pickup-skipped` from inside the
DO itself (`pr-review-run.ts`), so the wrapper does not double-emit.

Every event carries `dedupe_system: "do"`. The 6 KV-routed sibling
JobMessage variants (`pr-overview`, `pr-improve`, `pr-describe`,
`pr-stale-mark`, `ci-triage`, `github-mention`) carry
`dedupe_system: "kv"` on their dedupe-skip emission sites so dashboards
can split DO-routed work from KV-routed work after rollout.

## Tests

Each route + helper has a colocated test in `tests/do-*.test.ts`. The
DO storage / state / alarm runtime is faked in-process; tests never hit
real Cloudflare bindings.

The case `"pr-review"`-only scoping of `runPrReviewWithDoCallback` is
guarded by a dedicated regression test
(`tests/dispatch-job-ci-triage-scoping.test.ts`) — Codex BLOCKING B2 on
plan v1.
