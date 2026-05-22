// SIG-152: thin typed wrappers for the single global GraphMetricsDO.
// Callers own the non-fatal try/catch (telemetry must never break a review).

import type { Env } from "../index"
import type { GraphMetricsDO, RecordSampleArgs, GraphMetricsQuery } from "../do/graph-metrics"

const GLOBAL_INSTANCE = "global"

function graphMetricsStub(env: Env): DurableObjectStub<GraphMetricsDO> {
  const ns = env.GRAPH_METRICS_DO as unknown as DurableObjectNamespace<GraphMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordGraphMetrics(env: Env, args: RecordSampleArgs): Promise<void> {
  await graphMetricsStub(env).recordSample(args)
}

export async function queryGraphMetrics(env: Env, windowDays: number): Promise<GraphMetricsQuery> {
  return graphMetricsStub(env).query({ windowDays })
}
