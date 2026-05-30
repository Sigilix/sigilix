// SIG-285 PR 2: thin typed wrappers for the single global VerificationMetricsDO.
// Callers own the non-fatal try/catch (telemetry must never break a review).

import type { Env } from "../index"
import type {
  VerificationMetricsDO,
  RecordVerificationArgs,
  VerificationMetricsQuery,
} from "../do/verification-metrics"

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

export function queryVerificationMetrics(env: Env, windowDays: number): Promise<VerificationMetricsQuery> {
  // Direct return — the DO RPC already returns a Promise; a sync throw from
  // metricsStub still surfaces to the caller's try/catch around the await.
  return metricsStub(env).query({ windowDays })
}
