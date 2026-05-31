// SIG-286 PR2.5: thin typed wrappers for the single global GraphExpansionMetricsDO.
// Callers own the non-fatal try/catch (telemetry must never break a review).

import type { Env } from "../index"
import type {
  GraphExpansionMetricsDO,
  RecordExpansionSampleArgs,
  GraphExpansionMetricsQuery,
} from "../do/graph-expansion-metrics"

const GLOBAL_INSTANCE = "global"

function graphExpansionMetricsStub(env: Env): DurableObjectStub<GraphExpansionMetricsDO> {
  const ns = env.GRAPH_EXPANSION_METRICS_DO as unknown as DurableObjectNamespace<GraphExpansionMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordGraphExpansionMetrics(env: Env, args: RecordExpansionSampleArgs): Promise<void> {
  await graphExpansionMetricsStub(env).recordSample(args)
}

export async function queryGraphExpansionMetrics(env: Env, windowDays: number): Promise<GraphExpansionMetricsQuery> {
  return graphExpansionMetricsStub(env).query({ windowDays })
}
