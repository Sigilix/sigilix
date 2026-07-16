# Multi-tenant fairness + metering — design spec

- **Date:** 2026-06-25
- **Status:** Draft (founder-approved shape; pending founder review of this spec)
- **Author:** Claude (synthesized with Codex + DeepSeek-v4-pro + GLM-5.2 sign-off)
- **Scope decision:** Fairness + metering, **NO hard quotas** (quota enforcement ships dark/shadow). Memory→D1 is a later phase on the same foundation.
- **Linear mapping** (reuses existing tickets — no duplicates):
  - **PR A + PR B → [SIG-455](https://linear.app/sigilix/issue/SIG-455)** (per-tenant fairness + model-call backpressure)
  - **PR C → [SIG-343](https://linear.app/sigilix/issue/SIG-343)** (multi-tenant DB foundation; this spec is its store-choice ADR)
  - **PR D → [SIG-543](https://linear.app/sigilix/issue/SIG-543)** (shadow quotas + fairness/usage metrics) → precursor to **SIG-38** (hard enforcement)
  - **Phase 2 (deferred): SIG-448** (memory→D1) reuses this foundation. SIG-454 (logic retries quick-fix) already shipped.

---

## 1. Problem

Sigilix is a multi-tenant GitHub PR-review SaaS on a single Cloudflare Worker. Every review runs an
ensemble (4 specialists + synth) against **one shared OpenRouter account**. Three verified gaps make a
customer's burst silently degrade *everyone's* reviews:

1. **No per-tenant fairness.** One global FIFO queue `openclaw-jobs` (consumer `max_batch_size=1`,
   `max_concurrency=5`). Jobs carry `installationId` but nothing caps per-tenant concurrency — one team
   bursting 10 PRs fills all 5 slots; another customer's lone PR waits.
2. **No global model-call backpressure.** 5 concurrent reviews ≈ 20 concurrent OpenRouter calls, no
   shared rate tracking.
3. **429 = fixed backoff `[30s,90s,270s]`, ignores `Retry-After`** (`pr-review-run-internals.ts:107-116`)
   → stalled reviews retry in lockstep = thundering herd. The heaviest call (logic) blows its window
   first → null verdict → a **visible** "partial review — logic unavailable" banner → missed bugs.

That visible degradation in front of a customer is the believability risk this spec kills.

## 2. Goals / non-goals

**Goals (Phase 1):**
- Per-tenant concurrency fairness so no tenant's burst starves another.
- Provider-aware backpressure (parse `Retry-After`, jittered backoff, shared cooldown) — no herd.
- Usage **metering** recorded per review (foundation for future billing/quotas).
- A canonical tenant data layer in D1 (registry + cold aggregates), introduced cleanly.

**Non-goals (explicitly out of Phase 1):**
- **Hard quota enforcement.** A review is NEVER refused for budget. Quota *checks* run in shadow only.
- Tiers/billing. The schema allows tiers; we ship one default tier.
- Memory (Learnings / review-memory) → D1 migration. That is Phase 2 (SIG-448), reusing this foundation.
- A weighted-fair-queueing scheduler. DeepSeek confirmed admission+retry suffices below ~100 tenants /
  global concurrency ≤ 20; WFQ would be over-engineering now.

## 3. Key decisions (and why)

| Decision | Rationale | Source |
|---|---|---|
| Admission via a shared **`admitTenant()`** helper, called from **both** the queue consumer (`src/index.ts queue()`, before `dispatchJob`) and the hosted `/v1/review` route (§4.5) | Only layer that can orchestrate ack/dispatch; a single primitive keeps fairness identical across every surface that runs the ensemble | Codex + founder (cross-product) |
| On deny, **never `message.retry()`** — the per-PR DO **re-`send()`s** a fresh job | `message.retry()` increments the retry counter; a denied burst hits `max_retries=3` and Cloudflare **silently drops the review** | GLM |
| Deny path calls **`PrReviewRunDO./defer`** (re-arm watchdog + schedule DO re-send) | The per-PR DO is armed at *enqueue* time (`pr-review-run.ts:212-220`), before the consumer runs; a naive consumer-side delay would let the 20-min watchdog **false-fail** a run that was only waiting its turn | Codex (the block-on) |
| Hot coordination → **Durable Objects**; D1 → **registry + cold aggregates only** | D1 is read-replica SQLite, poor for hot/contended writes; DOs are strongly consistent & cheap (~10ms) | GLM |
| Provider cooldown → a **`ProviderCooldownDO`**, not KV | KV propagation is ~60s → still a herd; a DO is strongly consistent (sub-second) | GLM |
| **No storage `ports/` layer.** Tenancy adapters take `Env` directly | The repo uses ports only for model/embedding/github app-seams (`COMPLIANCE.md:49-55`); storage features call `Env` directly (`precision-profile/adapters/store.ts:46-90`). Adding a storage port = inventing a pattern the repo doesn't use = *twisted* | Codex |
| Meter from the existing **`finalize()`** | The ensemble already computes calls/tokens/cost (`session.ts:223-286`); don't reconstruct usage in the queue wrapper | Codex |
| Tenant slot keyed on a dedicated **`leaseId`**, not `runId` | `runId` is absent on slash-command reruns and can repeat across redeliveries (`consumer-wrapper.ts:69-70`) | Codex |
| **Fail-open:** any error in `acquire()` *or* a failed `/defer` → proceed (GRANT) | A customer's review must never be blocked or dropped by our optimization | GLM |
| **Pin `max_concurrency` in `wrangler.toml`** | It's dashboard-only today (`wrangler.toml:1050-1072`) = guaranteed config drift | GLM + Codex |

## 4. Architecture

### 4.1 Canonical tenant model

- **Tenant = GitHub App `installationId`** — the natural fairness/billing boundary, already on every
  PR-review job (`job.ts:62-140`) and preserved through DO retry sends (`pr-review-run.ts:719-747`).
- **`repoId`** (GitHub immutable id) nests under the tenant. Both are resolved at the webhook so they
  are non-optional downstream.
- No new identity plumbing is required for Phase-1 fairness — only the registry rows in PR C.

### 4.2 Call flow

```
GitHub webhook ─▶ enqueuePrReviewJob ─▶ PrReviewRunDO /enqueue
                                          (persists RunState, arms watchdog, SENDS queue message)
                                                    │
queue(batch) in src/index.ts ◀──────────────────────┘
  for a pr-review message, BEFORE dispatchJob:
    ┌─ ADMIT: TenantConcurrencyDO("tenant:"+installationId).acquire() ──┐
    │   GRANT → leaseId                                                 │
    │       dispatchJob(...)        (existing: /pickup → run → /run-result)
    │       finally: TenantConcurrencyDO.release(leaseId)               │
    │   DENY  → PrReviewRunDO.defer({backoffMs})                        │
    │       (DO re-arms watchdog + schedules an alarm to re-SEND a      │
    │        fresh job after backoff; consumer ACKs only AFTER /defer   │
    │        returns 200 — no queue retry consumed)                     │
    └───────────────────────────────────────────────────────────────────┘
  FAIL-OPEN: any error in acquire() OR a non-200 from /defer → proceed with the
  review (GRANT). The consumer must never ACK-and-drop a job on a fairness fault —
  the re-send is guaranteed only once /defer has durably scheduled the DO alarm.
```

Slash-command reruns raw-send messages **without `runId`** (`index-dispatch.ts:653-669`); these bypass
DO handling (`consumer-wrapper.ts:69-70`) and are intentionally **not** fairness-gated (human-initiated,
low volume).

### 4.3 Components

- **`TenantConcurrencyDO`** (`src/do/tenant-concurrency.ts`, KV-backed DO) — one instance per tenant.
  Holds in-flight **leases** (`leaseId → {acquiredAt, leaseExpiresAt}`), the per-tenant cap (default 2),
  and per-lease `denyCount` for backoff. `acquire()` is pure in-memory arithmetic; the DO's
  single-threaded loop self-serializes a tenant's own burst (a feature, not a cost). A reaper `alarm()`
  (every 60s) reclaims an expired lease only after reconciling against `PrReviewRunDO /status`
  (extend if still running; reclaim only if idle/done/failed).
- **`PrReviewRunDO` change** (`src/do/pr-review-run.ts`) — add a `/defer` route: re-arm the watchdog to
  `now + watchdogMs` (so a queued-but-deferred run is not failed for waiting) and schedule an alarm of a
  new kind `"defer"` that re-`send()`s a fresh job after the backoff, via the existing message-preserving
  send path (`pr-review-run.ts:719-747`). A `deferCount` cap (e.g. 50) is the safety valve: beyond it,
  post a "review delayed" status rather than loop forever.
- **`ProviderCooldownDO`** (`src/do/provider-cooldown.ts`, KV-backed DO, **PR B**) — `idFromName`
  `"provider-cooldown-openrouter"`. On a 429/503, a consumer sets `cooldownUntil = now + Retry-After`;
  any consumer reads it before firing the ensemble and backs off with decorrelated jitter.
- **D1 `sigilix-platform`** (**PR C**) — `tenant`, `repo`, `usage_ledger`. Lazy upsert of tenant/repo on
  first webhook. Usage row appended from `finalize()`.

### 4.4 Module layout (clean-arch, matches existing conventions)

```
src/features/tenancy/
  index.ts                         # barrel — public surface only
  domain/
    tenant.ts                      # pure: Tenant, Tier, cap resolution, types
    fairness.ts                    # pure: acquire/release/deny-backoff/lease math  (unit-tested w/o the DO)
    fairness.test.ts
  adapters/
    d1-tenant-store.ts             # IO: tenant/repo registry against D1 (Env passed directly — NO port)
    d1-usage-ledger.ts             # IO: append usage rows to D1
src/do/
  tenant-concurrency.ts            # thin DO; delegates to domain/fairness.ts   (exported from src/index.ts:572-582)
  provider-cooldown.ts             # thin DO (PR B)
# Provider backpressure lives with the model adapter, NOT in tenancy:
src/shared/adapters/model/openrouter-chat.ts   # parse Retry-After (today it throws w/o headers, :115-124)
src/lib/ensemble/domain/model-policy.ts        # jittered backoff policy (today :25-28)
migrations/                        # D1 schema migrations (PR C onward) — see §7
```

- `domain/` is pure (no `Env`, IO, or clock) so the fairness algorithm is unit-tested in isolation with
  a fake clock — same pattern the metrics DOs use (SQLite shim in `test-shims/`).
- All cross-dir imports `@/...`; feature consumed only via its barrel; files ≤1000 lines.

### 4.5 Surfaces & cross-product hookup

The tenant primitives are **product-agnostic** — they key on a `tenantId` that each surface resolves
however it can, so every product running on our OpenRouter account shares **one** fairness model, **one**
cooldown, and **one** usage ledger. `admitTenant({ tenantId, leaseId, env, mode })` (a thin helper over
`TenantConcurrencyDO`) has **two call sites in this arc**: the webhook queue consumer and the hosted
`/v1/review` route. New surfaces hook the same primitives — no rebuild.

| Surface | Entry | `tenantId` | Per-tenant semaphore | Cooldown (PR B) | Metering (PR C) |
|---|---|---|---|---|---|
| GitHub PR review | webhook → queue | `installationId` (verified) | ✅ | ✅ | ✅ |
| `sigilix review` CLI — **Mode B** grounded (`--repo/--pr`) | `POST /v1/review` | `installationId` via `resolveInstallation` | ✅ | ✅ | ✅ |
| `sigilix review` CLI — **Mode A** diff (`--uncommitted`) | `POST /v1/review` | asserted `owner/repo` (best-effort; single shared key today) | best-effort, **plus** the existing `admitUnderDailyCeiling` hard guard | ✅ | ✅ |
| Empyrean agent grounding | `POST /v1/context` | `installationId` when resolvable | n/a (no ensemble to gate) | ✅ | optional usage row |
| Linear / CI triage, overviews | queue | `installationId` | optional (same DO) | ✅ | ✅ |

Notes:
- The cooldown (PR B) lives in the **model adapter**, so it shields *every* model call across *every*
  surface automatically — no per-surface wiring.
- `admitUnderDailyCeiling` (`api-review-route.ts:68`) **stays** as a complementary global cost guard on
  `/v1/review`; it is orthogonal to per-tenant fairness, not replaced by it.
- The CLI uses one shared API key today, so per-customer fairness on the CLI sharpens once per-customer
  keys land (SIG-243); until then Mode A is one logical tenant. We do **not** fabricate a tenant identity
  it doesn't have — Mode A leans on the daily ceiling + the account-wide cooldown.

## 5. Fairness algorithm (DeepSeek-verified)

- **Per-tenant cap** default 2; **global cap** = queue `max_concurrency` (5, pinned in wrangler.toml).
  Because per-tenant cap < global cap, ≥3 slots are always available to other tenants → no starvation.
- **Deny backoff** = exponential with decorrelated jitter, keyed on the lease's `denyCount`
  (reset on grant): `base = min(15s · 2^denyCount, 240s)`, `delay = base · (0.5 + rand())`. First deny
  ~7.5–22.5s (cheap quick-retry if a slot frees soon); escalates to ≤360s. A denied job does **not**
  hold a review slot — it is re-sent fast — so the consumer drains a burst head in milliseconds and
  reaches a quiet tenant's job in seconds.
- **Lease correctness:** idempotent `acquire` (duplicate `leaseId` / redelivery → no double-count),
  idempotent `release` (membership check), and no permanent leak — the reaper reclaims an expired lease
  only after the per-PR DO confirms the run is not active. Lease TTL = 25 min (watchdog 20 + 5 margin).

## 6. Provider backpressure (PR B — retry-layer separation)

The system has two retry sources today; a 429 must not compound them. Strict layering:

| Layer | Owns | On a 429 |
|---|---|---|
| Cloudflare Queue (`max_retries`) | **infra failures only** | not used |
| `PrReviewRunDO` backoff `[30s,90s,270s]` | non-429 transient failures | **not incremented** |
| `ProviderCooldownDO` + jitter | 429/503 backpressure | **the only layer that fires** |

On 429: the model adapter parses `Retry-After`, throws a typed `ProviderRateLimitError`; the consumer
sets the cooldown DO and re-`send()`s the job after a decorrelated-jittered delay — without touching the
DO retry counter. When cooldown expires, decorrelated jitter spreads resumes (no synchronized stampede).

## 7. Migrations & schema management (industry-standard, tracked)

Two migration systems, both **forward-only**, both **version-controlled**, applied **before** the code
that depends on them. This section is the **living ledger** — every migration is recorded here in order.

### 7.1 Durable-Object migrations (wrangler `[[migrations]]`)

- Sequential, immutable `tag`s in `wrangler.toml`, matching the repo's existing convention
  (`new_classes` for KV-backed DOs, `new_sqlite_classes` for SQLite-backed). Applied **automatically on
  `wrangler deploy`**; Cloudflare never runs them backward. The DO class MUST be exported from
  `src/index.ts` (near `:572-582`) or deploy fails.

### 7.2 D1 schema migrations (`wrangler d1 migrations`)

- `[[d1_databases]]` declares `migrations_dir = "migrations"`. Files are numbered + immutable:
  `migrations/0001_create_tenant_repo_usage.sql`. **D1 migrations do NOT auto-run on `wrangler deploy`.**
  They are applied explicitly, as a CI/CD step that runs **before** deploying the dependent code:
  ```bash
  wrangler d1 migrations apply sigilix-platform --local    # dev / tests
  wrangler d1 migrations apply sigilix-platform --remote   # prod (CI gate, pre-deploy)
  ```
  Wrangler tracks applied state in D1's internal `d1_migrations` table. **Never edit an applied
  migration** — to change schema, add the next numbered file. The DB is created once with
  `wrangler d1 create sigilix-platform`, then the `database_id` is pinned in `wrangler.toml`.

### 7.3 Migration ledger (update as each PR lands)

| Order | PR (ticket) | Kind | Tag / File | What it does | Apply |
|---|---|---|---|---|---|
| 1 | A (SIG-455) | DO | `tag = "sig-455-tenant-concurrency-v1"`, `new_classes=["TenantConcurrencyDO"]` | Registers the per-tenant semaphore DO | auto on deploy |
| 2 | B (SIG-455) | DO | `tag = "sig-455-provider-cooldown-v1"`, `new_classes=["ProviderCooldownDO"]` | Registers the shared cooldown DO | auto on deploy |
| 3 | C (SIG-343) | D1 | `migrations/0001_create_tenant_repo_usage.sql` | `tenant`, `repo`, `usage_ledger` tables + indexes | `wrangler d1 migrations apply` (pre-deploy) |
| 4 | D (SIG-543) | D1 | `migrations/0002_*.sql` (if shadow-quota needs an aggregate view/index) | quota-check read support | `wrangler d1 migrations apply` (pre-deploy) |
| 5 | sig-trial-cap | D1 | `migrations/0011_add_tenant_subscription_status.sql` | Adds `tenant.subscription_status` (trialing vs active) driving the half-volume trial cap; backfills existing paid tenants to `active` | `wrangler d1 migrations apply` (pre-deploy) |
| 6 | Stripe seat reconciliation | D1 | `migrations/0020_create_stripe_seat_reconciliation.sql` | Stripe seat snapshot, durable operation intent, and conditional reconciliation lease | `wrangler d1 migrations apply` (pre-deploy) |
| 7 | app-memory | D1 | `migrations/0021_create_app_memory.sql` | Adds installation-scoped personal and organization app-memory rows after Stripe reconciliation migration `0020` | `wrangler d1 migrations apply` (pre-deploy) |
| 8 | org workspace roles | D1 | `migrations/0022_create_org_workspace_access.sql` | Adds dark, exact-installation Sigilix membership roles, revocation tombstones, and durable mutation audit; no legacy rows are copied before rollout | `wrangler d1 migrations apply` (pre-deploy) |
| 9 | Stripe seat expansion | D1 | `migrations/0023_add_org_seat_billing_operation_context.sql` | Pins actor and target-role authorization context on every recoverable seat-billing operation while preserving nullable terminal history | `wrangler d1 migrations apply` (pre-deploy) |
| 10 | repository context foundation | D1 | `migrations/0024_create_repository_context.sql` | Adds provider-aware canonical repository snapshots, same-scope relationships, optimistic revisions, tombstones, and content-free immutable audit metadata | `wrangler d1 migrations apply` (pre-deploy) |
| 11 | immutable repository active index | D1 | `migrations/0025_create_repo_active_index_stage.sql` | Adds bounded full-run staging keyed by immutable GitHub repository id, with primary-arbitrated sealed publication, pinned rollout provenance, and expiry/uninstall cleanup indexes | `wrangler d1 migrations apply` (pre-deploy) |
| 12 | GitLab repository context authority | D1 | `migrations/0026_create_repository_context_authority.sql` | Adds strong D1 authority for GitLab canonical repository context, including generation-guarded pending claims, active repository scope, and stale-claim expiry lookup; KV remains credential/status storage rather than authorization | `wrangler d1 migrations apply` (pre-deploy) |
| 13 | Stripe Checkout attempt guard | D1 | `migrations/0027_create_billing_checkout_attempt.sql` | Adds one installation-scoped, expiring Checkout attempt with a persisted request body, Stripe idempotency key, lease generation, and ready-URL fence | `wrangler d1 migrations apply` (pre-deploy) |
| 14 | managed seat identity | D1 | `migrations/0028_create_org_workspace_seat_assignment.sql` | Adds exact-installation, immutable GitHub-user seat assignments and pins recoverable Stripe seat operations to either legacy-login or managed-GitHub identity | `wrangler d1 migrations apply` (pre-deploy) |
| 15 | immutable usage author identity | D1 | `migrations/0029_add_usage_author_github_identity.sql` | Adds nullable immutable GitHub-user attribution to PR-review usage while leaving historical login-only rows explicitly unresolved | `wrangler d1 migrations apply` (pre-deploy) |
| 16 | historical usage author attribution | D1 | `migrations/0030_backfill_usage_author_github_identity.sql` | Resolves the bounded pre-0029 usage backlog from exact GitHub PR metadata without inferring identity from mutable logins | `wrangler d1 migrations apply` (pre-deploy) |

> Rule: a PR that adds a DO bumps the `[[migrations]]` list (never reorders existing tags); a PR that
> touches D1 schema adds the next-numbered SQL file (never edits a prior one) and updates this ledger.

### 7.4 D1 initial schema (PR C — `0001_create_tenant_repo_usage.sql`)

```sql
CREATE TABLE tenant (
  installation_id  INTEGER PRIMARY KEY,
  tier             TEXT    NOT NULL DEFAULT 'default',
  concurrency_cap  INTEGER NOT NULL DEFAULT 2,
  daily_budget     INTEGER,                 -- nullable; quota is shadow-only in Phase 1
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE TABLE repo (
  repo_id          INTEGER PRIMARY KEY,     -- GitHub immutable repo.id
  installation_id  INTEGER NOT NULL REFERENCES tenant(installation_id),
  full_name        TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX idx_repo_installation ON repo(installation_id);
CREATE TABLE usage_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id  INTEGER NOT NULL,
  repo_id          INTEGER,
  pr_number        INTEGER,
  model_calls      INTEGER NOT NULL,
  tokens           INTEGER NOT NULL,
  created_at       TEXT    NOT NULL
);
CREATE INDEX idx_usage_tenant_time ON usage_ledger(installation_id, created_at);
```

> **Scale-up note (not Phase-1 work):** metering writes one row per *review* (~0.04 writes/s at global
> cap 5) — well within D1. If write volume later grows (per-model-call metering, higher concurrency),
> migrate the hot ledger to a SQLite-backed `UsageLedgerDO` with a Cron-trigger rollup into D1 for
> billing/dashboards (GLM's recommendation). D1 stays the queryable aggregate store.

## 8. Flags & config

- `SIGILIX_FAIRNESS_MODE = off | shadow | enforce` (default `shadow`). **shadow** = run `acquire()`,
  log desired-vs-actual, always GRANT. **enforce** = honor deny via `/defer`.
- `SIGILIX_TENANT_QUOTA_MODE = off | shadow | enforce` (default `shadow`; Phase 1 never goes `enforce`).
- `SIGILIX_TENANT_CONCURRENCY_CAP` default 2 (overridable per-tenant by the D1 `tenant.concurrency_cap`
  once PR C lands; before that, the env default).
- `max_concurrency = 5` pinned in `wrangler.toml [[queues.consumers]]` (moved off the dashboard).

## 9. Telemetry

- `fairness-decision` — `{ installationId, leaseId, desired: GRANT|DENY, actual, mode, inFlight, cap }`.
- `fairness-defer` — `{ installationId, runId, deferCount, backoffMs }`.
- `fairness-lease-reclaimed` — leaked-slot reaper events.
- `provider-cooldown-set` / `provider-cooldown-honored` — 429 backpressure (PR B).
- `usage-metered` — `{ installationId, repoId, prNumber, modelCalls, tokens }` (PR C).
- Validation before flipping to `enforce`: 24h of shadow logs showing we deny the right tenants under
  real bursts and never deny a lone tenant.

## 10. PR breakdown

- **PR A — Tenant fairness (SIG-455; the reliability win, ships alone).** `TenantConcurrencyDO` + lease/reaper;
  a shared **`admitTenant()`** helper wired at **two call sites** — the queue consumer (`src/index.ts queue()`,
  webhook, `tenantId=installationId`) and the hosted **`/v1/review`** route (Mode B `tenantId=installationId`
  via `resolveInstallation`; Mode A best-effort `owner/repo`, keeping `admitUnderDailyCeiling`); on deny in the
  queue path → `PrReviewRunDO./defer` + DO re-send (the `/v1/review` path returns 429-with-Retry-After since
  it's synchronous, no re-send); cap from env; `SIGILIX_FAIRNESS_MODE` (shadow default); pin `max_concurrency`
  in wrangler.toml; **no D1**.
  Tests: denial happens before `/pickup`; release on success/throw/blocked-pickup; lease idempotency;
  reaper reclaim only when per-PR DO inactive; deferred run not watchdog-failed; **`/v1/review` Mode B
  acquires/releases the same DO + still honors the daily ceiling**; fail-open on DO error (both call sites).
- **PR B — Provider backpressure (SIG-455).** Typed `ProviderRateLimitError` carrying `Retry-After` in the model
  adapter; jittered backoff policy; `ProviderCooldownDO`; retry-layer separation (§6).
- **PR C — D1 foundation + metering (SIG-343).** `wrangler d1 create` + binding + `migrations/0001`; `tenant`/`repo`
  lazy upsert; `usage_ledger` append from `finalize()` (best-effort, never blocks); per-tenant cap read
  from D1 with env fallback.
- **PR D — Shadow quotas + metrics (SIG-543).** Read D1 usage, compute would-exceed, log only (never refuse);
  per-tenant usage/fairness metrics endpoint.

Each PR: `npm run build` green, an end-to-end test through the real path, internal `code-reviewer` pass,
PR body carries `@sigilix ignore` + `@coderabbitai ignore`, founder merges.

## 11. Testing strategy

- Pure `domain/fairness.ts` — exhaustive unit tests with a fake clock (cap, backoff escalation/reset,
  starvation bound, lease lifecycle). No DO needed.
- DOs — `NodeSqliteStorage` / fake `DurableObjectState` shims (existing `test-shims/`); alarm-driven
  reaper + `/defer` re-send tested by triggering the alarm.
- D1 — `@miniflare/d1` (or a `prepare()` mock) for SQL syntax + the `finalize()` append.
- An e2e queue test proving: deny → `/defer` (not `message.retry`), per-PR DO not pickup'd, watchdog not
  tripped, and the job re-sent.

## 12. Risks & open questions

- **Watchdog/defer interaction** is the load-bearing change — PR A tests must prove a deferred run is
  never failed for waiting, and that `deferCount` caps an unbounded loop.
- **`max_retries` semantics** — confirm in a staging burst that re-`send()` (not `message.retry`)
  preserves the review under sustained denial (GLM's drop bug). Add a DLQ for genuine infra failures.
- **DO→DO reconciliation** in the reaper (`TenantConcurrencyDO → PrReviewRunDO /status`) must fail-safe:
  if the per-PR DO is unreachable, extend the lease (don't reclaim).
- **Cap source ordering** — before PR C, cap is env-only; after, D1 with env fallback. Ensure a missing
  D1 row never blocks (fail-open to env default).

## 13. Consult provenance

- **DeepSeek-v4-pro** (algorithm): proved the starvation bound, the exponential+decorrelated-jitter
  backoff, the lease/reaper correctness, and the retry-layer separation; confirmed WFQ is unnecessary
  at our scale.
- **GLM-5.2** (Cloudflare infra): caught that `message.retry()` would silently drop reviews (→ re-send),
  that D1 is wrong for hot appends (→ DO hot paths, D1 cold), that KV is too slow for cooldown (→ DO),
  and the migration-apply discipline (D1 not auto-applied).
- **Codex** (architecture, repo-grounded): the watchdog block-on (DO armed at enqueue), the exact
  admission seam (`src/index.ts queue()`), drop the storage `ports/` layer, meter from `finalize()`,
  lease-id-not-runId, pin `max_concurrency`, and the 4-PR split.
```
