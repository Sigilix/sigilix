// Barrel: the PR-review ensemble's port surface (SIG-318 / SIG-358). Consumers
// import the seam interfaces from `@/lib/ensemble/ports`; adapters (PR 10/11)
// implement them. Type-only — every export is `export type` (verbatimModuleSyntax).
//
// Dependency rule: a `ports/*` file imports ONLY from `@/lib/ensemble/domain/*`,
// `@/shared/*`, and `@/shared/types/github` — never outward (no adapter, no
// concrete client, no `triage-pr-review*` sibling, no value code). The one
// concession (SIG-363): a few ports take a TYPE-ONLY import of a PURE
// contract type that still lives in a `@/lib/*` or `@/do/*` sibling (e.g.
// `ReviewManifestFinding`, `Record{Verification,RunnerEvidence}Args`), each
// flagged with a COUPLING NOTE in its file — to be repointed when that type is
// lifted to a leaf. No value code or god-file import ever crosses the boundary.

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

export type { RetrievalPort, RetrievedChunk, CorpusHit, MultiCorpusResult } from "./retrieval"

export type { RunnerReceiptPort, RunnerEvidenceState } from "./runner-receipt"

export type { ClockPort } from "./clock"

export type { GraphPort } from "./graph"

export type { EnsemblePersistencePort, EnsembleTelemetrySummary } from "./persistence"

// SIG-363: the graph READ port + the persistence obligations + the metric SINK
// ports landed here. The sink ports take the DOMAIN event vocabulary
// (`@/lib/ensemble/domain/metric-events`); the `FindingCategory` /
// `FindingTrustTier` references that used to reach the `triage-pr-review`
// god-file were lifted onto the shared/domain leaves, so NO `ports/*` file
// touches a god-file or any value code (the only outward refs are the
// type-only coupling-note exceptions above).
export type {
  ValidationMetricsSink,
  GraphMetricsSink,
  GraphExpansionMetricsSink,
  VerificationMetricsSink,
  RunnerEvidenceMetricsSink,
} from "./sinks"
