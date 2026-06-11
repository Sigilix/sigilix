# SIG-374 — PERF-MEASURE: close the telemetry gaps — implementation spec

**Status:** spec / pre-implementation. Parent: SIG-369 (adaptive review budget), Phase 1 (with SIG-397, shipped #473).
**Branch:** `sig-374-perf-measure`. **Telemetry only — zero behavior change, no new model calls, no prompt changes.**

## Goal

e2e p50 (450–478s) minus the visible phases (~49–147s) leaves ~300–430s dark; e2e p95 1921s / slowest 4250s exceed the 900s CF wall per attempt (⇒ requeues we can't count). Instrument the dark middle so SIG-369's Phase 2/3 levers (SIG-371/372/373, SIG-224) optimize measured time, not guesses. Outcome: for any review, the monitor can decompose e2e into **queue wait + attempts + phases 1–6 + post-validate tail**, with the >900s tail attributed to requeues.

## Already instrumented — OUT OF SCOPE (do not re-instrument)

- Phases 4/5/6 (`ensemble-phase-completed`, emit sites: `ensemble/app/context/gather-evidence.ts:232`, `ensemble/app/specialists.ts:562`, `ensemble/app/synthesize.ts:661`, `ensemble/app/publish.ts:947`) + `preflight_retrieval` + `deterministic_scans` phases.
- `specialist-fanout-summary` (incl. `slowestRole`/`slowestElapsedMs`/`totalAttemptsUsed`), `synth-summary`, `synth-retry-dispatched`/`-completed` (`synthesize.ts:526–551`).
- `do-review-run-timing` (`do/consumer-wrapper.ts:122–145`: `pickedUpAtMs`, `finishedAtMs`, `consumerWallMs`, `finalState`).
- Graph/logic token cost: `graph-expansion-injected` (`gather-graph.ts:415–426`), `logic-prompt-budget` (`lib/logic-prompt-budget.ts:302–338`).
- Early-exit shadow events (`specialists.ts:430–558`).

## New events (all `console.log(JSON.stringify({event, ...}))` to Workers Logs, same as `ensemble-perf-telemetry.ts`; correlation keys `owner`/`repo`/`prNumber`/`headSha` (7-char) everywhere, `runId` where available; DO-emitted events carry `dedupe_system:"do"`)

### Gap 1 — queue wait + dispatch (the prime suspect for the dark p50)

| Event | Fields | Emit site |
|---|---|---|
| `pr-review-webhook-arrived` | `deliveryId` (x-github-delivery), `arrivedAtMs` | `index-github-webhook.ts` handleGitHubWebhook entry (~:48, after body read) |
| extend `do-review-enqueued` | + `enqueuedAtMs`, `deliveryId` | **`do/pr-review-run.ts:237`** (existing event — the sign-off corrected the anchor; additive fields) |
| extend `do-review-run-timing` | + `enqueuedAtMs`, `queueWaitMs` (= pickedUpAtMs − enqueuedAtMs), `attempt` | `do/consumer-wrapper.ts:122–145` |

`enqueuedAtMs` + `attempt` ride the queue message payload as **optional** fields on `JobMessage` (`do/types.ts`), stamped in the DO **immediately before every `OPENCLAW_JOBS.send`** — including the retry-alarm send (`do/pr-review-run.ts:~702`), so watchdog requeues get queue-wait timing too. In-flight jobs during deploy will lack the fields: the consumer guards `typeof job.enqueuedAtMs === "number"` and emits `queueWaitMs: null` when absent.

Derivation in monitor: webhook→enqueue (`enqueuedAtMs − arrivedAtMs`, joined on deliveryId), queue wait (`queueWaitMs`) — covering both first sends and retry-alarm sends — then existing phase events cover the rest.

### Gap 2 — attempt / requeue count per PR/check-run (the >900s tail)

**AS BUILT: no new event.** The existing `do-review-deduped` / `do-review-superseded` / `do-review-enqueued` events already carry `action`+`reason` across all four decision branches; `do-review-enqueued` additionally gains `enqueuedAtMs`, `deliveryId`, `staleHeadRequeueDepth` (sourced from the request body — the same source the queue message forwards). Monitor queries target those three events, not a `pr-review-enqueue-decision` event.

- **Source of truth for attempts is `RunState.attempts`,** carried as the `attempt` field on every DO queue message (Gap 1) and surfaced in `do-review-run-timing.attempt`. `pr-review-enqueue-decision` is dedupe/supersede observability ONLY — counting decisions would double-count simple runs and miss watchdog retry-alarm requeues (sign-off finding 3).
- **Stale-head requeues: no new event.** `pr-review-stale-head-requeued` already exists (`lib/stale-head.ts:167`) with snake_case fields (`next_depth`, `queued_head_sha`, `new_head_sha`) — the monitor consumes the existing schema as-is; do not fork or alias it (sign-off finding 5).

### Gap 3 — phases 1–3 sub-timing (split the `preflight_retrieval` lump)

One event shape, four emitters (mirrors `ensemble-phase-completed` style):

`ensemble-subphase-completed` — fields: `subphase` ("dep_vuln_scan" | "ast_source_fetch" | "graph_retrieval" | "runner_evidence"), `startedAtMs`, `endedAtMs`, `durationMs`, plus per-subphase counts:

- `dep_vuln_scan`: `manifestsScanned`, `findingsCount` (counts already in `GatherEvidenceTelemetry.depVulnScan`, gather-evidence.ts:73–86 — add timing) — wrap the `runDepVulnScan` call (gather-evidence.ts:~273–284).
- `ast_source_fetch`: `filesCount`, `bytesFetched` — wrap the JS/TS source fetch + cache creation (gather-evidence.ts:~308–347). Named honestly: real AST *parsing* happens lazily in `runAstRules`/cache consumers and is covered by the existing `deterministic_scans` phase, not this subphase (sign-off finding 4).
- `graph_retrieval`: `cacheHit` flags as available — wrap the graph block in `gather-graph.ts:110+` (distinct from the existing `deterministic_scans` phase and the shadow `graph-expansion-injected`).
- `runner_evidence`: `evidenceCount` — wrap the SARIF fetch (`features/sarif-evidence/app/runner.ts:~176` call site in gather flow).

Timing wrappers live in the **app layer call sites** (gather-evidence.ts / gather-graph.ts), NOT inside `features/*` domain code — keeps the dependency rule clean (features stay telemetry-free; the orchestrating app layer times them from outside).

### Gap 4 — post-validate tail

`post_validation` already exists in the phase enum (`ensemble-perf-telemetry.ts:78`) but is never emitted. Emit `ensemble-phase-completed{phase:"post_validation"}` around the `verifyAndBuildSubmission` span at its orchestrator call site (start = synth verdict accepted; end = submit handoff). ~~Plus `claims-validation-completed`~~ DROPPED at implementation: the `verdict-claims-validator` module the ticket cited no longer exists post-SIG-318 — claims validation lives inside `domain/validation.ts` within this span, and per-gate `pr-review-finding-rejected-validation` events already carry the kept/demoted detail. The phase timing + existing gate events cover the need without reaching into domain code.

### Gap 6 — GitHub file-fetch overlap (sizes SIG-371; measurement only, NO dedupe/caching yet)

Per-review counter **instance-scoped on `GitHubClient`** (`shared/adapters/github/client.ts`, `getFileContent` ~:350; never global/static — Workers global state is per-isolate, not per-request): count calls per `(path, ref)`, expose a read accessor. **The adapter emits nothing and imports no telemetry** (dependency rule): the app layer reads the counter at review end and emits one `github-file-fetch-summary` — `totalCalls`, `uniqueKeys`, `dupCalls` (= total − unique), `topDupPaths` (≤5). One summary event, not per-fetch spam. `getPullRequest` round-trips get the same counter (sizes SIG-372). File budgets are tight — client.ts is 1308/1500, gather-graph.ts 963/1000 — keep additions thin and put event builders in `ensemble-perf-telemetry.ts` (or a small sibling), not in the large app files.

### Gap 7 partial — per-role timing histogram (cheap, completes the long-pole picture)

`specialist-role-completed` — `role`, `elapsedMs`, `verdictOk`, `modelUsed`, `attemptsUsed` — emitted per role where the fanout collector resolves each specialist (`ensemble/app/specialists.ts`, the per-role resolution inside the quorum collector ~:348–560). `specialist-fanout-summary` already names the slowest; this adds the full distribution.

## What needs a metrics DO vs plain logs

**Nothing new needs a DO.** All eight additions are stateless log events; the monitor (sigilix-monitor ingester) already consumes Workers Logs NDJSON and can aggregate p50/p95 per event. Revisit only if queue-wait percentiles prove too query-expensive log-side (then a counters DO à la `ValidationMetricsDO` — explicitly out of scope now).

## Test plan

- Unit: each new emitter behind a small pure builder (à la `ensemble-perf-telemetry.ts` emit helpers) — assert event name + field shape; golden NDJSON lines following the validation-matrix golden pattern (`tests/_golden/`).
- The fetch-counter: unit-test the request-scoped counter (dup counting, summary math) pure; one integration assertion that two `getFileContent` calls for the same `(path, ref)` yield `dupCalls:1`.
- Queue-path events: extend the existing DO tests (`do/pr-review-run` test suite) to assert `pr-review-enqueue-decision` fires per action branch (create/supersede/dedupe).
- `npm run build` green; no snapshot/golden churn outside the new fixtures.

## Rollout

Additive events, no flags, no behavior change — ship dark, then point the monitor at the new event names (monitor-side dashboards are SIG-369 Phase 5 / sigilix-monitor work, separate repo, not this PR). After ~48h of prod traffic: write the "p50 decomposition" snapshot into SIG-374 and close it against the ticket's Done bar (the ~300–430s gap split + the >900s tail attributed).

## Non-goals

- No IO dedupe/memoization (that's SIG-371/372 — this PR only measures the overlap).
- No B1 prompt trim / B2 early-exit graduation / B5 fallback changes (recall-gated, separate tickets).
- No monitor/dashboard changes (separate repo), no new DOs, no flags.
- No renaming of legacy `OPENCLAW_*` env vars or existing event names.
