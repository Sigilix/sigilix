# PR D — Shadow Quotas + Usage Metrics (SIG-543) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** On the D1 foundation from PR C, (1) run a **shadow** per-tenant quota check — read recent usage, compare to `tenant.daily_budget`, emit a `quota-shadow` telemetry event, and **never refuse a review** — and (2) expose a token-authed **per-tenant usage metrics endpoint** reading `usage_ledger`. Precursor to hard enforcement (SIG-38).

**Architecture:** Mirror PR C's tenancy feature shape. A pure domain module (`quota.ts`: `resolveQuotaMode`, `computeWouldExceed`), one D1 read adapter (`d1-usage-read.ts`: per-tenant windowed sum + a GROUP BY rollup), the shadow check layered at the two admission sites next to `resolveTenantCap`, and a `/metrics/tenant-usage` route following the existing `metrics-*-route.ts` convention. All **fail-open**; ships **dark** (`SIGILIX_TENANT_QUOTA_MODE` default `shadow`, Phase 1 never `enforce`).

**Tech stack:** CF Worker (TS strict), D1 (`SIGILIX_PLATFORM_DB`), the existing admission sites + metrics-route + `auth-bearer` conventions.

## Global Constraints
- Clean-arch (COMPLIANCE.md): `@/` imports, barrel-only feature imports, files ≤1000 lines, co-located dot tests, domain pure (no Env/IO), adapters take `Env` directly. `npm run depcruise` = 0.
- **Fail-open / recall-safe:** every D1 read no-ops (returns neutral) when the binding is absent or any query throws. A quota read fault NEVER blocks/delays/refuses a review. **Phase 1 NEVER refuses** — `enforce` is not implemented for quota (mode is parsed but only `shadow` behavior exists; `enforce` logs a "would-refuse" but still proceeds — or is explicitly rejected at config. Decide in sign-off).
- **No new migration if avoidable:** `idx_usage_tenant_time(installation_id, created_at)` already supports the per-tenant windowed sum AND the rollup `GROUP BY installation_id`. Confirm no `0002` is needed (GLM).
- Ships dark: `SIGILIX_TENANT_QUOTA_MODE=off` (and `shadow` with no `daily_budget` set) is byte-identical to today.

## File structure
- `src/shared/types/env.ts` (MODIFY) — `SIGILIX_TENANT_QUOTA_MODE?: string` (next to the fairness/cooldown modes).
- `src/features/tenancy/domain/quota.ts` (NEW) — pure: `resolveQuotaMode(env): "off"|"shadow"|"enforce"` (default `shadow`); `computeWouldExceed(used: number, budget: number | null): boolean` (false when budget null/≤0). + `.test.ts`.
- `src/features/tenancy/adapters/d1-usage-read.ts` (NEW) — `readTenantUsageSince(env, installationId, sinceIso): Promise<{ modelCalls: number; tokens: number; reviews: number }>` (fail-open → zeros); `readUsageRollupSince(env, sinceIso, installationId?): Promise<TenantUsageRow[]>` (GROUP BY installation_id, fail-open → []). + `.test.ts` (d1-sqlite-shim).
- `src/features/tenancy/index.ts` (MODIFY) — barrel-export the new fns + `resolveQuotaMode`, `computeWouldExceed`, types.
- `src/features/tenancy/app/check-shadow-quota.ts` (NEW — or adapters/ if depcruise forbids app→adapters, per PR C Task 6) — `checkShadowQuota(env, installationId, daily_budget?)`: when mode≠off, read usage, compute wouldExceed, `console.log({event:"quota-shadow", ...})`; returns void; fail-open; NEVER throws/refuses. + `.test.ts`.
- `src/index.ts` queue() + `src/lib/api-review-route.ts` Mode B (MODIFY) — call `checkShadowQuota` right after `resolveTenantCap` (same admission point), gated on `resolveQuotaMode(env) !== "off"`. Best-effort; the cap read already fetched the tenant — see sign-off Q3 (combine reads vs separate).
- `src/lib/metrics-tenant-usage-route.ts` (NEW) — `handleTenantUsageMetricsRoute(request, env)`: bearer-auth via `requireBearerToken(request, env.OPENCLAW_VALIDATION_METRICS_TOKEN)`; `?days=` (default 30, max 90) + optional `?installationId=`; returns `{ window_days, tenants: TenantUsageRow[] }` from `readUsageRollupSince`. + `.test.ts`.
- `src/index.ts` (MODIFY) — import + register `GET /metrics/tenant-usage`.

## Tasks (TDD)
1. **Env + quota domain** — `SIGILIX_TENANT_QUOTA_MODE?` type; `quota.ts` (`resolveQuotaMode` default shadow, off/shadow/enforce; `computeWouldExceed` budget-null/≤0 → false). Pure unit tests. depcruise 0.
2. **`d1-usage-read.ts`** — `readTenantUsageSince` (`SELECT SUM(model_calls) AS modelCalls, SUM(tokens) AS tokens, COUNT(*) AS reviews FROM usage_ledger WHERE installation_id=? AND created_at>=?`), fail-open → zeros; `readUsageRollupSince` (`... GROUP BY installation_id`, join `tenant` for account_login/type, optional installationId filter), fail-open → []. Tests via d1-sqlite-shim + migrations/0001.
3. **`check-shadow-quota.ts`** — reads usage, computes wouldExceed vs the tenant's `daily_budget`, logs `quota-shadow`; never refuses/throws; no-op when mode off or budget unset. Tests: logs would-exceed when over; logs under when below; no-op when off / budget null; fail-open when D1 throws.
4. **Wire admission** — call `checkShadowQuota` at queue() + Mode B after `resolveTenantCap` (needs the tenant's `daily_budget`; `readTenantCap` currently returns only the cap — extend to read budget too, or a small combined read — sign-off Q3). Tests at both sites: shadow log emitted, review ALWAYS proceeds.
5. **Metrics endpoint** — `metrics-tenant-usage-route.ts` + register `GET /metrics/tenant-usage`. Tests: 401 without token; rollup shape with token; `?installationId=` filter; `?days=` window + clamp; empty/`[]` when binding absent (fail-open).
6. **Whole-branch** — `npm run build` green; dark by default (mode off / no budget → byte-identical); PR (`@coderabbitai ignore`, "Part of SIG-543 / SIG-455").

## Open design decisions (sign-off must resolve)
1. **Budget unit (Codex/GLM):** `daily_budget` = max **model_calls** / rolling 24h (proposed — matches the metered cap-like metric, simplest) vs tokens vs cost. The shadow log carries all three so the unit can change later.
2. **Window (GLM):** rolling 24h via ISO-string compare (`created_at >= <now-86400s ISO>`; `created_at` is ISO TEXT, lexicographically ordered) — proposed. vs calendar-day UTC. Rolling avoids TZ/midnight reset complexity.
3. **Admission read shape (Codex):** the shadow check needs `daily_budget`; `resolveTenantCap` already reads the tenant row for `concurrency_cap`. Combine into one `readTenantRow` (cap + budget) to avoid a second round-trip, or keep two fail-open reads? Proposed: one combined `readTenantConfig(env, id): {cap, dailyBudget}` reused by both `resolveTenantCap` and the quota check (one D1 read per admission).
4. **`enforce` mode (Codex):** Phase 1 never refuses. Options: (a) parse `enforce` but treat it as shadow + a louder "would-refuse" log (forward-compat, no refusal); (b) reject `enforce` at config with a warn (can't accidentally enable). Proposed: (a) — log `quota-would-refuse` but proceed, so the eventual SIG-38 only flips the proceed→refuse.
5. **Metrics endpoint surface (Codex):** path `/metrics/tenant-usage`, shared `OPENCLAW_VALIDATION_METRICS_TOKEN`, GROUP BY rollup. Author-level breakdown (PR C added `author_login`) deferred to a `?groupBy=author` follow-up. Confirm shape + that the rollup query is bounded (D1 GROUP BY over ~0.04 rows/s is trivial).
6. **No migration:** confirm `idx_usage_tenant_time` covers both the per-tenant windowed sum and the GROUP BY rollup (no `0002`).

## Sign-off fixes — folded (Codex + GLM-5.2, both GO-WITH-FIXES)

**Window comparison — RECONCILED (Codex over GLM):** use plain `created_at >= ?` (bind `?` = the since ISO string), NOT `unixepoch(created_at) >= unixepoch(?)`. GLM flagged ISO-string drift, but wrapping the indexed column in `unixepoch()` defeats the `(installation_id, created_at)` index range scan, and EVERY write goes through `new Date().toISOString()` (always canonical 24-char `.sssZ` UTC), so a plain string range compare is correct AND index-friendly. **Add a comment documenting the canonical-writer invariant**, and a test using canonical timestamps.

1. **Empty-set vs fault (MUST — GLM #2 + Codex refinement):** `COALESCE(SUM(model_calls), 0)` / `COALESCE(SUM(tokens), 0)` (bare SUM over 0 rows → NULL). BUT a genuine-empty result (zeros) must be distinguishable from a D1 **fault**: `readTenantUsageSince` returns `{ ok: true, modelCalls, tokens, reviews }` on success (incl. true-empty → zeros) and `{ ok: false }` on any error. `checkShadowQuota` emits `quota-shadow` ONLY when `ok`; on `!ok` it logs `quota-read-failed` (or no-ops) — NEVER a fake under-budget zero.
2. **Defer shadow read (MUST — GLM #3):** run `checkShadowQuota` via `ctx.waitUntil(...)` so its usage read never adds admission latency (advisory + never refuses). Queue has `ctx` (PR C). Mode B: use the route's ctx if available else fire-and-forget — never block the response. **Forward-note:** when SIG-38 flips to enforce, move back onto the sync path with an explicit fail-open-vs-fail-closed policy.
3. **Quota independent of fairness (MUST — Codex):** the quota shadow check has its OWN gate `resolveQuotaMode(env) !== "off"` — it must NOT be nested under `fairnessMode !== "off"` and must NOT require `runId` (runId-absent slash-rerun reviews are still measured). Wire it at BOTH admission sites (queue `src/index.ts`, Mode B `api-review-route.ts`) as a separate concern from fairness.
4. **Combined tenant read (Codex Q3):** add `readTenantConfig(env, id): Promise<{ cap: number|null; dailyBudget: number|null } | null>` (one row read) + `resolveTenantConfig(env, id)` returning effective cap + nullable budget; keep `resolveTenantCap()` as a thin wrapper over it (no behavior change). `checkShadowQuota` uses `readTenantConfig` for the budget.
5. **`enforce` mode = log-would-refuse, still proceeds (Codex Q4 / option A):** `resolveQuotaMode` parses `off|shadow|enforce`; Phase 1 `enforce` logs `quota-would-refuse` but the review STILL proceeds (so SIG-38 only flips proceed→refuse). Pin in tests: both shadow AND enforce proceed.
6. **Metrics route (Codex Q5):** `LEFT JOIN tenant` for account_login/type; validate `installationId` as a positive integer; clamp the window; match the existing metrics-route auth behavior (`requireBearerToken` → 401, the 503 shape) and the existing window param name used by `metrics-fp-rate-route.ts` (`?window=`/days; `?days=` alias optional). Author-level breakdown is OUT of scope (deferred to `?groupBy=author` later).
7. **Budget unit + no migration (both confirmed):** `daily_budget` = model_calls per rolling 24h (documented in a comment; shadow log still carries tokens+reviews). No `0002` — `idx_usage_tenant_time` covers the per-tenant windowed SUM (range scan) and the GROUP BY rollup (ordered index scan) at this volume. A `(created_at, installation_id)` index is a later-with-evidence optimization only.

**Mandatory test matrix (Codex):** both admission sites proceed in `shadow` AND `enforce`; fairness `off` still runs the quota shadow; a runId-absent queue review IS measured; a D1 fault on the quota path proceeds (no fake zero, no throw); metrics auth (401) + `installationId` filter + window clamp all work.

**Scope creep to REJECT (Codex):** hard enforcement, author breakdown, token/cost budgeting, any new migration/index, any new DO/queue, ports/app-layer refactor.

## Risks
- **Extra admission latency** (Q3) — fold cap+budget into one read; the shadow check itself stays off the response path if it can run via `ctx.waitUntil` at the queue site (Mode B is sync — log inline, it's one cheap D1 read; or skip the sync-path shadow log if latency-sensitive).
- **Fail-open completeness** — every quota path (binding absent, table missing, query throw) → no log + proceed; never affects a review or the endpoint (→ `[]`/zeros).
- **Recall-safety** — quota is shadow; a review is NEVER refused, dropped, or delayed by quota in Phase 1.
