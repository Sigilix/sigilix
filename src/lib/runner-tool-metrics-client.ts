// SIG-107: thin typed wrappers for the single global RunnerToolMetricsDO.
// Callers own the non-fatal try/catch; tool telemetry must never break ingest.

import type { Env } from "@/src/shared/types/env"
import type {
  RecordRunnerToolManifestArgs,
  RunnerToolMetricsDO,
  RunnerToolMetricsQuery,
} from "@/src/do/runner-tool-metrics"

const GLOBAL_INSTANCE = "global"

function metricsStub(env: Env): DurableObjectStub<RunnerToolMetricsDO> {
  const ns = env.RUNNER_TOOL_METRICS_DO as unknown as DurableObjectNamespace<RunnerToolMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordRunnerToolManifestMetric(env: Env, args: RecordRunnerToolManifestArgs): Promise<void> {
  await metricsStub(env).recordManifest(args)
}

export function queryRunnerToolMetrics(env: Env, windowDays: number): Promise<RunnerToolMetricsQuery> {
  return metricsStub(env).query({ windowDays })
}
