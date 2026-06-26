# PR B — Provider Backpressure (SIG-455) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** When the single OpenRouter account rate-limits (429) or overloads (503), back off **globally** across all concurrent reviews via a shared, strongly-consistent cooldown — so 5 reviews don't herd a degraded upstream — without compounding the existing retry layers.

**Architecture:** The model adapter parses `Retry-After` and throws a typed `ProviderRateLimitError(retryAfterMs)`. A higher layer with `env` (the ensemble orchestrator) **sets** a shared `ProviderCooldownDO` (fire-and-forget). The webhook queue consumer **reads** the cooldown before firing a review; if cooling down it re-sends the job after a decorrelated-jittered delay via PR A's existing `/defer` path (so the per-PR DO retry counter is untouched). `/v1/review` (synchronous) returns 429+Retry-After when cooling down. Cooldown is account-wide (one DO instance), lives with the model adapter, and shields every surface automatically.

**Tech Stack:** Cloudflare Worker (TS strict), Durable Objects (SQLite-backed), the existing ensemble retry engine (`runWithRetryAndFallback`), PR A's `/defer` re-send.

## Global Constraints

- Clean-arch (COMPLIANCE.md): `@/` imports, barrel-only feature imports, inward-only deps, files ≤1000 lines, co-located dot tests.
- **Recall-safety / fail-open:** the cooldown must NEVER block or drop a review on a fault. Any DO error → no cooldown (proceed). A cooldown only ever *delays* (re-send / 429-with-Retry-After), never silently loses a review.
- **Retry-layer separation (§6):** a 429/503 drives ONLY the cooldown + jittered re-send. It must NOT increment the `PrReviewRunDO` `[30s,90s,270s]` backoff counter, and must NOT consume the Cloudflare Queue `max_retries` budget (no `message.retry()` for backpressure — reuse `/defer`'s fresh `send()`).
- **New DO uses `new_sqlite_classes`** (NOT `new_classes` as the spec table line 224 says — that triggers the same deploy issue; every recent DO is SQLite-backed; `ctx.storage.get/put/setAlarm` is identical). Migration tag appended LAST after `sig-455-tenant-concurrency-v1`. Note: this PR adds a DO → its Workers Builds deploy step will 10211 until a one-time `wrangler deploy` (known; reference_cloudflare_versions_upload_do_migration).
- Ships dark: `SIGILIX_PROVIDER_COOLDOWN_MODE = off | shadow | enforce` (default `shadow` in wrangler.toml, `off` in code when absent). **shadow** = set cooldown + log, but do NOT honor (never delays a review). **enforce** = honor (re-send / 429). Fail-open in all modes.

---

## File Structure

- `src/lib/ensemble/domain/backpressure.ts` (NEW, pure) — `decorrelatedJitterMs(baseMs, capMs, rand)`, `parseRetryAfterMs(header, nowMs, defaultMs)`, `resolveCooldownMode(env)`. + `.test.ts`.
- `src/shared/adapters/model/provider-errors.ts` (NEW) — `ProviderRateLimitError extends Error { retryAfterMs: number; provider?: string }` + `isProviderRateLimit(e)`. + `.test.ts`.
- `src/shared/adapters/model/openrouter-chat.ts` (MODIFY ~120-124) — on `res.status === 429 || 503`, parse `res.headers.get("retry-after")`, throw `ProviderRateLimitError` (message still includes the status so existing transient-classification is unchanged).
- `src/do/provider-cooldown.ts` (NEW) — thin DO, one instance `provider-cooldown-openrouter`. `POST /set {cooldownMs}` → `cooldownUntil = max(existing, now+cooldownMs)`; `POST /get` → `{ remainingMs }`. STATE_KEY="cooldown". No alarm needed (cooldown is read-on-demand; stale state is harmless).
- `src/shared/adapters/model/provider-cooldown-client.ts` (NEW) — `setProviderCooldown(env, cooldownMs)`, `getProviderCooldownRemainingMs(env): Promise<number>`. Both fail-open (error → set is no-op / get returns 0). + `.test.ts`.
- `src/shared/types/env.ts` (MODIFY) — `PROVIDER_COOLDOWN: DurableObjectNamespace` + `SIGILIX_PROVIDER_COOLDOWN_MODE?: string`.
- `wrangler.toml` (MODIFY) — DO binding + `[[migrations]] tag="sig-455-provider-cooldown-v1" new_sqlite_classes=["ProviderCooldownDO"]` (appended last) + `SIGILIX_PROVIDER_COOLDOWN_MODE="shadow"` under `[vars]`.
- `src/index.ts` (MODIFY) — `export { ProviderCooldownDO }`; in `queue()` for pr-review jobs, **read cooldown before admission**; if enforce + remaining>0 → `/defer` re-send after `remaining + jitter`, ack, continue. **Set cooldown** when a dispatched review's outcome carries a 429 (see seam below).
- `src/lib/api-review-route.ts` (MODIFY) — Mode B: read cooldown before admitTenant; enforce + remaining>0 → 429 + `Retry-After`.
- **Set-on-429 seam** (the crux — Codex to validate): thread the rate-limit signal up. `attemptChat`/`runWithRetryAndFallback` outcome gains `providerRateLimitMs?: number` (captured from a caught `ProviderRateLimitError`). `runSpecialist`/`runSynthesizer` already have an `onAttempt` observer; add `providerRateLimitMs` to `AttemptCallbackInfo`. The ensemble orchestrator (`handlePrReviewEnsemble`, has `env`) sets the cooldown (fire-and-forget, via `ctx.waitUntil`) when any attempt reports `providerRateLimitMs`.

## Interfaces (produced)

- `decorrelatedJitterMs(jitterBaseMs:number, jitterCapMs:number, rand:number): number` — **fixed-base** uniform in `[base, cap]` = `round(base + rand*(cap-base))`, **decoupled from remainingMs** (GLM fix #2; default base 500ms, cap 5s). Resume delay = `remainingMs + decorrelatedJitterMs(...)`.
- `parseRetryAfterMs(header:string|null, nowMs:number, defaultMs:number): number` — delta-seconds OR HTTP-date; invalid/absent → `defaultMs`.
- `class ProviderRateLimitError extends Error { retryAfterMs:number; provider?:string }`.
- `setProviderCooldown(env, cooldownMs:number): Promise<void>` (fail-open).
- `getProviderCooldownRemainingMs(env): Promise<number>` (fail-open → 0).

---

## Tasks (TDD; each: write failing test → run red → implement → run green → commit)

### Task 1 — Pure backpressure math (`domain/backpressure.ts`)
- `decorrelatedJitterMs`, `parseRetryAfterMs`, `resolveCooldownMode(env)` (off/shadow/enforce, default off when absent).
- Tests: jitter bounds with rand=0 and rand=1; cap clamps; `Retry-After: 30` → 30000; HTTP-date form; absent/garbage → default; mode resolution incl. absent→off.

### Task 2 — Typed error + adapter throw (`provider-errors.ts` + `openrouter-chat.ts`)
- `ProviderRateLimitError` + `isProviderRateLimit`. Adapter: 429/503 branch parses Retry-After (default e.g. 20s), throws the typed error; message keeps `OpenRouter HTTP <status>` prefix.
- Tests: 429 with `Retry-After: 5` → typed error, retryAfterMs=5000; 503 no header → default; non-429/503 → plain Error unchanged (existing tests stay green).

### Task 3 — `ProviderCooldownDO` + binding + migration + export
- DO with `/set` (max-merge) + `/get` (remainingMs). env.ts binding; wrangler.toml binding + `new_sqlite_classes` migration (appended last) + `SIGILIX_PROVIDER_COOLDOWN_MODE="shadow"`; export from index.ts.
- Tests (shim): set then get returns ~remaining; max-merge (shorter set doesn't shrink a longer cooldown); expired → 0; malformed body → 400.

### Task 4 — Cooldown client (`provider-cooldown-client.ts`)
- `setProviderCooldown` / `getProviderCooldownRemainingMs`, fail-open.
- Tests: happy path; DO throw → set no-op / get→0; non-200 → get→0; malformed body → 0.

### Task 5 — Set-on-429 seam (adapter outcome → orchestrator → DO)
- Add `providerRateLimitMs?` to `attemptChat` outcome + `AttemptCallbackInfo`; capture from the caught typed error in `attemptChat`'s catch. Orchestrator sets cooldown via `ctx.waitUntil(setProviderCooldown(env, ms))` when mode≠off and any attempt reported it; emit `provider-cooldown-set`.
- Tests: a specialist attempt that 429s → orchestrator calls setProviderCooldown with the parsed ms (mode shadow + enforce both set); mode off → never sets; a non-429 failure → never sets.

### Task 6 — Read-before-fire + retry-layer separation (queue consumer + `/v1/review`)
- `src/index.ts queue()`: for an eligible pr-review job, before admitTenant, `getProviderCooldownRemainingMs(env)`; if mode==="enforce" && remaining>0 → call `/defer` with `backoffMs = remaining + decorrelatedJitter` (REUSE PR A's defer; attempt + DO counter untouched), ack, continue, emit `provider-cooldown-honored`. shadow/off → proceed. Fail-open. Place BEFORE the fairness gate so a cooling-down provider short-circuits cheaply.
- `api-review-route.ts` Mode B: enforce + remaining>0 → `429 { error:"provider_busy" }` + `Retry-After` header; shadow/off → proceed.
- Tests: enforce+cooldown → queue job deferred (no dispatch, no attempt increment), `/v1/review` → 429+Retry-After; shadow → proceeds + logs; off → byte-identical to today; DO error → proceeds (fail-open).

### Task 7 — Wiring verification + whole-branch
- Confirm: DO-key seam single instance; mode default story; migration last + new_sqlite_classes; no file >1000 lines; `npm run build` green.

---

## Sign-off fixes — GLM-5.2 (GO-WITH-FIXES, folded)

The build MUST honor these:
1. **Cap unbounded cooldown:** DO `/set` clamps `cooldownUntil = min(now + MAX_COOLDOWN_MS, max(stored, now+cooldownMs))` with `MAX_COOLDOWN_MS = 300_000` (5 min) — a sustained 429 storm must not extend the cooldown forever. AND the provider-driven re-send reuses PR A's `deferCount`/`MAX_DEFERS` bypass so a job eventually runs rather than deferring forever (anti-permanent-block).
2. **Jitter** = fixed-base decorrelated, decoupled from `remainingMs` (see interface above) — done in Task 1.
3. **`/v1/review` 429 drop semantics:** returning 429+`Retry-After` is correct HTTP, but a client that ignores it drops the review. Document in the route comment + CLI that the caller must honor `Retry-After`. The webhook path re-sends via `/defer`, so it never drops. (No server-side re-enqueue for the sync path — it's request/response.)
4. **Ack-after-defer-ok:** in `queue()`, only `message.ack()` after the `/defer` re-send returns ok; else fall through (run now) — already PR A's pattern; keep it. Never ack before the re-send succeeds (CF at-least-once).
5. **Fire-and-forget set never throws:** `ctx.waitUntil(setProviderCooldown(env, ms).catch(() => {}))`; `getProviderCooldownRemainingMs` is **awaited** (it gates the decision — never fire-and-forget the read).

Confirmed sound (no change): one global DO instance; max-merge race-free via the DO input gate (no `blockConcurrencyWhile` needed); no alarm (read-on-demand); fail-open can never block, only delay.

## Sign-off fixes — Codex (repo-grounded, folded)

**The first-429 gap (mandatory).** Read-before-fire (Task 6) only protects jobs not yet started. The job that *hits* the 429 is already past `/pickup` (state `running`); on a provider-rate-limit failure it must re-send via **`/defer`** (cooldown + jitter), NOT fall through to `/run-result(transient)` which would arm the `PrReviewRunDO [30s,90s,270s]` counter (violates §6 for the triggering job). → **Task 6b** below.

Seam decisions (Codex-reviewed, kept): set-on-429 uses Option A (thread `providerRateLimitMs` through `attemptChat` outcome → `onAttempt` → orchestrator sets cooldown); read-before-fire sits BEFORE the fairness gate (cheap short-circuit; cooldown-defer and fairness-defer are sequential in one pass, so no double-defer); do NOT fail-fast on 429 in the engine (keep the bounded in-ensemble same-model retry — failing fast would drop a specialist a `[800,2500]` retry would have saved; the cooldown is the cross-review mechanism, not a per-attempt one).

### Task 6b — First-429 escape (retry-layer separation for the triggering job)
- In the DO consumer-wrapper (`src/do/do-consumer-wrapper.ts`, `runPrReviewWithDoCallback`): when the ensemble result indicates a provider rate-limit (the Task-5 signal surfaced on the result/telemetry) AND `SIGILIX_PROVIDER_COOLDOWN_MODE==="enforce"`, re-send the job via `PrReviewRunDO./defer` (`backoffMs = cooldownRemaining + decorrelatedJitter`) **instead of** calling `/run-result` with status `transient` — so the `[30s,90s,270s]` counter is untouched and the job rides the cooldown layer. shadow/off → today's behavior (run-result transient) byte-identical. Reuse PR A's `deferCount`/`MAX_DEFERS` bypass so a sustained outage can't defer forever.
- Tests: a 429-class ensemble result in enforce → `/defer` called, `/run-result(transient)` NOT called, DO retry counter unchanged; shadow → `/run-result(transient)` as today; a non-429 failure → `/run-result` as today (unchanged).

## Risks for sign-off (Codex + GLM-5.2)
1. **Set-on-429 seam** — is threading `providerRateLimitMs` through the outcome + `onAttempt` the cleanest, or should the orchestrator classify the failureReason string for "429"? (Codex — repo-grounded.)
2. **Read-before-fire placement** — before vs after the fairness gate; double-delay risk if both fairness AND cooldown defer the same job. (Codex.)
3. **DO mechanics** — one global instance, single-threaded set/get races, max-merge correctness, no-alarm (read-on-demand) soundness. (GLM-5.2.)
4. **Retry-layer separation** — does reusing `/defer` truly keep the 429 out of the `[30s,90s,270s]` counter, and is the in-ensemble same-model retry (RETRY_BACKOFF_MS [800,2500]) on a 429 acceptable (it rides one 429 inside the attempt budget) or should the adapter fail fast on 429 so the cooldown is the only backoff? (Both.)
