// SIG-119: thin typed wrappers for the single global ValidationMetricsDO.
// Resolves the fixed DO stub and forwards record/query RPCs. Callers own the
// non-fatal try/catch (telemetry must never break a review or a request).

import type { Env } from "../index"
import type {
  ValidationMetricsDO,
  RecordBatchArgs,
  ValidationMetricsQuery,
} from "../do/validation-metrics"

// All validator telemetry funnels into ONE DO instance — write volume is one
// row per rejected finding, nowhere near a sharding threshold.
const GLOBAL_INSTANCE = "global"

function metricsStub(env: Env): DurableObjectStub<ValidationMetricsDO> {
  const ns = env.VALIDATION_METRICS_DO as unknown as DurableObjectNamespace<ValidationMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordValidationMetrics(env: Env, args: RecordBatchArgs): Promise<void> {
  await metricsStub(env).recordBatch(args)
}

export async function queryValidationMetrics(
  env: Env,
  windowDays: number,
): Promise<ValidationMetricsQuery> {
  return metricsStub(env).query({ windowDays })
}
