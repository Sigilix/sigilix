import type { Env } from "@/src/shared/types/env"

export type FairnessConfig = {
  mode: "off" | "shadow" | "enforce"
  cap: number
}

/**
 * Resolves fairness mode and per-tenant concurrency cap from env.
 * Pure function — only reads the passed env object's string fields.
 * To disable fairness, set mode=off; there is no cap=0 lever.
 */
export function resolveFairnessConfig(
  env: Pick<Env, "SIGILIX_FAIRNESS_MODE" | "SIGILIX_TENANT_CONCURRENCY_CAP">,
): FairnessConfig {
  const mode =
    env.SIGILIX_FAIRNESS_MODE === "enforce" ? "enforce" : env.SIGILIX_FAIRNESS_MODE === "shadow" ? "shadow" : "off"

  const parsed = Number(env.SIGILIX_TENANT_CONCURRENCY_CAP)
  const cap = Number.isInteger(parsed) && parsed > 0 ? parsed : 2

  return { mode, cap }
}
