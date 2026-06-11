// SIG-285 PR 2: thin typed wrappers for the single global VerificationMetricsDO.
// Callers own the non-fatal try/catch (telemetry must never break a review).

import type { Env } from "@/src/shared/types/env"
import type {
  VerificationMetricsDO,
  RecordVerificationArgs,
  VerificationMetricsQuery,
} from "@/src/do/verification-metrics"

const GLOBAL_INSTANCE = "global"

function metricsStub(env: Env): DurableObjectStub<VerificationMetricsDO> {
  const ns = env.VERIFICATION_METRICS_DO as unknown as DurableObjectNamespace<VerificationMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordVerificationMetric(env: Env, args: RecordVerificationArgs): Promise<void> {
  await metricsStub(env).record(args)
}

/** Record a whole review's verdicts in one RPC/transaction. */
export async function recordVerificationMetrics(env: Env, items: RecordVerificationArgs[]): Promise<void> {
  await metricsStub(env).recordBatch(items)
}

/** Best-effort, time-bounded batch record: telemetry must never block or break a review.
 *  Resolves on success, on the {timeoutMs} race, OR on a DO throw — always swallowing. */
export async function recordVerificationMetricsBounded(
  env: Env,
  items: RecordVerificationArgs[],
  timeoutMs: number,
  log?: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  if (items.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      recordVerificationMetrics(env, items),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("verification-metric-timeout")), timeoutMs)
      }),
    ])
  } catch (err) {
    log?.("verification-metric-record-failed", { error: String(err) })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function queryVerificationMetrics(env: Env, windowDays: number): Promise<VerificationMetricsQuery> {
  // Direct return — the DO RPC already returns a Promise; a sync throw from
  // metricsStub still surfaces to the caller's try/catch around the await.
  return metricsStub(env).query({ windowDays })
}
