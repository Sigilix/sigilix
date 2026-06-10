// Port: the metric SINK surfaces the PR-review orchestrator pushes telemetry to.
// Two shapes, matching how the orchestrator emits today:
//
//   - validation / graph / graph-expansion — the orchestrator buffers events in
//     an array (`args.validationSink?.push(event)`) the Worker edge drains into
//     the DO after the run. These ports model that PUSH surface; an array
//     STRUCTURALLY satisfies `{ push(e): void }`, so the edge keeps passing a
//     plain array where the port is expected (PR 12 wiring).
//   - verification / runner-evidence — recorded inline via the metrics CLIENTS
//     (`recordVerificationMetricsBounded` / `recordRunnerEvidenceMetric`). These
//     ports model the RECORD surface over the DOMAIN-side arg.
//
// Types only; the event vocabulary comes from the `@/lib/ensemble/domain/metric-
// events` leaf. See the coupling note on `RecordVerificationArgs` /
// `RecordRunnerEvidenceArgs` below.

import type {
  ValidationRejectionEvent,
  GraphRetrievalSample,
  GraphExpansionSample,
} from "@/src/lib/ensemble/domain/metric-events"

// COUPLING NOTE (reported): the verification + runner-evidence record args live
// in the `@/do/*` DOs. After SIG-363 repointed `FindingTrustTier` onto the
// shared/domain leaf, `RecordVerificationArgs`'s closure is leaf-clean (its only
// remaining sibling reference is `VerificationVerdict`, a lib leaf), and
// `RecordRunnerEvidenceArgs` is primitive-only — so importing them type-only here
// is faithful. When these args are lifted to a domain leaf, the imports move with
// them; the port shapes stay the same.
import type { RecordVerificationArgs } from "@/src/do/verification-metrics"
import type { RecordRunnerEvidenceArgs } from "@/src/do/runner-evidence-metrics"

/** Buffer for validator-gate rejection + dismissal-reason events (SIG-119). */
export interface ValidationMetricsSink {
  push(event: ValidationRejectionEvent): void
}

/** Buffer for per-review graph-retrieval measurements (SIG-138). */
export interface GraphMetricsSink {
  push(sample: GraphRetrievalSample): void
}

/** Buffer for per-review graph-expansion (cross-file A/B) measurements (SIG-286). */
export interface GraphExpansionMetricsSink {
  push(sample: GraphExpansionSample): void
}

/** Records the review's verification verdict distribution (SIG-285 / Trust Ledger). */
export interface VerificationMetricsSink {
  record(args: RecordVerificationArgs): Promise<void> | void
}

/** Records the review's runner-evidence consume state (SIG-184). */
export interface RunnerEvidenceMetricsSink {
  record(args: RecordRunnerEvidenceArgs): Promise<void> | void
}
