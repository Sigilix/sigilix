// SIG-184 PR 5b: thin typed wrappers for the single global
// RunnerEvidenceMetricsDO. Resolves the fixed DO stub and forwards record/query
// RPCs. Callers own the non-fatal try/catch (telemetry must never break a
// review or a request).

import type { Env } from "../index"
import type {
  RunnerEvidenceMetricsDO,
  RecordRunnerEvidenceArgs,
  RunnerEvidenceMetricsQuery,
} from "../do/runner-evidence-metrics"

// All runner-evidence telemetry funnels into ONE DO instance — one increment
// per review, nowhere near a sharding threshold.
const GLOBAL_INSTANCE = "global"

function metricsStub(env: Env): DurableObjectStub<RunnerEvidenceMetricsDO> {
  const ns = env.RUNNER_EVIDENCE_METRICS_DO as unknown as DurableObjectNamespace<RunnerEvidenceMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordRunnerEvidenceMetric(env: Env, args: RecordRunnerEvidenceArgs): Promise<void> {
  await metricsStub(env).record(args)
}

export function queryRunnerEvidenceMetrics(
  env: Env,
  windowDays: number,
): Promise<RunnerEvidenceMetricsQuery> {
  // Direct return — the DO RPC already returns a Promise; wrapping in `async`
  // would only add a microtask hop. A sync throw from `metricsStub` still
  // surfaces to the caller's try/catch around the awaited call site.
  return metricsStub(env).query({ windowDays })
}
