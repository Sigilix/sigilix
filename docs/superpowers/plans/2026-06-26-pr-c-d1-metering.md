# PR C — D1 Foundation + Metering (SIG-343) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Stand up the `sigilix-platform` D1 (tenant / repo / usage_ledger), lazily register tenant+repo on the webhook path, append one usage row per review from `finalize()`, and let the per-tenant concurrency cap come from D1 with the env default as fallback — all **best-effort / fail-open** so D1 never blocks or fails a review.

**Architecture:** A single D1 (`sigilix-platform`, id `3b840a0e-e1b0-4cc7-9b8e-f06f7b4981b0`, created). The binding is **OPTIONAL** (`SIGILIX_PLATFORM_DB?: D1Database`) — mirrors `OPENCLAW_LEXICAL_INDEX`, so the code ships dark until the binding is deployed AND `wrangler d1 migrations apply` has run. Two thin IO adapters (Env passed directly, **no port** — repo convention). Forward-only D1 migration (`migrations/0001`), applied as a pre-deploy step (NOT auto on deploy).

**Tech Stack:** CF Worker (TS strict), D1 + `migrations/`, the existing `finalize()` choke point + `enqueuePrReviewJob`.

## Global Constraints
- Clean-arch: `@/` imports, barrel-only feature imports, files ≤1000 lines, co-located dot tests. Adapters take `Env` directly (no storage port — matches `concurrency-client.ts`).
- **Fail-open / recall-safe:** every D1 op no-ops (or returns a fallback) when the binding is absent OR any query throws (incl. table-missing before the migration is applied). A D1 fault must NEVER block, delay, or fail a review, and never change review output.
- **Migrations forward-only** (COMPLIANCE.md §8): `migrations/0001_create_tenant_repo_usage.sql` is immutable once applied; schema changes = the next numbered file. D1 migrations do NOT auto-apply on deploy — `wrangler d1 migrations apply sigilix-platform --remote` is a pre-deploy step (founder runs; I run `--local` for tests). Update the spec §7.3 ledger.
- Ships dark: until the binding is deployed + migrated, behavior is byte-identical to today (cap from env, no metering).

## File Structure
- `wrangler.toml` (MODIFY) — `[[d1_databases]] binding="SIGILIX_PLATFORM_DB" database_name="sigilix-platform" database_id="3b840a0e-e1b0-4cc7-9b8e-f06f7b4981b0" migrations_dir="migrations"`.
- `src/shared/types/env.ts` (MODIFY) — `SIGILIX_PLATFORM_DB?: D1Database` (optional, next to `OPENCLAW_LEXICAL_INDEX`).
- `migrations/0001_create_tenant_repo_usage.sql` (NEW) — the §7.4 schema verbatim (tenant, repo, usage_ledger + `idx_repo_installation`, `idx_usage_tenant_time`).
- `src/features/tenancy/adapters/d1-tenant-store.ts` (NEW) — `upsertTenantAndRepo(env, {installationId, repoId, fullName, nowIso})` (INSERT OR IGNORE tenant + UPSERT repo) + `readTenantCap(env, installationId): Promise<number | null>`. Both fail-open. + `.test.ts`.
- `src/features/tenancy/adapters/d1-usage-ledger.ts` (NEW) — `appendUsage(env, {installationId, repoId, prNumber, modelCalls, tokens, nowIso})` (INSERT one row). Fail-open. + `.test.ts`.
- `src/features/tenancy/index.ts` (MODIFY) — barrel-export the new adapter fns.
- `src/do/webhook-enqueue.ts` (MODIFY) — call `upsertTenantAndRepo` (best-effort, fire-and-forget) in `enqueuePrReviewJob` after the pause/ignore gate.
- `src/lib/ensemble/app/session.ts` (MODIFY) — in `finalize()`, append a usage row (best-effort, fire-and-forget) from the telemetry (modelCalls = Σ attemptsUsed, tokens = Σ token usage) when installationId/prNumber are known.
- Cap-read: a small async resolver `resolveTenantCap(env, installationId): Promise<number>` (D1 `readTenantCap` ?? `resolveFairnessConfig(env).cap`), used at the two admission sites (`src/index.ts queue()`, `src/lib/api-review-route.ts` Mode B). `resolveFairnessConfig` stays pure (env-only); the D1 read is layered at the call site.

## Tasks (TDD)
1. **Infra** — wrangler binding + optional env type + `migrations/0001` SQL; `wrangler d1 migrations apply sigilix-platform --local` succeeds; `wrangler deploy --dry-run` exit 0. (No app behavior yet.)
2. **`d1-tenant-store.ts`** — `upsertTenantAndRepo` (idempotent: INSERT OR IGNORE tenant; repo UPSERT on `repo_id`), `readTenantCap`. Fail-open: binding absent → no-op/null; thrown query → no-op/null. Tests via `@miniflare/d1` (or a `prepare()` mock matching repo test style — check how lexical-index/retrieval tests do D1).
3. **`d1-usage-ledger.ts`** — `appendUsage` one INSERT; fail-open; never throws. Tests.
4. **Lazy-upsert wiring** (`enqueuePrReviewJob`) — best-effort upsert; a D1 fault never affects the enqueue result. Test: upsert called with installationId/repoId/fullName; enqueue still succeeds when D1 throws.
5. **Usage-append wiring** (`finalize()`) — best-effort append with modelCalls/tokens from telemetry; never blocks/changes the finalize result. Test: appended on a posted review; finalize unaffected when D1 throws; skipped when installationId/prNumber absent.
6. **Cap-from-D1** — `resolveTenantCap` + wire at both admission sites; D1 cap honored when present, env fallback otherwise, env fallback on any D1 fault. Tests at both sites.
7. **Whole-branch** — `npm run build` green; dark by default (binding absent → byte-identical).

## Sign-off fixes — folded (GLM-5.2 GO-WITH-FIXES + Codex)

1. **Usage dedupe (GLM #1, refined):** `usage_ledger` gets `head_sha TEXT NOT NULL` + `UNIQUE(installation_id, repo_id, pr_number, head_sha)`; `appendUsage` uses `INSERT OR IGNORE`. This dedupes webhook redelivery / Worker retry of the SAME review (same pr+head) while still counting a legit re-review of a NEW commit (new head). `appendUsage` SKIPS when installationId/repoId/prNumber/headSha is absent (so it never collapses identity-less rows).
2. **Atomic tenant+repo (GLM #2):** one `db.batch([tenant, repo])`, tenant statement first → no orphan repo. `INSERT OR IGNORE INTO tenant` (preserves an operator-tuned `concurrency_cap`); `INSERT INTO repo ... ON CONFLICT(repo_id) DO UPDATE SET full_name=excluded.full_name, updated_at=excluded.updated_at` (refresh on every webhook — GLM #4).
3. **No lazy schema (Codex):** copy the `lexical-index` fail-open *shape* (try/catch → neutral / no-op) but DO NOT `ensureSchema`/CREATE lazily — the `migrations/0001` file is the only DDL; a missing table (pre-migrate) just throws → caught → no-op. (Skip GLM's optional schema-ready probe — fail-open already covers the brief pre-migrate window.)
4. **Tests use `src/test-shims/d1-sqlite-shim.ts`** (Node-sqlite D1 shim, already used by lexical-index tests) — apply `migrations/0001` to the shim DB in the test setup, then exercise the adapters.
5. **No cap cache (GLM #5):** `resolveTenantCap` reads D1 per admission, env fallback; no per-isolate TTL at this scale.
6. **finalize() seam:** `model_calls` = the `callsUsed` finalize already computes (Σ `specialistVerdicts.attemptsUsed` + `synthesizer.attemptsUsed`); `tokens` = Σ `telemetry.tokenUsageByModel`; append right after the existing `incrementDailyBudget(env, callsUsed).catch(()=>{})`, same best-effort shape. Thread `installationId`/`repoId`/`prNumber`/`headSha` onto `FinalizeTelemetry` if not already present (the build confirms which exist).

## Risks for sign-off (Codex + GLM-5.2)
1. **finalize() seam (Codex):** is `session.ts finalize()` the right single append point, and what telemetry fields give modelCalls + tokens? Is `installationId`/`prNumber`/`repoId` in scope there (or must they be threaded onto the telemetry)? Fire-and-forget via `ctx.waitUntil`/`backgroundWaitUntil` or awaited-best-effort?
2. **Lazy-upsert placement (Codex):** `enqueuePrReviewJob` vs the webhook handler — idempotent UPSERT shape; does repoId always exist there?
3. **Cap-read async layering (Codex):** adding an async D1 cap read to the admission hot path — acceptable? Keep `resolveFairnessConfig` pure + layer the D1 read at the call site, or make a new async resolver? Any per-request cache needed?
4. **D1 mechanics (GLM):** migration discipline (migrations_dir + apply-before-deploy, forward-only); INSERT OR IGNORE vs UPSERT for tenant/repo idempotency; the optional-binding + missing-table fail-open; write volume (~1 row/review) well within D1; index choice (`idx_usage_tenant_time`).
5. **Fail-open completeness (both):** enumerate every path (binding absent, table missing pre-migrate, query throw, partial write) → all degrade silently, never block a review.
