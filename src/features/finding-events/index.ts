// SIG-606 — finding event log: durable, append-only per-candidate outcome
// instrumentation. Public surface of the feature (barrel-only imports per
// COMPLIANCE.md).

export { reconcileFindingOutcomes } from "./domain/reconcile"
export type {
  FindingEvent,
  FindingEventDraft,
  FindingEventStage,
  FindingOutcome,
  PostedFindingRecord,
  PostedSurface,
} from "./domain/types"
export { appendFindingEvents } from "./adapters/d1-finding-event-log"
export type { FindingEventReviewIdentity } from "./adapters/d1-finding-event-log"
