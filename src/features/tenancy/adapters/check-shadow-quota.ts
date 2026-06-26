// SIG-543 PR D Task 3 — shadow quota orchestration (adapter layer).
//
// Best-effort, never-throws: the whole body is wrapped in try/catch and
// any exception is silently swallowed so a DB hiccup never blocks the
// review path.  The caller also gates on mode !== "off", but we check
// defensively here too.
//
// Log contract (all events are JSON-on-one-line via console.log):
//   quota-read-failed  — D1 read fault; never emit a fake under-budget event.
//   quota-shadow       — normal telemetry; always emitted when usage is readable
//                        and the tenant has a daily_budget set.
//   quota-would-refuse — forward-compat signal for enforcement (SIG-38);
//                        emitted ONLY when mode==="enforce" && wouldExceed.
//                        Phase 1 NEVER actually refuses; function still returns void.

import type { Env } from "@/src/shared/types/env"
import { resolveQuotaMode, computeWouldExceed } from "@/src/features/tenancy/domain/quota"
import { readTenantConfig } from "@/src/features/tenancy/adapters/d1-tenant-store"
import { readTenantUsageSince } from "@/src/features/tenancy/adapters/d1-usage-read"

/**
 * Shadow-quota check for a single tenant (rolling 24 h window).
 *
 * Best-effort and never-throws.  Emits structured JSON events via console.log
 * for telemetry; never mutates state, never refuses the request.
 *
 * Phase 1 contract: observation-only.  Enforcement (returning an error) is
 * wired in Task 4 / SIG-38; this function always resolves void regardless of
 * the `wouldExceed` value.
 */
export async function checkShadowQuota(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_TENANT_QUOTA_MODE">,
  installationId: number,
): Promise<void> {
  try {
    // 1. Defensive no-op for mode=off (caller also gates, but cheap to double-check).
    const mode = resolveQuotaMode(env)
    if (mode === "off") return

    // 2. Read per-tenant config.  No daily_budget → tenant is not quota-tracked.
    const cfg = await readTenantConfig(env, installationId)
    if (cfg?.dailyBudget == null) return

    // 3. Rolling 24-hour window.
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const usage = await readTenantUsageSince(env, installationId, sinceIso)

    // 4. Read fault — emit a fault event and bail; never emit a fake quota state.
    if (!usage.ok) {
      console.log(JSON.stringify({ event: "quota-read-failed", installationId, mode }))
      return
    }

    // 5. Budget check.
    const wouldExceed = computeWouldExceed(usage.modelCalls, cfg.dailyBudget)

    // 6. Shadow telemetry — always emitted when usage is readable and budget is set.
    console.log(
      JSON.stringify({
        event: "quota-shadow",
        installationId,
        mode,
        usedModelCalls: usage.modelCalls,
        usedTokens: usage.tokens,
        reviews: usage.reviews,
        budget: cfg.dailyBudget,
        wouldExceed,
      }),
    )

    // 7. Forward-compat enforcement signal (phase 1 never actually refuses).
    if (mode === "enforce" && wouldExceed) {
      console.log(
        JSON.stringify({
          event: "quota-would-refuse",
          installationId,
          usedModelCalls: usage.modelCalls,
          budget: cfg.dailyBudget,
        }),
      )
    }
  } catch {
    // Best-effort: swallow all errors so the caller is never blocked.
  }
}
