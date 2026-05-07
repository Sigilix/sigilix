# ARC-190 — DO webhook-ingest split — implementation plan v2 (final)

**Status:** v2 — **APPROVED**. Codex v2 returned APPROVE-WITH-CHANGES with 3 MINOR textual cleanups (metadata-label drift, Task 10 commit-independence callout, `import type { Env }`); all folded into this final revision. Kimi K2.6 dispatch dropped per the 2026-05-07 sign-off-policy refinement (Sigilix backend = Codex-only). Task 10 (slash-command 👀 ack) bundled into the same PR per founder request.
**Spec:** `docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md` (v4 APPROVED)
**Branch:** `arc-190-do-webhook-ingest`
**Linear:** [ARC-190](https://linear.app/arc-and-anchor/issue/ARC-190/split-webhook-ingest-from-review-execution-via-durable-objects)

---

## 0. Sequencing principle

Strictly TDD per task. Each task: tests-first → impl → tsc clean → CodeRabbit local pass → commit. Per-task README updates per the readmes-per-directory rule. Most tasks are one commit; integration tasks (Task 7, 8) may split into impl + CR-fix-pass.

## 1. Repo verification facts (informing this plan)

Verified against `arc-190-do-webhook-ingest` head (currently at `fd6a8e8`) before authoring v1:

- **No DO bindings exist today** in `wrangler.toml` (lines 1-96). Adding `[[durable_objects.bindings]]` + `[[migrations]]` is brand-new wrangler config.
- **`OPENCLAW_JOBS` queue is shared** across 11 JobMessage variants (`linear-triage`, `linear-mention`, `pr-overview`, `pr-review`, `pr-review-rerun`, `pr-improve`, `pr-help`, `pr-describe`, `pr-stale-mark`, `ci-triage`, `github-mention`). v1 gates DO ownership to `pr-review` ONLY; the queue config is unchanged.
- **`handleGitHubWebhook` lives at `src/index.ts:971`**; the `pull_request` branch enqueues `pr-review` JobMessages around lines 1042-1130.
- **Queue consumer at `src/index.ts:557`** dispatches via `dispatchJob(job)` at line 609; the `pr-review` branch calls `handlePrReviewEnsemble`.
- **Existing dedupe** for `pr-review` lives in `src/lib/triage-pr-review.ts:45-61` via the KV key `pr-review:<owner>/<repo>/<pr>/<sha>` (7-day TTL). v1 keeps this for backward-compat during rollout; the DO is the new source of truth and will eventually deprecate the KV key after the rollout window.
- **No existing `src/do/` directory.** v1 creates it.
- **No existing class extending `DurableObject`** — class-name + import surface is greenfield.

## 2. Dependency graph

```
                              Task 1 (types + Env wiring)
                                       │
        ┌──────────────────────────────┼──────────────────┐
        ▼                              ▼                  ▼
    Task 2                          Task 3              Task 4
   (DO class                       (consumer            (status route
    skeleton +                      classifier         GET /reviews/...)
    pure helpers)                   transient/term)
        │                              │                  │
        ▼                              │                  │
    Task 5                             │                  │
   (DO routes:                         │                  │
    /enqueue, /pickup,                 │                  │
    /run-result, /status)              │                  │
        │                              │                  │
        ▼                              ▼                  │
    Task 6 (DO alarm + watchdog logic) │                  │
        │                              │                  │
        ├──────────────────────────────┘                  │
        ▼                                                 │
    Task 7 (consumer wrapper integration)                 │
        │                                                 │
        ▼                                                 │
    Task 8 (webhook handler integration + KV-routed       │
            telemetry tagging across the 6 sibling jobs)  │
        │                                                 │
        ├─────────────────────────────────────────────────┘
        ▼
    Task 9 (acceptance test + dogfood + final docs)
```

## 3. Task list (10 tasks: 9 DO core + 1 bundled slash-ack)

### Task 1 — Types + Env + wrangler binding (NEW + EDIT)

**Outputs:**
- `src/do/types.ts` (NEW): `RunState`, `RunRecord`, `EnqueueRequest`, `PickupRequest`, `PickupResponse`, `RunResultRequest`, `StatusResponse`, `PrReviewMode = "off" | "shadow" | "post"`.
- `src/index.ts` `JobMessage` `pr-review` variant extended with **optional `runId?: string`** (Codex BLOCKING B1 on plan v1). DO-posted `pr-review` queue messages MUST carry the runId; legacy direct-path `pr-review` messages MAY omit it (presence-checked at consumer wrapper time per Task 7). The `ci-triage` variant's existing `runId: number` is unrelated and untouched.
- `src/index.ts` `Env` interface extended with: `PR_REVIEW_RUN: DurableObjectNamespace`, `OPENCLAW_PR_REVIEW_MODE?: string`, `OPENCLAW_PR_REVIEW_DO_MAX_RETRIES?: string`, `OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS?: string`, `OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT?: string`.
- `wrangler.toml`: new `[[durable_objects.bindings]]` block (`name = "PR_REVIEW_RUN"`, `class_name = "PrReviewRunDO"`) + new `[[migrations]]` block (`tag = "arc-190-v1"`, `new_classes = ["PrReviewRunDO"]`). Migration is forward-compatible (adding a class). Added env-vars also documented in the wrangler comment block.
- **NEW: `src/do/config.ts`** with `resolveDoConfig(env: Env) → ResolvedDoConfig` (Codex BLOCKING B4 on plan v1 — env validation under-spec'd). Imports `Env` via **`import type { Env } from "../index"`** to avoid runtime cycles through `src/index.ts` (Codex MINOR on plan v2 — pure types-only import sidesteps the entry-module load order issue). Pure function; clamps numeric envs (`maxRetries ∈ [1, 10]` default 3; `watchdogMs ∈ [60000, 1800000]` default 1200000; `historyLimit ∈ [1, 100]` default 10); validates mode is `"off" | "shadow" | "post"` (default `"off"` on unknown). Locked defaults match spec §4.9.
- `src/index.ts` exports `PrReviewRunDO` from `./do/pr-review-run` (Cloudflare Workers requires the DO class to be exported by the entry module to register the binding).

**Tests** (~10 cases, `tests/do-config.test.ts`): defaults when env unset, mode literals accepted, mode garbage → `"off"`, numeric clamp boundaries (low/high/zero/negative/non-numeric) for each of the three numeric fields. Plus a small JobMessage-shape compile-time check that `runId` is optional only on `pr-review`, not on other variants. Validate via `npx tsc --noEmit` and `npx wrangler types` (regenerates `worker-configuration.d.ts` from wrangler.toml).

**Commit 1.**

### Task 2 — DO class skeleton + pure helpers (NEW)

**Depends on:** Task 1.

**Outputs:**
- `src/do/pr-review-run.ts` (NEW): `class PrReviewRunDO extends DurableObject` with stub `fetch(req)` that 404s on every route, plus pure helpers:
  - `isSupersededByNewSha(state: RunState, incomingHeadSha: string): boolean`
  - `decideEnqueueAction(state: RunState | null, incoming: EnqueueRequest): { action: "create" | "supersede" | "dedupe-active" | "dedupe-terminal"; reason: string }` — pure decision tree captured from spec §4.5
  - `decidePickupAction(state: RunState | null, runId: string, consumerId: string): { action: "claim" | "supersede-410" | "duplicate-409" | "terminal-410" | "stale-runId-410" }` — pure
  - `nextBackoffMs(attempts: number): number` — `attempts === 1 ? 30000 : attempts === 2 ? 90000 : 270000`
  - `decideRunResultAction(state: RunState, payload: RunResultRequest, maxRetries: number): { transition: "done" | "failed" | "failed-transient" | "history" | "stale-consumer"; nextAlarmAt?: number }` — pure
  - `pruneHistoryRecords(records: Record<string, RunRecord>, limit: number): { kept: Record<string, RunRecord>; evicted: number }`

**Tests** (≈ 20 cases, `tests/do-pr-review-run-helpers.test.ts`):
- `isSupersededByNewSha`: same SHA → false; different SHA → true; null state → caller-handles
- `decideEnqueueAction`: 4 branches (create / supersede / dedupe-active / dedupe-terminal)
- `decidePickupAction`: 5 branches (claim / supersede-410 / duplicate-409 / terminal-410 / stale-runId)
- `nextBackoffMs`: 30s, 90s, 270s, plus clamp behavior at attempts > 3 (returns 270s; max-retries gate is checked elsewhere)
- `decideRunResultAction`: 5 branches (success → done; transient w/ retries-left → failed-transient + alarm; transient w/ retries-exhausted → failed; terminal → failed; superseded-consumer → history)
- `pruneHistoryRecords`: empty → empty; under cap → unchanged; at cap → unchanged; over cap → evict oldest by ts

**Commit 2.**

### Task 3 — Consumer-side classifier (NEW)

**Depends on:** Task 1.

**Outputs:**
- `src/do/classify-error.ts` (NEW): `classifyEnsembleError(err: unknown): "transient" | "terminal"` + `classifyEnsembleStage(err: unknown): string`. Pure functions.
  - **Transient triggers:** HTTP 5xx from GitHub (status 500-599), `failureReason ∈ {"timeout", "aborted", "fallback_failed:..."}`, `internal_error` with non-422 status, network errors (TypeError "fetch failed"), abort-signal-derived errors.
  - **Terminal triggers:** HTTP 422 with `submitReview` invalid-anchor message, `missing_api_key`, `outside-config-allowed-paths`, hallucination-only verdicts (every finding dropped by hallucination guard), `submit_fallback_failed` (fallback ALSO 422'd — not retryable).
  - **Default fallback:** unrecognized errors → `transient` with `unclassified-default-transient` telemetry. Pessimistic default; we'd rather burn one extra retry than terminal-fail a fixable thing.

**Tests** (≈ 12 cases, `tests/do-classify-error.test.ts`):
- 6 transient triggers (one per branch listed above)
- 5 terminal triggers (one per branch)
- Default-fallback case: a totally novel error → "transient" with telemetry hook callable

**Commit 3.**

### Task 4 — Status route handler (NEW + EDIT)

**Depends on:** Task 1 (Env binding).

**Outputs:**
- `src/do/status-route.ts` (NEW): `handleReviewStatusRoute(env: Env, owner: string, repo: string, prNumber: number): Promise<Response>`. Decodes path segments, validates non-empty + no-slash, fetches DO stub `/status`, returns 404 if DO returned `{ kind: "no-state" }`, else 200 JSON.
- `src/index.ts` `fetch()` adds the new route handler before the catch-all, gated on `mode !== "off"` (no need to expose the route when feature is fully off).

**Tests** (≈ 14 cases, `tests/do-status-route.test.ts`):
- 200 with valid JSON shape (current.runId, history[])
- 404 when DO returns no-state
- 400 on empty owner/repo/prNumber segments
- 400 on segment containing `/` (path traversal attempt)
- 400 on non-numeric prNumber
- 503 on DO transport failure
- Path-segment URL-decode (e.g., `%2E` → `.`)
- Routes only when `mode !== "off"` (returns 404 with feature-disabled body otherwise)
- Test fixtures cover idle/queued/running/done/failed/failed-transient state shapes

**Commit 4.**

### Task 5 — DO route handlers (EDIT — fills in Task 2's stub)

**Depends on:** Tasks 1, 2.

Per Codex MAJOR on plan v1 — keep as one task, but enforce land order: `/enqueue` and `/pickup` go green (and tested) before `/run-result` and `/status` are added in the same commit. If the green-state slips during implementation, split into Task 5a (enqueue + pickup) and Task 5b (result + status) at that point.

**Every state mutation updates `state.lastActivityAt = new Date().toISOString()` BEFORE the storage put** (Codex MINOR on plan v1) — the spec §4.10 v2 GC sweep relies on this field; v1 only writes it, doesn't read it.

**Outputs:**
- `PrReviewRunDO.fetch(req)` dispatches on path:
  - `POST /enqueue` → reads body, calls `decideEnqueueAction`, on `create`: writes RunState (with fresh `lastActivityAt`), sends queue message via `env.OPENCLAW_JOBS.send({type: "pr-review", ..., runId})` (skipped in `mode === "shadow"`), schedules watchdog alarm via `setAlarm` (skipped in shadow), emits telemetry. Returns `{ deduped: bool, runId, action }`.
  - `POST /pickup` → reads body, calls `decidePickupAction`, on `claim`: updates state to `running` (with fresh `lastActivityAt`), sets `pickedUpAt`, persists `consumerId`, emits `do-review-picked-up`. Returns 200 / 409 / 410 / 410 stale per spec §4.3.
  - `POST /run-result` → reads body, calls `decideRunResultAction`, applies transition (with fresh `lastActivityAt`), schedules retry alarm if needed (sets `alarmKind = "retry"`, persists `alarmTargetRunId`), emits telemetry. `consumerId` mismatch → write to history + `do-review-result-superseded`.
  - `GET /status` → returns current state JSON or `{ kind: "no-state" }` when storage is empty.
  - All other paths → 404.

**Tests** (≈ 26 cases, `tests/do-pr-review-run-routes.test.ts`, `state.storage` mocked):
- `/enqueue`: first run, dedupe-same-sha-active, dedupe-terminal-same-sha, supersede-different-sha
- `/enqueue` shadow mode skips queue dispatch + skips watchdog alarm
- `/pickup`: 200 claim; 409 same-runId different-consumerId; 410 superseded; 410 terminal; 410 stale-runId
- `/run-result`: success → done; transient w/ retries-left → failed-transient + alarm scheduled; transient retries-exhausted → failed; terminal → failed; superseded consumer → history; 410 unknown runId
- `/status`: returns state shape; 404-equivalent when no state
- DO storage interaction: every route reads + writes `state` atomically (DOs serialize per instance, but tests verify the read-modify-write pattern)
- Telemetry events fired with `dedupe_system: "do"` annotation

**Commit 5.**

### Task 6 — Alarm handler (EDIT)

**Depends on:** Tasks 2, 5.

**Outputs:**
- `PrReviewRunDO.alarm()` reads `alarmTargetRunId` + `alarmKind`, dispatches to `handleRetryAlarm` or `handleWatchdogAlarm`. Stale-runId no-ops emit `do-review-alarm-stale`.
- `handleRetryAlarm`: re-sends queue message with same runId + `attempts++`. Sets new watchdog alarm.
- `handleWatchdogAlarm`: if state still `queued | running` (consumer didn't post `/run-result` in time): treat as transient. If `attempts < MAX_RETRIES`, schedule retry alarm + emit `do-review-watchdog-fired { willRetry: true }`. Else state = `failed` + emit `do-review-watchdog-terminal`.

**Tests** (≈ 12 cases, extension of Task 5's test file):
- Retry alarm: re-enqueues, increments attempts, schedules new watchdog
- Retry alarm with stale runId: no-op + telemetry
- Watchdog alarm: queued + retries-left → schedule retry; emit fired
- Watchdog alarm: queued + retries-exhausted → terminal; emit watchdog-terminal
- Watchdog alarm: state already done → no-op
- Watchdog alarm: state already failed → no-op
- Single-attempts-increment-point: scheduling does NOT increment; alarm fire DOES

**Commit 6.**

### Task 7 — Consumer wrapper integration (EDIT)

**Depends on:** Tasks 3, 5.

**Outputs:**
- `src/index.ts` queue consumer's `case "pr-review"` branch wraps existing call in `runPrReviewWithDoCallback` (new helper in `src/do/consumer-wrapper.ts`). The wrapper is invoked ONLY inside `case "pr-review"` — `ci-triage`'s existing `runId: number` field is untouched (Codex BLOCKING B2 on plan v1; the original "if (message.runId)" guard would have falsely matched ci-triage messages). The helper:
  1. Guards on `job.type === "pr-review" && typeof job.runId === "string"` — string-typed runId is the DO-routed signal; absent / non-string runId is the legacy direct-path passthrough.
  2. Posts `/pickup`; on 409/410 → ack message, exit cleanly.
  3. Runs `handlePrReviewEnsemble`.
  4. In `finally`: classifies error via `classifyEnsembleError`, posts `/run-result` with `consumerId`. Catches post failures so the watchdog alarm is the safety net.

**Tests** (≈ 16 cases, `tests/do-consumer-wrapper.test.ts`):
- Happy path: pickup 200 → run → success → /run-result success
- Pickup 409: ack + exit (no work done)
- Pickup 410-superseded: same
- Pickup 410-terminal: same
- Transient throw → /run-result transient
- Terminal throw → /run-result terminal
- Pickup 5xx → throw → queue redelivers
- /run-result post failure → swallow + log + queue ack (watchdog will catch)
- `message.runId` absent → bypass DO, run legacy path
- **Regression test (Codex B2 on plan v1):** `ci-triage` job with its existing numeric `runId: number` flows through `dispatchJob`'s `case "ci-triage"` branch unchanged — the `runPrReviewWithDoCallback` wrapper is NOT invoked, no DO calls fire, `handleCiTriage` runs normally. Asserts the `case "pr-review"`-only wrapping is correctly scoped.

**Commit 7.**

### Task 8 — Webhook handler integration + KV-side telemetry tagging (EDIT)

**Depends on:** Tasks 1, 5, 7.

**Outputs:**
- `src/index.ts` `handleGitHubWebhook` `pull_request` branch (lines ~1042-1130) gates on `OPENCLAW_PR_REVIEW_MODE`:
  - `off` → existing direct `OPENCLAW_JOBS.send({type: "pr-review", ...})` only. No DO calls.
  - `shadow` → BOTH paths fire: DO `/enqueue` (writes state, observation-only) AND existing direct `OPENCLAW_JOBS.send`. The DO does NOT enqueue its own queue message in shadow (spec §4.4); the existing path is the work executor. Two pr-review messages would otherwise produce duplicate ensemble runs.
  - `post` → DO `/enqueue` only. **The webhook handler does NOT call `OPENCLAW_JOBS.send` directly** (Codex MAJOR on plan v1 — explicit so reviewers can verify against the diff). The DO's `/enqueue` route owns the queue message with the DO-generated `runId` attached; consumer's `/pickup` reads it from `message.runId`. On DO `/enqueue` failure → return 503 to GitHub for redelivery (spec §4.4 awaited semantics, NOT `ctx.waitUntil`).
- DO enqueue is `await stub.fetch(...)`-ed — NEVER `ctx.waitUntil` (per spec §4.4 + §7.1).
- Sibling JobMessage variants (`pr-overview`, `pr-improve`, `pr-describe`, `pr-stale-mark`, `ci-triage`, `github-mention`) get `dedupe_system: "kv"` added at their existing telemetry emission sites. ~6 single-line tag additions.

**Tests** (≈ 14 cases, extension of `tests/index-webhook.test.ts` or new file):
- mode=off: existing path only; no DO call
- mode=shadow: DO call + existing path; DO failure → continue + log
- mode=post: DO call only; DO success → 202; DO transport failure → 503; DO 4xx → 503
- mode=post: response timing ≤ 500ms (DO + return)
- KV-routed events emit `dedupe_system: "kv"` (smoke test on the 6 siblings)
- mode=post: synchronize webhook deliverable replayed 3 times → exactly 1 work execution (the integration scenario from spec §2)
- mode=post: webhook handler does NOT call `env.OPENCLAW_JOBS.send` directly with a `pr-review` message; assert via mock-call-count that DO `/enqueue` is the only path that enqueues. The DO emits the queue message internally with `runId` populated; assert that the queue payload (intercepted via DO's queue stub) carries a non-empty string `runId`.

**Commit 8 (impl). Likely commit 8b for CR fix-pass.**

### Task 9 — Acceptance test + dogfood + final docs (NEW + EDIT)

**Depends on:** Tasks 1, 4, 5, 6, 7, 8 (Codex BLOCKING B3 on plan v1 — Task 4 was missing; the acceptance scenarios assert against the status route).

**Outputs:**
- `tests/do-pr-review-acceptance.test.ts` (NEW):
  - 3-replay scenario: `synchronize` webhook with same delivery-id + headSha replayed 3 times → DO records exactly 1 `running` run + 2 `do-review-deduped` events. After completion, status route returns `{ state: "done", attempts: 1 }`.
  - Transient-failure-then-recovery scenario: first call fails (5xx), DO schedules retry alarm, alarm fires, second call succeeds, status returns `{ state: "done", attempts: 2 }`.
  - Watchdog scenario: `/run-result` never arrives, watchdog fires after `WATCHDOG_MS`, schedules retry, eventually exhausts attempts → `{ state: "failed", lastError.stage: "watchdog" }`.
- `sigilix.json` (or similar repo config) gets a noop / dogfood entry. Most config lives in env vars for this feature, so the JSON change may be empty.
- `README.md`:
  - New `## DO-backed pr-review run state (ARC-190)` section after the existing `## Cross-PR review memory (ARC-189)` section. ~50 lines: how it works, status route shape, env vars, mode semantics, rollout phases, telemetry, v1 limitations.
  - `### `OPENCLAW_PR_REVIEW_MODE`` config block reference earlier in the README near the other env vars.

**Commit 9.**

### Task 10 — Slash-command eye-emoji ack (NEW + EDIT) **[bundled into same PR per user request]**

**Scope:** small UX fix unrelated to the DO architecture but bundled into the ARC-190 PR. Slash commands (`/sigilix help`, `/sigilix review`, etc.) currently produce no immediate visual feedback — the bot's reply only lands after the queue + LLM/render time. The `@-mention` path posts a 👀 eye reaction within ~1s of receipt (`src/lib/github-mention.ts:135`) so the asker sees instant ack. Slash commands should mirror this.

**Depends on:** none (independent of Tasks 1–9).

**Outputs:**
- `src/index.ts` `queueGithubMention`: after a slash command passes ACL + coalesce, but before / after the queue enqueue, dispatch a 👀 reaction on the source comment via `ctx.waitUntil(postSlashCommandEyesAck(env, owner, repo, commentId, surface, installationId))`. Best-effort — `.catch()`-swallowed, never blocks the webhook response.
- New helper `postSlashCommandEyesAck` (inline or in a tiny new file): mints an installation token, builds a `GitHubClient`, calls `addReactionToIssueComment` (surface=issue) or `addReactionToReviewComment` (surface=review-comment) with reaction kind `"eyes"`.
- Pass `ctx: ExecutionContext` down through `queueGithubMention` so the helper runs via `ctx.waitUntil` (matches the ARC-189 capture-pipeline pattern at `src/index.ts:1163`).

**Tests** (≈ 6 cases, extension of `tests/index-webhook.test.ts` or new `tests/slash-command-eyes-ack.test.ts`):
- Eyes-react fires when slash command parses + ACL passes
- Eyes-react does NOT fire when ACL rejects (the rejection log fires instead)
- Eyes-react does NOT fire when coalesce hits (the coalesce log fires instead)
- Eyes-react does NOT fire on `@-mention` path (already handled by the consumer)
- React API failure is swallowed (.catch logs, webhook response unaffected)
- Surface routing: issue surface uses `addReactionToIssueComment`, review-comment surface uses `addReactionToReviewComment`

**Commit 10.**

## 4. Cross-cutting concerns

### 4.1 Rollout sequence (deploy-time, not a code task)

Per spec §6 / migration plan:

1. **Deploy with `OPENCLAW_PR_REVIEW_MODE="off"`** (default). DO class is registered (wrangler migration applies) but never invoked.
2. **Flip Sigilix repo only to `shadow`** for 1 week. Monitor `do-review-enqueued-shadow` rate matches webhook event count + status-route sampling against live PRs.
3. **Flip to `post`.** Existing KV `pr-review:` dedupe keys remain operational for the duration of any in-flight non-DO runs (7-day TTL); new runs use the DO.
4. **After 30 days of stable `post`,** remove the legacy KV `pr-review:` dedupe write site (deferred follow-up; not in this PR).
5. **Rollback:** flip env back to `off` or `shadow`. The DO continues to receive shadow traffic if `shadow`; existing direct path always works regardless.

### 4.2 Test infrastructure

DO stub contract (Codex MAJOR on plan v1 — promoted from Task 9 acceptance to cross-cutting because it's used across Tasks 5, 6, 7, 9). Each test file authors a local `makeDoStub()` matching the existing convention. The stub MUST simulate:

- `env.PR_REVIEW_RUN.idFromName(name: string) → DurableObjectId` — deterministic mock returning `{ name }` shape that the stub `get` reads.
- `env.PR_REVIEW_RUN.get(id) → DurableObjectStub` — returns an object with `.fetch(url, init)` matching the production `fetch` route handlers via direct in-process call (no real HTTP).
- The DO instance state: `Map<string, unknown>` keyed by storage-key string.
- `state.storage.get / put / delete / list / transaction` — synchronous Map operations.
- `state.storage.setAlarm(timestamp: number)` + `state.storage.getAlarm() → number | null` — single-slot alarm.
- `state.storage.deleteAlarm()` — clears alarm.
- An exposed `triggerAlarm()` test helper to manually fire the registered `alarm()` handler (since vitest fake timers don't replicate Cloudflare's alarm runtime).

Queue stub: fake `OPENCLAW_JOBS.send(message)` records to an array; tests assert call count + payload shape (especially the `runId` field).

GH client stub: existing `as unknown as GitHubClient` cast pattern. New methods (`getPullRequestReviewComment` from ARC-189 already shipped; no new methods this PR).

### 4.3 Backward compatibility

- `mode === "off"` is the default; an upgrading deploy with no env config behaves identically to today.
- Existing `pr-review:<sha>` KV keys keep their TTL — no migration code reads them; they expire naturally over 7 days during rollout.
- The DO migration `new_classes = ["PrReviewRunDO"]` is forward-only. A rollback to v1 of this PR (no DO) doesn't break — Cloudflare DOs are durable independent of code; if the binding is removed, traffic just routes via `mode=off` (which never dispatches to the DO).

### 4.4 Per-task README placement

- `src/do/README.md` (NEW): created in Task 1 with module overview; updated through Task 7.
- Top-level `README.md`: per-task touches in Task 8 (env-var reference) + Task 9 (overview + telemetry section).

## 4.5 Production-side notes (non-blocking)

Sigilix App `issue_comment.created` deliveries from human users are currently being silently dropped by GitHub for the Arc-and-Anchor org installation (separate ongoing issue with GitHub Support; not Sigilix code). This **does not affect ARC-190 implementation** because:

- Task 8 wires `pull_request.*` webhooks (which deliver fine — confirmed by current pr-overview / pr-review output landing on rubberfit PRs).
- Slash commands (`/sigilix help` etc.) ARE working as of 2026-05-07 23:03 PT — likely GitHub state propagated post-reinstall.
- The DO architecture would actually be useful for the polling-fallback workaround if the issue recurs (out of v1 scope; v2 candidate).

(Codex MAJOR on plan v1 explicitly flagged this is non-blocking.)

## 5. Risk gates

Per-task quality gates per `feedback_per_task_workflow`:

1. Tests authored first (file exists + initially red).
2. tsc clean (`npx tsc --noEmit`).
3. All tests pass.
4. CodeRabbit local pass: `coderabbit review --plain -t uncommitted` (CR rate-limit during ARC-189 means we may need to skip and rely on the bot review post-PR, same as before).
5. Per-task commit (no batching).
6. README updated in same commit.

## 6. Estimated commits

- Tasks 1, 2, 3, 4, 5, 6: 6 commits (one each).
- Task 7: 1–2 commits (impl + likely CR fix-pass).
- Task 8: 1–2 commits (the heaviest integration + likely CR fix-pass).
- Task 9: 1 commit.

**Total:** ~10–12 commits (9 DO core + 1 bundled Task 10 slash-ack). Branch `arc-190-do-webhook-ingest` already cut from current main (commit `fd6a8e8`).

**Task 10 commit independence** (Codex MINOR on plan v2): Task 10 has no shared types or runtime coupling with Tasks 1–9. It can land first or last in the PR's commit sequence. If a DO rollback ever becomes necessary, Task 10's commit stays on the branch independently — reverting Tasks 1–9 doesn't drag the slash-ack with them.

## 7. Out of scope (explicit deferrals to v2)

- Other 6 per-PR JobMessage variants migrated to DO (`pr-overview`, `pr-improve`, `pr-describe`, `pr-stale-mark`, `ci-triage`, `github-mention`) — v1 ships only `pr-review`.
- DO instance GC / cleanup sweep — `lastActivityAt` instrumented in v1 but the cron + `state.storage.deleteAll()` call is v2 (waiting on Cloudflare's stable `list()` API).
- `do-review-shadow-mismatch` cross-path verdict comparison — needs existing-path consumer to also report; v2.
- Web UI for status route — v1 returns JSON only.
- Per-installation auth on the status route — v1 unauth (read-only metadata).
- D1 / SQL backing — v1 is KV-backed DO storage.
- Multi-class transferred_classes migration — v1 is `new_classes`.

---

## Sign-off matrix

| Reviewer | v1 Decision | v2 Decision |
|---|---|---|
| Codex | APPROVE-WITH-CHANGES (4 BLOCKING + 4 MAJOR + 4 MINOR — all addressed in v2) | APPROVE-WITH-CHANGES (3 MINOR textual cleanups — all folded inline) |
| Kimi K2.6 | _DROPPED for Sigilix backend per 2026-05-07 policy refinement_ | n/a |

### v1 → v2 changelog

- **Codex BLOCKING B1**: Task 1 extends `pr-review` JobMessage variant with optional `runId?: string` (DO-routed messages MUST carry it; legacy direct-path MAY omit). `ci-triage`'s existing numeric `runId` is unrelated and untouched.
- **Codex BLOCKING B2**: Task 7 wrapper guard tightened to `job.type === "pr-review" && typeof job.runId === "string"` (was generic `message.runId` which would falsely match `ci-triage`'s numeric runId). Added regression test for ci-triage flowing through unchanged.
- **Codex BLOCKING B3**: Task 9 dependency list updated to include Task 4 (acceptance asserts the status route).
- **Codex BLOCKING B4**: Added `src/do/config.ts` `resolveDoConfig(env)` resolver to Task 1 with ~10 unit tests covering mode-string validation, numeric clamps for retry/watchdog/history fields, default-OFF behavior.
- **Codex MAJOR**: Task 8 explicitly states `post` mode webhook does NOT call `OPENCLAW_JOBS.send` directly — DO `/enqueue` owns that. Test asserts via mock-call-count.
- **Codex MAJOR**: §4.2 promoted from Task 9 to cross-cutting; documents the DO stub contract (`idFromName`, `get(stub).fetch`, storage Map, single-slot alarm, `triggerAlarm()` helper) explicitly before implementation.
- **Codex MAJOR**: Task 5 keep-as-one with implementation order constraint (`/enqueue` + `/pickup` green before `/run-result` + `/status`); split into 5a/5b only if the green-state slips.
- **Codex MAJOR**: §4.5 NEW section noting the unrelated GitHub `issue_comment.created` delivery issue as non-blocking.
- **Codex MINOR**: every state mutation in Tasks 5/6 updates `state.lastActivityAt` before storage put (v2 GC dependency).
- **Codex MINOR**: filename / test colocation / README placement decisions kept as-is.
- **NEW**: Task 10 added — slash-command 👀 eye-emoji ack (bundled into the same PR per founder request).

### v2 final cleanups (Codex MINOR x3 on plan v2)

- Plan title: "v1" → "v2 (final)"; task-list label: "9 tasks" → "10 tasks (9 DO core + 1 bundled slash-ack)"; commit estimate: "9–11" → "10–12".
- §6 (Estimated commits) now explicitly notes Task 10 has no shared types or runtime coupling with Tasks 1–9 — it can land first or last in the PR's commit sequence; reverting Tasks 1–9 doesn't drag the slash-ack with them.
- Task 1 outputs now specify `import type { Env } from "../index"` for `src/do/config.ts` to avoid runtime cycles through the entry module.
