# ARC-190 — Split webhook ingest from review execution via Durable Objects — design spec

**Status:** v4 — **APPROVED** by both signers. Kimi K2.6 returned a clean APPROVE on v4. Codex returned APPROVE-WITH-CHANGES with 1 MAJOR + 1 MINOR (textual consistency only — `consumerId` schema-field gap + 2 stray `shadow-mismatch` references in §6/§7); both folded inline in this final revision. No outstanding architecture items. Ready for plan v1.
**Linear:** [ARC-190](https://linear.app/arc-and-anchor/issue/ARC-190/split-webhook-ingest-from-review-execution-via-durable-objects)
**Branch:** `arc-190-do-webhook-ingest`
**Sibling shipped:** ARC-181 / 184 / 185 / 186 / 187 / 188 / 189 / 191 / 193 / 194

---

## 1. Problem

Sigilix today runs webhook validation, queue production, and queue consumption inside a single Worker. Idempotency is tracked via a flat KV namespace (`pr-review:<owner>/<repo>/<pr>/<sha>`, 7-day TTL) with no per-PR state machine. Three real consequences:

1. **Duplicate webhook deliveries on the same head SHA** rely entirely on the dedupe-key TTL. The 7-day window absorbs most retries but isn't a hard guarantee — a same-SHA delivery after expiry would re-trigger a full ensemble run (~$1+ per duplicate).
2. **No status-query surface.** A reviewer / engineer can't ask "what's the state of PR X's review run" — they have to read the GitHub UI for a posted comment OR scrape Cloudflare logs.
3. **Failed jobs drop silently after Cloudflare Queues' 3-retry exhaustion.** No record of terminal failure persists, so we can't surface "review failed permanently" to the PR or distinguish "we never saw it" from "we tried and gave up."

ARC-190 introduces a per-PR **Durable Object** that owns the run-state machine. The DO sits IN FRONT of the existing queue: it deduplicates on `(owner, repo, prNumber, headSha)`, persists `idle | queued | running | done | failed`, schedules bounded retries via `storage.setAlarm`, and exposes status via a new `GET /reviews/...` route. The queue handler stays the work-execution path (DO is too small for 60–180s review compute); the DO is the orchestration brain.

## 2. Acceptance criteria (v1, refined)

- [ ] Duplicate webhook deliveries (3 replays of the same delivery-id OR same `(owner, repo, pr, sha)`) produce ONE review run.
- [ ] `GET /reviews/<owner>/<repo>/<prNumber>` returns the latest run's `{state, runId, headSha, attempts, lastError, startedAt, finishedAt}`.
- [ ] Failed jobs retry with bounded attempts (default 3); the DO writes a terminal-failure record exposed via the status route.
- [ ] Existing direct path still works in dev — feature gates behind a new env (`OPENCLAW_PR_REVIEW_MODE: "off" | "shadow" | "post"`).
- [ ] Tests: enqueue (new run), dedupe (duplicate same SHA), retry (transient failure → schedule next), terminal (3 attempts exhausted), status-query (idle / running / done / failed shapes), watchdog (consumer crashes before /run-result → DO transitions to failed via alarm).
- [ ] **New consumer-side classifier** (Codex MAJOR #9 + Kimi MAJOR #10 on v1 spec): `classifyEnsembleError(err) → "transient" | "terminal"`. Pure function. v1 transient: HTTP 5xx, network/model timeouts, `failureReason ∈ {timeout, aborted, fallback_failed: ...}`. v1 terminal: 422 invalid-anchor, `missing_api_key`, `outside-config-allowed-paths`, hallucination-only verdicts (every finding dropped by hallucination guard). Tests: 1 case per branch + a default-fallback ("unclassified → transient" with telemetry).
- [ ] **Telemetry tag** (Codex MAJOR #11 + Kimi MAJOR #11 on v1): every dedupe-related event carries `dedupe_system: "kv" | "do"` so dashboards can split. KV-routed JobMessage variants (the other 6 per-PR types) keep emitting their existing telemetry with `dedupe_system: "kv"` added. The new DO-routed `pr-review` events carry `dedupe_system: "do"`.

**Done when:** an integration test replays the same `synchronize` webhook delivery 3 times against an env with `USE_DURABLE_OBJECT="post"`, and the DO records exactly one `running` run + emits `do-review-deduped` telemetry on the 2nd and 3rd. After the run completes the status route returns `{state: "done", attempts: 1, ...}`. A second test simulates a transient failure: the run goes `running → failed → queued (alarm-scheduled retry) → running → done`, with attempts incrementing to 2.

## 3. Non-goals (v1)

- **DO does NOT execute the review itself.** Cloudflare DOs cap at ~30s wall-clock per request and 128MB memory; ensemble reviews run 60–180s with multi-MB diffs. The DO orchestrates; the existing queue consumer + `handlePrReviewEnsemble` does the work.
- **v1 owns ONLY the `pr-review` JobMessage variant.** Other per-PR variants (`pr-overview`, `pr-improve`, `pr-describe`, `pr-stale-mark`, `ci-triage`, `github-mention`) keep the existing queue-only path. v2 candidates.
- **No multi-PR / cross-repo aggregation.** Each DO instance is scoped to `(owner, repo, prNumber)`.
- **No SQL or query API.** v1 status route is a simple per-PR JSON-returning endpoint. Cross-PR listing is a v2 concern.
- **No web UI.** v1 status route is JSON for ops/CLI. Dashboard candidate later.
- **No retry of permanently-broken inputs** (e.g., 422 from `submitReview` because the diff anchored an invalid line). Those are categorized as `terminal-validation-failure` on attempt 1 — no retry.

## 4. Architecture

### 4.1 Pipeline diagram

```
              GitHub webhook (pull_request.synchronize, etc.)
                                │
                                ▼
                    handleGitHubWebhook (src/index.ts)
                  verify HMAC, gate by action / draft
                                │
                                │  USE_DURABLE_OBJECT === "off" → existing path
                                │  USE_DURABLE_OBJECT === "shadow" → BOTH
                                │  USE_DURABLE_OBJECT === "post" → DO only
                                ▼
                ┌───────────────────────────────────────────┐
                │  PrReviewRunDO (NEW, src/do/pr-review-run.ts) │
                │  ID: ${owner}/${repo}#${prNumber}             │
                │                                                │
                │  1. read current state from storage           │
                │  2. dedupe: same headSha + state ∈           │
                │     {queued, running} → ack + emit deduped   │
                │  3. else: write state="queued", create runId │
                │  4. send JobMessage to OPENCLAW_JOBS queue   │
                │     (with runId attached)                    │
                │  5. return 202 Accepted to webhook caller    │
                └────────────────────┬───────────────────────┘
                                     │
                                     ▼
                          OPENCLAW_JOBS (existing queue)
                                     │
                                     ▼
                          queue consumer (src/index.ts)
                                     │
                          dispatchJob(job) → handlePrReviewEnsemble
                                     │
                          on success/failure → fetch DO with
                          /run-result POST { runId, status, error? }
                                     │
                                     ▼
                ┌───────────────────────────────────────────┐
                │  PrReviewRunDO.handleRunResult                 │
                │  on success: state="done"                     │
                │  on transient-fail + attempts < 3:            │
                │    state="failed-transient"                   │
                │    storage.setAlarm(now + backoff)            │
                │    on alarm: re-send to queue, attempts++     │
                │  on terminal-fail OR attempts >= 3:           │
                │    state="failed", persist lastError          │
                └───────────────────────────────────────────┘

              GET /reviews/<owner>/<repo>/<prNumber>
                                │
                                ▼
                    DO.fetch("/status") → JSON
```

### 4.2 New DO class: `PrReviewRunDO`

Location: `src/do/pr-review-run.ts`. Class extends `DurableObject` (cloudflare:workers); the runtime gives us `state.storage` for persistence + `state.id` for the per-instance ID.

**Storage keys** (all via `state.storage`):

| Key | Type | Purpose |
|---|---|---|
| `state` | `RunState` JSON | Current run state. Always present after first webhook. |
| `run:<runId>` | `RunRecord` JSON | Historical run record. Up to N retained per DO (default 10, env-tunable via `OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT`); oldest evicted on overflow per Codex MINOR + Kimi MINOR #14 on v1. |
| `current_run_id` | string | Pointer to the active runId in `state`. |

**State machine** (`RunState.state` field):

```
idle ─enqueue─→ queued ─consumer-pickup─→ running
                  ↑                          │
                  │ alarm-fired ─────────────┘ on transient fail
                  │
                  └─── failed-transient (attempts < 3)

running ─success─→ done
running ─terminal-fail─→ failed (attempts persisted; no more retries)
queued/running ─same-sha-dedupe─→ (ack only; state unchanged)
```

Idle / done / failed are terminal states for that run-id. A new push (different headSha) creates a NEW run-id; the previous one moves into the `run:<runId>` history.

**`RunState` shape:**

```ts
interface RunState {
  schemaVersion: 1
  owner: string
  repo: string
  prNumber: number
  runId: string                            // crypto.randomUUID() — UUIDv4
  headSha: string
  baseSha: string | null
  installationId: number                   // REQUIRED — persisted, copied into every queue message including alarm-driven retries
  state: "idle" | "queued" | "running" | "done" | "failed-transient" | "failed"
  attempts: number                         // 1-indexed; incremented at retry
  startedAt: string                        // ISO when first set to "queued"
  pickedUpAt?: string                      // ISO when consumer set to "running"
  finishedAt?: string                      // ISO on done | failed
  lastError?: { stage: string; message: string }
  nextRetryAt?: string                     // ISO when retry alarm scheduled
  alarmTargetRunId?: string                // The runId an active alarm was scheduled for (Codex MAJOR + Kimi BLOCKING on v1 — alarm() has no payload, must look up here)
  alarmKind?: "retry" | "watchdog"
  consumerId?: string                      // Set by /pickup; used by /run-result to detect superseded-consumer late posts (Codex MAJOR on v4 — was referenced in §4.3/§5 but missing from the schema)
  lastActivityAt: string                   // ISO of last state mutation (used by §4.10 GC)
}

interface RunRecord {                       // Frozen snapshot retained in history
  runId: string
  headSha: string
  finalState: "done" | "failed"
  attempts: number
  startedAt: string
  finishedAt: string
  lastError?: { stage: string; message: string }
}
```

`runId` derivation (Codex MINOR + Kimi MINOR #13 on v1): `crypto.randomUUID()` (UUIDv4, 128-bit, available in the Workers runtime). NOT ULID — UUIDv4 is what the platform gives us natively without dependencies.

`installationId` propagation (Codex MAJOR #9 + Kimi MAJOR #9 on v1): the DO MUST persist this field in `RunState` AND include it in every queue message it emits — both initial enqueue AND alarm-triggered retries. The consumer mints GitHub installation tokens from it; without correct propagation a retried message has no auth and 401s on the first GitHub call.

### 4.3 DO routing

The DO accepts four internal routes:

| Method + path | Caller | Purpose |
|---|---|---|
| `POST /enqueue` | webhook handler | Dedupe + create runId + send to queue |
| `POST /pickup` | queue consumer (first action) | Transition `queued → running`; 409 on duplicate |
| `POST /run-result` | queue consumer (in `finally`) | Mark run done / failed-transient / failed |
| `GET /status` | status endpoint | Return current state JSON |

These are NOT public — they're stub-routed via `env.PR_REVIEW_RUN.get(stub).fetch(internalUrl)`. The public surface is the new `/reviews/...` endpoint.

**Why a `/pickup` callback** (Kimi BLOCKING N1 + Codex MAJOR + Kimi MAJOR N4 on v2): we can't set `max_retries: 0` on the shared `OPENCLAW_JOBS` queue because 6 other JobMessage variants depend on its existing retry behavior. Instead, the consumer's first action on a DO-routed message is `POST /pickup { runId, consumerId }`. The DO atomically:

- If `state.runId !== runId` (superseded by a new push) → 410 Gone. Consumer acks the queue message and exits with no work done.
- If `state.runId === runId` AND `state.state === "queued"` → transition to `running`, set `pickedUpAt = now`, persist `consumerId`. Return 200. Consumer proceeds.
- If `state.runId === runId` AND `state.state === "running"` AND `state.consumerId !== incomingConsumerId` → 409 Conflict (queue redelivered the same logical message because the original consumer didn't ack in time). Consumer acks and exits.
- If `state.runId === runId` AND `state.state ∈ {done, failed}` → 410 Gone (already finalized via /run-result). Consumer acks and exits.

This makes queue retries cheap no-ops: the first consumer to call `/pickup` wins; subsequent retries 409/410 immediately and cost ~10ms instead of ~$1+ for a duplicate ensemble run.

`consumerId` is generated per consumer invocation: `crypto.randomUUID()` at the top of `runPrReviewWithDoCallback`. Cheap and disposable.

### 4.4 Webhook → DO dispatch

`handleGitHubWebhook` in `src/index.ts` already routes `pull_request.synchronize | opened | reopened | ready_for_review` to enqueue a `pr-review` JobMessage. The new gating logic:

```ts
const mode = env.OPENCLAW_PR_REVIEW_MODE  // "off" | "shadow" | "post"

if (mode === "post" || mode === "shadow") {
  const stub = getDOStub(env, owner, repo, prNumber)
  // ⚠️ AWAITED, not ctx.waitUntil: per Codex BLOCKING B2 + Kimi
  // BLOCKING #4 on v1, the DO enqueue must complete before we ack
  // the webhook. On DO throw we return 5xx so GitHub redelivers
  // (~5 retries with exponential backoff). Otherwise a transient
  // DO outage drops work silently. The DO body is small (~300 bytes)
  // and the call is in-region; latency budget ~30-50ms.
  let response: Response | null = null
  try {
    response = await stub.fetch("https://do.internal/enqueue", {
      method: "POST",
      body: JSON.stringify({
        owner, repo, prNumber, headSha, baseSha, installationId,
        deliveryId: request.headers.get("x-github-delivery"),
        mode,  // DO needs to know shadow vs post
      }),
    })
  } catch (err) {
    // In post mode: 503 → GitHub redelivers. In shadow: swallow +
    // log; the existing-path send below remains the source of truth
    // (Kimi M1 on v3 — the v3 catch returned 503 unconditionally,
    // which would have made transient DO outages reject GitHub
    // events even in shadow).
    console.warn(JSON.stringify({
      event: "do-review-enqueue-failed",
      owner, repo, prNumber, mode,
      err: err instanceof Error ? err.message : String(err),
    }))
    if (mode === "post") {
      return new Response("do enqueue failed\n", { status: 503 })
    }
  }
  if (response && !response.ok && mode === "post") {
    return new Response(`do enqueue ${response.status}\n`, { status: 503 })
  }
  // In shadow, DO failures are observational — don't reject GitHub.
}

if (mode === "off" || mode === "shadow") {
  await env.OPENCLAW_JOBS.send({ type: "pr-review", ... })
}
```

The DO does its own dedupe; it doesn't trust the webhook handler to have done it. Spec §4.5.

**Shadow-mode contract** (Codex BLOCKING B1 + Kimi BLOCKING #1 fix): in shadow, the DO RECORDS state but does NOT dispatch to the queue. The webhook handler's existing `OPENCLAW_JOBS.send(...)` call IS the work-execution path. The DO's `/enqueue` writes a state row, returns 200, and emits `do-review-enqueued-shadow` telemetry — that's it. No double-enqueue. Status route reflects DO state, which intentionally never leaves `queued` until v2 instruments the existing consumer to call `/run-result` from shadow mode (out of scope for v1; documented in §7).

### 4.5 Dedupe semantics

The DO is the single source of truth for "is this run a duplicate." On `POST /enqueue`:

1. Read current `RunState`. If absent → first run; create runId + transition to `queued` + send queue message + return `{ deduped: false, runId }`.
2. If present + `state.headSha === incoming.headSha` AND `state.state ∈ {queued, running}` → **dedupe**. Return `{ deduped: true, existingRunId: state.runId }` + emit `do-review-deduped`. Do NOT touch state.
3. If present + `state.headSha !== incoming.headSha` → new push superseded the old run. Move old to history (`run:<runId>`); create new runId for incoming SHA; transition to `queued`.
4. If present + same SHA + state ∈ `{done, failed}` → **stale push** (e.g., a retried webhook delivery for a SHA we already finished). Dedupe (no new run); return existing runId.

GitHub's `x-github-delivery` header is also captured into the runId record (not as a key) so cross-infrastructure retries are visible in telemetry without the DO having to dedupe on it.

**No CAS needed inside the DO.** Durable Objects serialize requests per instance; `state.storage.get/put` is naturally race-free within one DO. Across DO instances (different PRs) there's nothing to race against.

### 4.6 Retry orchestration

**Queue retries kept at default for shared OPENCLAW_JOBS** (Kimi BLOCKING N1 on v2 — corrects v2's `max_retries: 0` proposal). The queue is shared with 6 other JobMessage variants; we can't change its retry config without breaking them. Instead, queue retries become cheap no-ops via the `/pickup` callback (§4.3): a redelivered message hits 409/410 within ~10ms. The DO is still the sole authority for *logical* retries via the watchdog + retry alarm.

The queue consumer's existing exit paths get an explicit `/pickup` first + `/run-result` in `finally`:

```ts
// New consumer wrapper for DO-owned pr-review messages
async function runPrReviewWithDoCallback(message: PrReviewJobMessage, env: Env) {
  // Skip non-DO-routed messages (shadow mode existing-path messages
  // lack a runId — guard per Kimi MINOR N6 on v2).
  if (!message.runId) {
    return handlePrReviewEnsemble(...)  // legacy direct-path semantics
  }

  // Step 1: claim the run via /pickup. Atomic per-DO; cheap on retry.
  const consumerId = crypto.randomUUID()
  const pickupResp = await postPickup(env, message.owner, message.repo, message.prNumber, {
    runId: message.runId, consumerId,
  })
  if (pickupResp.status === 409 || pickupResp.status === 410) {
    // Another consumer is already on it (409), OR this run was
    // superseded / finalized (410). Ack the queue message; do not run.
    console.log(JSON.stringify({
      event: "do-review-pickup-skipped",
      owner: message.owner, repo: message.repo, prNumber: message.prNumber,
      runId: message.runId, status: pickupResp.status,
    }))
    return
  }
  if (!pickupResp.ok) {
    // Transport-level failure on /pickup. Throw → queue redelivers.
    throw new Error(`pickup failed: ${pickupResp.status}`)
  }

  // Step 2: run the work. /run-result is posted in finally so a
  // process crash still cleans up via the watchdog alarm (§4.6a).
  let status: "success" | "transient" | "terminal" = "transient"
  let error: { stage: string; message: string } | undefined
  try {
    await handlePrReviewEnsemble(...)
    status = "success"
  } catch (err) {
    if (classifyEnsembleError(err) === "terminal") {
      status = "terminal"
    } else {
      status = "transient"
    }
    error = { stage: classifyStage(err), message: String(err) }
  } finally {
    await postRunResult(env, message.owner, message.repo, message.prNumber, {
      runId: message.runId, consumerId, status, error,
    }).catch((postErr) => {
      console.warn("run-result-post-failed", postErr)
    })
  }
}
```

**`/run-result` route contract** (Codex MAJOR on v4 — completes Kimi M3 from v3): the route accepts `{ runId, consumerId, status, error? }`. The DO checks `payload.consumerId === state.consumerId`; on mismatch the result is treated as superseded (write to `run:<runId>` history, emit `do-review-result-superseded`, do NOT mutate current state). On match, the normal status-enum transition table applies.

After the consumer finishes, the DO `/run-result` route handles the verdict:

| Caller `status` | DO state transition |
|---|---|
| `"success"` | state = `done`, finishedAt = now, append to `run:<runId>` history |
| `"transient"` (attempts < max) | state = `failed-transient`, `setAlarm(now + backoff)`, persist `alarmTargetRunId = runId` |
| `"transient"` (attempts ≥ max) | state = `failed`, finishedAt = now, lastError persisted |
| `"terminal"` | state = `failed`, finishedAt = now, lastError persisted, no retry regardless of attempts |

**Stale-runId handling** (Codex MAJOR #4 + Kimi BLOCKING #2 on v1): a `/run-result` may arrive for a runId that's no longer the current run (a new push superseded it while the consumer was processing). In that case the DO writes the result to the historical `run:<runId>` record (creating one if needed) and emits `do-review-result-superseded` telemetry. It does NOT touch `current.state`.

**Alarm metadata persistence** (Codex MAJOR #4 + Kimi BLOCKING #2 on v1): `state.storage.setAlarm(ts)` carries no payload — the alarm handler has no idea which runId it was scheduled for. The DO persists `alarmTargetRunId: <runId>` AND `alarmKind: "retry" | "watchdog"` to storage when scheduling.

The `alarm()` handler dispatches on `alarmKind` (Kimi MINOR M4 on v3):

```ts
async alarm() {
  const state = await this.state.storage.get<RunState>("state")
  if (!state) return
  if (state.runId !== state.alarmTargetRunId) {
    // Stale — a newer push superseded. No-op + telemetry.
    emit("do-review-alarm-stale", { ... })
    return
  }
  if (state.alarmKind === "retry") return this.handleRetryAlarm(state)
  if (state.alarmKind === "watchdog") return this.handleWatchdogAlarm(state)
}
```

**Single attempts-increment point** (Codex MAJOR M2 on v3): `attempts` is incremented EXACTLY ONCE per logical retry, at the moment the retry alarm fires AND the DO sends a new queue message. NOT at scheduling time. This applies to both retry alarms (`/run-result transient`) and watchdog alarms (no `/run-result` arrived). The `failed-transient` state therefore reflects the OLD `attempts` count; only after the alarm fires and the requeue is committed does `attempts++`.

**Backoff:** 30s, 90s, 270s (3× ratio, default max 3 retries). Tunable via `OPENCLAW_PR_REVIEW_DO_MAX_RETRIES`.

**Transient vs terminal classification** is new code in the queue consumer (Codex MAJOR #9 + Kimi MAJOR #10 on v1 — explicit AC item below). v1 transient: HTTP 5xx from GitHub, network timeouts, model timeouts (model-call returns `failureReason: "timeout" | "aborted" | "fallback_failed: ..."`). v1 terminal: 422 invalid-anchor (the diff anchored an invalid line — retrying produces the same result), `missing_api_key`, `outside-config-allowed-paths`, hallucination-only verdicts (every finding dropped by the hallucination guard).

### 4.6a Watchdog alarm

The DO sets a **watchdog alarm** at `queued` time (and again on each `running` transition via `/pickup`) for `now + WATCHDOG_TIMEOUT_MS`. Default **1200s = 20 minutes** (Kimi MAJOR N3 on v2 — bumped from 600s because the orchestrator's 490s wall + queue backlog tolerance + safety margin needs more headroom: `ORCHESTRATOR_WALL_MS + 300s` ≈ 800s, plus generous slack).

**Watchdog skipped in shadow mode** (Codex MAJOR on v2): in shadow, the DO never gets a `/run-result` because the existing webhook→queue path is the executor and doesn't call back. Setting a watchdog would falsely transition `queued → failed` after 20 minutes for every shadow-mode review. The `/enqueue` handler skips `setAlarm` when `mode === "shadow"`.

On watchdog alarm fire:

- If `state.state ∈ {done, failed}` → no-op (consumer finalized in time).
- Else (still `queued` or `running`) → treat as **transient** failure (Kimi MAJOR N2 on v2 — consumer crash / OOM / hard timeout is recoverable, not terminal):
  - If `attempts < MAX_RETRIES` → state = `failed-transient`, schedule retry alarm at `now + backoff(attempts)`, `alarmKind = "retry"`. **`attempts` is NOT incremented here** — increment happens when the retry alarm actually re-enqueues the run (single-increment-point rule per Codex M2 on v3).
  - Else → state = `failed`, `lastError = { stage: "watchdog", message: "no /run-result within WATCHDOG_TIMEOUT_MS, attempts exhausted" }`. Emit `do-review-watchdog-terminal`.
- Either way, emit `do-review-watchdog-fired { attempts, willRetry: bool }`.

Watchdog alarms and retry alarms share the same `alarmTargetRunId` slot — Workers DO only supports one pending alarm per instance. Both kinds are distinguished by the `alarmKind` field in `RunState`.

### 4.7 Status-query route

New public route in `src/index.ts`:

```
GET /reviews/<owner>/<repo>/<prNumber>
```

Authentication: **none in v1.** The response carries no secrets — it's metadata about Sigilix's own state. (Future: GitHub-App-installation-token auth via header if the data shape grows.)

**URL parsing** (Codex MINOR + Kimi MINOR #15 on v1): GitHub owner / repo names allow `[A-Za-z0-9._-]`. Standard `decodeURIComponent` per path segment is sufficient. Reject if any segment is empty after decode, or contains `/` (which would suggest path-traversal in an encoded form). Return 400 in those cases.

Response shape:

```json
{
  "owner": "...",
  "repo": "...",
  "prNumber": 7,
  "current": {
    "runId": "01H...",
    "headSha": "abc123",
    "state": "running",
    "attempts": 1,
    "startedAt": "2026-...",
    "pickedUpAt": "2026-...",
    "lastError": null
  },
  "history": [
    { "runId": "...", "headSha": "...", "finalState": "done", ... }
  ]
}
```

When no DO instance exists for the (owner, repo, prNumber) — i.e., never enqueued — return `404` with `{ error: "no review state" }`. We do NOT lazily create empty DOs on read; that would burn DO storage on every drive-by curl.

The webhook-side dispatch creates the DO on first `enqueue`; the status route reads only.

### 4.8 wrangler.toml additions

```toml
[[durable_objects.bindings]]
name = "PR_REVIEW_RUN"
class_name = "PrReviewRunDO"

[[migrations]]
tag = "arc-190-v1"
new_classes = ["PrReviewRunDO"]
```

**Key-value DO storage** (Codex MAJOR #6 + Kimi MAJOR #6 on v1). v1 access pattern is pure point-lookup (`get`/`put` on `state`, `current_run_id`, `run:<runId>`). SQLite-backed DOs add per-request query-parse overhead with no v1 payoff (per-instance SQLite can't span instances anyway, so the v2 cross-PR query argument is moot). If v2 ever wants per-instance query power, a `transferred_classes` migration is straightforward.

### 4.9 Env vars

```
OPENCLAW_PR_REVIEW_MODE            # "off" | "shadow" | "post"  (default "off")
OPENCLAW_PR_REVIEW_DO_MAX_RETRIES  # numeric, default 3
OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS  # numeric, default 1200000 (20 min — matches §4.6a)
OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT # numeric, default 10
```

`shadow` mode lets us validate the DO state machine in production traffic without changing user-visible behavior — webhook goes through both paths; the existing direct path is the source of truth and the DO is observation-only (per §4.4).

Renamed from `OPENCLAW_PR_REVIEW_USE_DURABLE_OBJECT` (Codex MAJOR #7 + Kimi MAJOR #8 on v1) to match existing convention (`*_MODE` for tri-state knobs).

### 4.10 DO instance lifecycle + GC

Cloudflare DO instances persist storage indefinitely. With ~150k DOs/month at our forecasted volume, indefinite retention bloats storage cost over years. Codex MAJOR #7 + Kimi MAJOR #7 on v1 surface this. Mitigation:

- Every state mutation updates `lastActivityAt` (ISO timestamp).
- A scheduled cron (existing `[triggers]` in wrangler.toml — added if absent) sweeps DOs with `lastActivityAt > 30 days ago` AND `state.state ∈ {done, failed}` and deletes the instance via `state.storage.deleteAll()`. (DO instances are not deletable in v1 — but their storage can be cleared, which makes them indistinguishable from "never enqueued" on next access.)
- **The sweep is explicitly v2-only.** v1 ships ONLY the `lastActivityAt` instrumentation in `RunState`. The 30-day cron sweep that calls `state.storage.deleteAll()` requires `env.PR_REVIEW_RUN.list()` to enumerate instances — Cloudflare's DO listing API is in beta as of writing and is NOT a hard dependency we want to assume in v1. Once stable, the v2 follow-up adds the cron + sweep logic. No `do-review-gc-*` telemetry fires in v1; the runbook captures the deferral.

## 5. Telemetry

All DO-routed events carry `dedupe_system: "do"` to distinguish from KV-routed events on the other 6 JobMessage variants (Codex MAJOR + Kimi MAJOR #11 on v1; PARTIAL on v2 — fixed in v3 by adding the field to all examples).

```
{ "event": "do-review-enqueued",                  dedupe_system: "do", owner, repo, prNumber, runId, headSha, mode }
{ "event": "do-review-enqueued-shadow",           dedupe_system: "do", owner, repo, prNumber, runId, headSha }
{ "event": "do-review-deduped",                   dedupe_system: "do", owner, repo, prNumber, runId, incomingHeadSha, existingHeadSha }
{ "event": "do-review-superseded",                dedupe_system: "do", owner, repo, prNumber, oldRunId, newRunId, oldHeadSha, newHeadSha }
{ "event": "do-review-pickup-skipped",            dedupe_system: "do", owner, repo, prNumber, runId, status }
{ "event": "do-review-picked-up",                 dedupe_system: "do", owner, repo, prNumber, runId, consumerId, queueLatencyMs }
{ "event": "do-review-completed",                 dedupe_system: "do", owner, repo, prNumber, runId, durationMs, attempts }
{ "event": "do-review-retry-scheduled",           dedupe_system: "do", owner, repo, prNumber, runId, attempt, nextRetryAt, error }
{ "event": "do-review-terminal-failure",          dedupe_system: "do", owner, repo, prNumber, runId, attempts, error }
{ "event": "do-review-result-superseded",         dedupe_system: "do", owner, repo, prNumber, runId, currentRunId }
{ "event": "do-review-alarm-stale",               dedupe_system: "do", owner, repo, prNumber, alarmTargetRunId, currentRunId }
{ "event": "do-review-watchdog-fired",            dedupe_system: "do", owner, repo, prNumber, runId, attempts, willRetry }
{ "event": "do-review-watchdog-terminal",         dedupe_system: "do", owner, repo, prNumber, runId, attempts }
{ "event": "do-review-status-query",              dedupe_system: "do", owner, repo, prNumber, found: bool }
```

`do-review-gc-skipped` is intentionally NOT in v1 (Codex MINOR on v3 — §4.10 explicitly defers the GC sweep to v2; no GC events fire in v1).

`do-review-shadow-mismatch` is also deferred. Specifying its emitter cleanly (Kimi M5 on v3) requires the existing-path consumer to also report verdicts to the DO so the DO can compare verdict-vs-DO-state — that's out of scope for v1 (would re-introduce the shadow-mode-runId-guard pain we just fixed in v3 Kimi N6). v2 candidate. v1 ships without it.

KV-routed JobMessage variants (the other 6 per-PR types — `pr-overview`, `pr-improve`, `pr-describe`, `pr-stale-mark`, `ci-triage`, `github-mention`) keep emitting their existing telemetry with `dedupe_system: "kv"` added at the emission sites. That's a small follow-up edit batched into Task 1 of the impl plan.

**`/run-result` payload includes `consumerId`** (Kimi M3 on v3): late posts from a superseded consumer (after a watchdog retry already fired and a new consumer picked up the new run) could otherwise stomp the new run's state. The DO compares `payload.consumerId` against `state.consumerId`; on mismatch, write to `run:<runId>` history (treat as superseded) and emit `do-review-result-superseded` rather than touching current state.

## 6. Migration / rollback

1. Land code with `OPENCLAW_PR_REVIEW_MODE="off"` everywhere. The DO class is registered (wrangler migration applies) but never invoked.
2. Flip Sigilix repo only to `shadow` for 1 week. Monitor `do-review-enqueued-shadow` rate (should match webhook event count) + `do-review-pickup-skipped` (should be 0 in shadow since DO doesn't dispatch) + status-route sampling against the DO state. Cross-path verdict comparison (`do-review-shadow-mismatch`) is deferred to v2 since it requires the existing-path consumer to also report — out of v1 scope.
3. Flip to `post`. Existing KV `pr-review:` dedupe keys remain operational for the duration of any in-flight non-DO runs; new runs use the DO.
4. After 30 days of stable `post`, deprecate the KV `pr-review:` dedupe keys (no actively-used keys at that point — TTL is 7d).
5. Rollback: flip env back to `off`. The DO class continues to exist with no traffic; existing direct path resumes. No data migration needed.

## 7. Risks + open questions (for sign-off)

1. **DO cold-start latency.** First request to a DO instance for a never-seen PR pays ~10ms cold-start. Webhook handler awaits the DO `/enqueue` synchronously (per §4.4 — replacing v1's `ctx.waitUntil` since that pattern lost work on DO failure). Total latency budget: ~30-50ms (DO cold-start + KV read inside the DO + KV write). Acceptable: GitHub's webhook timeout is 30s; we're three orders of magnitude inside it. **Shadow-mode DO failures are non-blocking** — the handler logs and continues to the existing-path send.
2. **Storage bloat.** 10-run history per DO × 100k repos × N PRs each is bounded. Each `RunRecord` is ~500 bytes; 10/PR × 1000 PRs/repo × 1000 repos = 5GB. Acceptable. Eviction policy: oldest first.
3. **Alarm scheduling race.** A retry alarm fires while a new push has already superseded the run. Mitigation: alarm handler reads current state; if `state.runId !== alarm.runId` → no-op (the alarm is stale). Test coverage required.
4. **Status route abuse / DDoS.** Unauthenticated GET could be hammered. Mitigation: existing Cloudflare DDoS protection at the edge; per-zone rate limits if needed. v2 candidate: per-installation auth.
5. **Durable Object cost at scale.** ~$0.15/M requests + 10ms-billed CPU. At 1000 PRs/day across all installations × 5 enqueue events per PR = 5k/day = ~150k/month. Negligible in v1.
6. **Class rename / migration churn.** Renaming `PrReviewRunDO` later requires a `renamed_classes` migration block. Cheap but disruptive — name chosen carefully.
7. **Shadow-mode race.** During `shadow`, both the existing path AND the DO see the same webhook. The DO writes state; the existing path runs the work. The DO state stays `queued` indefinitely in shadow (no `/pickup`, no `/run-result`, watchdog skipped per §4.6a). This is intentionally observational — operators monitor enqueue counts and status-route shape against existing-path success rates. Cross-path verdict comparison (which would require the existing-path consumer to also report to the DO) is a v2 candidate; v1 ships without it.
8. **`pr-review` is the only DO-routed JobMessage in v1.** Other per-PR variants share KV state (`pr-overview-dedupe`, etc.) but their cost-per-duplicate is much lower (≤ a few cents); v1 deliberately does NOT migrate them. v2 adds.

---

## Sign-off matrix

| Reviewer | v1 Decision | v2 Decision | v3 Decision |
|---|---|---|---|
| Codex | APPROVE-WITH-CHANGES (3B+7M+4m) | APPROVE-WITH-CHANGES (1B+2M+2m+2P) | APPROVE-WITH-CHANGES (2 MAJOR + 1 MINOR — all folded in v4) | _pending_ |
| Kimi K2.6 | APPROVE-WITH-CHANGES (5B+6M+4m) | APPROVE-WITH-CHANGES (1B+3M+2m) | APPROVE-WITH-CHANGES (1 MAJOR + 4 MINOR — all folded in v4) | _pending_ |

| Reviewer | v4 Decision |
|---|---|
| Codex | APPROVE-WITH-CHANGES (1 MAJOR `consumerId` schema gap + 1 MINOR §6/§7 shadow-mismatch refs — both folded inline) |
| Kimi K2.6 | **APPROVE** |

### v3 → v4 changelog

- **Codex M1 + Kimi M2** (MAJOR): §4.9 watchdog default `600000` → `1200000` to match §4.6a's bumped 1200s.
- **Codex M2** (MAJOR): single attempts-increment point. `attempts` is now incremented EXACTLY ONCE per logical retry — when the retry alarm fires AND the DO sends a new queue message. Both retry-alarm and watchdog-alarm paths defer the increment to alarm-fire time.
- **Kimi M1** (MAJOR): §4.4 catch block now guarded with `if (mode === "post")` — shadow-mode DO outages no longer reject GitHub.
- **Kimi M3** (MINOR): `/run-result` payload now includes `consumerId`; DO compares against `state.consumerId` and routes mismatches to history (avoids late-post-from-superseded-consumer race).
- **Kimi M4** (MINOR): `alarm()` handler dispatch on `alarmKind` documented with explicit branching pseudocode.
- **Codex MINOR + Kimi M5** (MINOR): `do-review-gc-skipped` and `do-review-shadow-mismatch` removed from v1 telemetry list — GC is v2, shadow-mismatch comparison logic needs the existing-path consumer to also report which is out of v1 scope.

### v2 → v3 changelog

**BLOCKING fixes:**

- **Kimi N1 — queue retries × DO retries**: v2 proposed `max_retries: 0` on the queue side, but `OPENCLAW_JOBS` is shared with 6 other JobMessage variants — can't change global config. v3 adds a `POST /pickup` callback (§4.3 + §4.6) that the consumer calls FIRST. Atomic `queued → running` transition; queue redeliveries 409/410 within ~10ms instead of re-running the ensemble. Same fix simultaneously resolves Codex MAJOR + Kimi MAJOR N4 on v2 about `running`/`pickedUpAt` being underspecified.
- **Codex BLOCKING — §7.1 ctx.waitUntil contradiction**: rewrote risk #1 to align with §4.4's awaited semantics; documented total latency budget ~30-50ms.

**MAJOR fixes:**

- **Kimi N2 — watchdog should retry, not terminal-fail**: §4.6a watchdog now classifies missed `/run-result` as transient. If `attempts < MAX_RETRIES`, schedules a retry alarm; only marks `failed` (terminal) when attempts exhausted.
- **Kimi N3 — watchdog default 600s tight**: bumped to 1200s (`ORCHESTRATOR_WALL_MS + 300s` + slack).
- **Codex MAJOR — shadow + watchdog conflict**: §4.6a now skips watchdog scheduling when `mode === "shadow"`. DO state stays `queued` indefinitely in shadow (observation-only).
- **Codex PARTIAL telemetry tag**: §5 telemetry events all annotated with `dedupe_system: "do"`.
- **Codex PARTIAL env rename**: §2 + §6 references to `OPENCLAW_PR_REVIEW_USE_DURABLE_OBJECT` updated to `OPENCLAW_PR_REVIEW_MODE`.

**MINOR fixes:**

- **Codex MINOR — naming inconsistency**: standardized on `alarmTargetRunId` (camelCase) everywhere; the v2 use of `alarm_target_run_id` was a stray.
- **Kimi N5 — GC sweep ambiguous**: §4.10 explicitly states the cron sweep is v2-only; v1 ships ONLY the `lastActivityAt` instrumentation.
- **Kimi N6 — postRunResult on shadow runId**: consumer wrapper now guards `if (!message.runId)` and falls back to legacy direct-path semantics, so shadow-mode existing-path messages don't hit the DO callback.

### v1 → v2 changelog

**BLOCKING fixes (5 unique across both signers):**

1. **Shadow mode no double-enqueue** (§4.4): in shadow, the DO RECORDS state but does NOT dispatch to the queue. Existing webhook handler's `OPENCLAW_JOBS.send` is the work path; DO is observation-only.
2. **Webhook AWAITS DO enqueue** (§4.4): replaced `ctx.waitUntil` with synchronous `await stub.fetch(...)`. On DO failure in `post` mode → 503 to GitHub, which retries. Lost-work scenario gone.
3. **Status route 404 race resolved** (§4.7 implicit): since enqueue is now awaited, 404 unambiguously means "never enqueued" — no time-window where DO doesn't yet exist.
4. **Alarm metadata persisted** (§4.6): `alarmTargetRunId` + `alarm_kind` written to storage when scheduling. `alarm()` handler reads it; stale-runId alarms are no-ops with `do-review-alarm-stale` telemetry.
5. **Queue retries × DO retries collision fixed** (§4.6): queue-side `max_retries: 0` for DO-routed messages; DO is sole authority. Watchdog alarm (§4.6a) catches consumer-crash-before-/run-result.

**MAJOR fixes (6):**

6. SQLite-backed DO → key-value DO (§4.8). v1 access is point-lookup; SQLite buys nothing.
7. `lastActivityAt` instrumentation + 30-day GC sweep (§4.10). Sweep itself ships in v2 once Cloudflare's DO list API is stable.
8. Env var renamed `OPENCLAW_PR_REVIEW_USE_DURABLE_OBJECT` → `OPENCLAW_PR_REVIEW_MODE` (§4.9).
9. `installationId` explicit persistence + propagation in every queue message including alarm retries (§4.2 RunState shape).
10. Consumer-side `classifyEnsembleError` is new code, added as explicit AC item (§2).
11. Telemetry tag `dedupe_system: "kv" | "do"` so dashboards can split (§2 + §5).

**MINOR fixes (4):**

12. Class name `PrReviewRunDO` retained — matches existing `Pr*` short-form prefix.
13. `runId = crypto.randomUUID()` (UUIDv4), not "ULID-ish" (§4.2 RunState shape).
14. History cap tunable via `OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT` (§4.2 storage table).
15. URL parser uses `decodeURIComponent` per segment, rejects `/`-containing segments (§4.7).
