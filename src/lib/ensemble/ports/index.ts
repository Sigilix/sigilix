// Barrel: the PR-review ensemble's port surface (SIG-318 / SIG-358). Consumers
// import the seam interfaces from `@/lib/ensemble/ports`; adapters (PR 10/11)
// implement them. Type-only — every export is `export type` (verbatimModuleSyntax).
//
// Dependency rule: a `ports/*` file imports ONLY from `@/lib/ensemble/domain/*`,
// `@/shared/*`, and `@/shared/types/github` — never outward (no adapter, no
// concrete client, no `triage-pr-review*` sibling, no value code).

export type {
  ModelProviderPort,
  GenerateArgs,
  GenerateResult,
  ChatArgs,
  ChatResult,
  ChatMessage,
  ChatToolDef,
  ToolCall,
  LlmUsage,
  EmbeddingPort,
  AiBinding,
} from "./model"

export type { GitHubPort } from "./github"

export type { ReviewSinkPort } from "./review-sink"

export type {
  RetrievalPort,
  RetrievedChunk,
  CorpusHit,
  MultiCorpusResult,
} from "./retrieval"

export type { RunnerReceiptPort, RunnerEvidenceState } from "./runner-receipt"

export type { ClockPort } from "./clock"

// DEFERRED to PR 11 (SIG-363, which owns the graph + persistence adapters):
//   - GraphPort           — its payload types (GraphContextNode/Expansion + the
//                           definition/caller/import row types) live in the
//                           `@/do/repo-graph` infra layer; defining the port
//                           cleanly means extracting those contract types to a
//                           leaf first (done alongside the graph adapter), not an
//                           outward `@/do/*` import from a port.
//   - the metric SINK ports (validation / verification / graph / graph-expansion /
//                           runner-evidence) — these must take a *domain event*,
//                           not the DO's `Record*Args` (whose types transitively
//                           reach `triage-pr-review`'s `FindingTrustTier` /
//                           `FindingCategory`). The domain event types are
//                           extracted with the PR-8 believability core (which
//                           consumes `ValidationRejectionEvent` via an injected
//                           callback) + the `FindingTrustTier`→shared/domain lift.
// The pure domain core (PR 8/9) depends on NONE of the deferred ports, so pulling
// these later blocks nothing — and keeps every `ports/*` file strictly inward-only.
