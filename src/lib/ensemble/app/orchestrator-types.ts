// SIG-318 (PR 12h) — the orchestrator's two type contracts (`EnsembleHandlerArgs`,
// the public handler-args interface; and `EnsembleTelemetry`, the orchestrator-
// private run-record interface), split into their own leaf so `app/orchestrator.ts`
// stays under the 1k-line cap (the consistently-respected SIG-318 file-size
// invariant). Both moved VERBATIM from the god-file (only the import-path prefixes
// change). ZERO behavior change.
//
// `EnsembleHandlerArgs` is part of the public surface (tests import it through the
// `triage-pr-review-ensemble` shim) — re-exported from `app/orchestrator` (which
// re-exports it from here) so the surface is byte-identical.
//
// `EnsembleTelemetry` is orchestrator-private: NOT exported from the shim, and
// nothing outside the orchestrator consumes it — the persistence port / SLO leaf
// read the decoupled `EnsembleTelemetrySummary` slice instead. Its only consumers
// are the `telemetry` skeleton the orchestrator builds and the
// `EnsembleResult = EnsembleResultBase<EnsembleTelemetry>` binding. It is kept out
// of `app/session.ts` deliberately — session is generic over the telemetry type
// (the `Tel` parameter) precisely so it never names this concrete shape.
//
// Dependency rule: a pure type leaf — every name imports from its canonical NON-shim
// home (the env / ensemble-router / incremental-review / review-memory lib leaves,
// the findings / validation / synth / config domains, the slo / retrieval-cache
// leaves, the @/shared + @/do + @/features homes, and the inline
// `import("../../dynamic-dispatcher")`). It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole, RouterDecision } from "@/src/lib/ensemble-router"
import type { RetrievalCacheStats } from "@/src/lib/retrieval-cache"
import type { DeterministicCheckHit } from "@/src/shared/domain/deterministic-checks"
import type { DiffMode } from "@/src/lib/incremental-review"
import type { ScanSkipReason as DepVulnSkipReason } from "@/src/features/dep-vulns"
import type { ScanSkipReason as SarifSkipReason } from "@/src/features/sarif-evidence"
import type { ReviewMemorySkipReason } from "@/src/lib/review-memory/types"
import type { TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"
import type { LogicInputComposition } from "@/src/lib/ensemble/domain/logic-input-composition"
import type { PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import type { SynthAttemptOutcome } from "@/src/lib/ensemble/domain/synth"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { ValidationRejectionEvent } from "@/src/do/validation-metrics"
import type { GraphRetrievalSample } from "@/src/do/graph-metrics"
import type { GraphExpansionSample } from "@/src/do/graph-expansion-metrics"
import type { ReviewStatusReporter } from "@/src/lib/pr-review-status-reporter"
// SIG-386 (PR1): the concrete `EnsembleResult = EnsembleResultBase<EnsembleTelemetry>`
// binding moved here from the orchestrator to land that file at <=1k lines. This is
// `EnsembleTelemetry`'s natural co-location (the binding is one of its two named
// consumers, per the header note above). Acyclic: `session.ts` never imports this
// leaf. The orchestrator re-exports `EnsembleResult` so its public surface is
// byte-identical.
import type { EnsembleResult as EnsembleResultBase } from "./session"

export interface EnsembleHandlerArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
  /**
   * SIG-318 (PR 5a): the typed, parse-once ensemble settings, produced at the
   * Worker edge (`parseEnsembleConfig(env)` in src/index.ts) and injected here so
   * the handler reads config instead of `env.OPENCLAW_*`. Optional: when omitted
   * (tests / non-edge callers) the handler falls back to parsing `env` itself — a
   * transitional safety net removed when the orchestrator is thinned (PR 12).
   */
  ensembleConfig?: EnsembleConfig
  /**
   * ARC-251: prior stale-head requeue depth, threaded through by the
   * dispatcher from the JobMessage. Undefined = 0. Forwarded to
   * `handleStaleHead` when either ensemble guard fires.
   */
  staleHeadRequeueDepth?: number
  /**
   * SIG-119: the dispatcher's mutable telemetry sink. Each evidence-gate
   * callback (security/tests/logic/perf `on*FindingDropped`) pushes a
   * {gate, reason, dropped} event here; the dispatcher flushes it once to
   * ValidationMetricsDO after the review. Optional so non-dispatcher callers
   * (tests) can omit it.
   */
  validationSink?: ValidationRejectionEvent[]
  /**
   * SIG-152: dispatcher's single-sample sink for the per-review
   * `pr-review-graph-retrieval` telemetry. The graph block pushes one sample
   * (0 elements if graph retrieval is off / errored); flushed to
   * GraphMetricsDO in the dispatcher's finally. Optional for non-dispatcher
   * callers (tests).
   */
  graphMetricsSink?: GraphRetrievalSample[]
  /**
   * SIG-286 PR2.5: the graph-context-expansion block pushes one
   * `graph-expansion-shadow` sample here (0 elements if expansion is off /
   * errored); flushed to GraphExpansionMetricsDO in the dispatcher's finally so
   * the CONTROL-vs-TREATMENT netNewTokens median is readable at
   * GET /metrics/graph-expansion. Optional for non-dispatcher callers (tests).
   */
  graphExpansionMetricsSink?: GraphExpansionSample[]
  /** Optional Worker lifetime hook for telemetry-only background work. */
  backgroundWaitUntil?: (promise: Promise<void>) => void
  /** Optional sticky overview status reporter for DO-routed review runs. */
  statusReporter?: ReviewStatusReporter
  /**
   * SIG-247 Phase 1: GitHub's immutable `repo.id`, threaded from
   * the webhook payload via JobMessage → baseArgs → here. Passed
   * to `runReviewMemoryLookup` so it reads BOTH the legacy and
   * repo-id keyspaces with read-union semantics. Absent on legacy
   * queue messages and slash-command raw-sends pre-SIG-247 Phase 1;
   * the lookup falls back to legacy-only reads.
   */
  repoId?: number
  /**
   * VERIFIED unlock Phase 2: when true, force the review NON-INCREMENTAL
   * (full coverage of every changed file) regardless of
   * `OPENCLAW_INCREMENTAL_REVIEW_MODE`. Set only on the runner-receipt-ingest
   * re-review, which runs on the SAME headSha the webhook review already
   * covered — an incremental pass would have an empty delta and risk the
   * SIG-459 false-APPROVE regression. Threaded JobMessage → baseArgs → here →
   * `packAndRoute` (where it overrides the incremental coverage mode to
   * "off"). Absent on all other enqueue paths.
   */
  forceFullCoverage?: boolean
  /**
   * SIG-304 (review CLI): a pre-built GitHubClient injected by a headless/Node
   * caller. When present, the orchestrator uses it instead of `buildClient(env,
   * installationId)` (skips the GitHub-App id/key + KV-token cache). Absent on every
   * prod/Worker path → byte-identical behavior.
   */
  githubClient?: GitHubClient
  /**
   * SIG-304 (review CLI): headless dry-run. When true the orchestrator runs the full
   * review pipeline but performs NO side effects — no posting, no requeue, no
   * merge-on-approve, no skip-notice, no publish — and returns the built review on
   * `EnsembleResult.dryRunReview`. The stale-head / merged-on-approve short-circuits
   * are skipped (a local diff is authoritative). Absent on every prod path. NOTE
   * (Codex): do NOT also pass `statusReporter` in dry-run — it patches an overview
   * comment via its own client; the CLI/local-env path never supplies one.
   */
  dryRun?: boolean
}

export interface EnsembleTelemetry {
  schemaVersion: 3
  owner: string
  repo: string
  prNumber: number
  headSha: string
  mode: "shadow" | "post"
  fellBackToPhase3: boolean
  fellBackReason?: string
  internalError?: string
  routerDecision: RouterDecision | null
  /**
   * SIG-227a: when `OPENCLAW_DYNAMIC_DISPATCHER_MODE === "enforce_rules"`,
   * `routerDecision` above is overwritten with the dispatcher's picks
   * because those drive fan-out. The legacy `decideSpecialists` result
   * is preserved here so `/metrics/validation` can compute
   * "would-have-been-fanned-out vs actually-fanned-out" deltas across
   * the enforce_rules window. Absent when mode is `off`/`shadow`/`enforce`
   * (only `enforce_rules` does the routerDecision swap).
   */
  legacyRouterDecision?: RouterDecision
  /**
   * SIG-226 / SIG-224 Phase 1: shadow-mode dispatcher decision blob.
   * Populated only when `OPENCLAW_DYNAMIC_DISPATCHER_MODE` is set to
   * `shadow` or `enforce`. Always absent in default-off mode so the
   * existing telemetry consumers don't see noise.
   *
   * Held on the telemetry object (rather than just `console.log`-ed)
   * so the existing KV-backed metrics endpoints (`/metrics/validation`,
   * `/metrics/graph`) can compute shadow-window stats — p50/p95/p99
   * dispatcher overhead, per-role agreement rates between rule layer
   * and LLM, false-negative rates on protected roles. Phase 2/3
   * graduation criteria depend on these aggregates.
   */
  dispatcherDecision?: import("@/src/lib/dynamic-dispatcher").DispatcherDecision
  /**
   * ARC-277: populated when 1 ≤ specialist-success-count < dispatched-count.
   * Records which roles came back and which didn't so post-rollout
   * telemetry analysis can compute degraded-vs-full-coverage rates
   * per specialist + per repo. Absent when full coverage (synth ran
   * with everything) AND when fully empty (synth never ran).
   */
  degradedCoverage?: {
    rolesReturned: SpecialistRole[]
    rolesMissing: SpecialistRole[]
  }
  /**
   * ARC-278: did we run the one-shot synth retry, and if so how did
   * it land? Populated on EVERY ensemble run that gets as far as
   * the synth call (so the field is present whether or not the
   * retry ran). Outcomes:
   *   - `n/a`     — first attempt succeeded, retry not triggered
   *   - `ok`      — retry recovered the failed first attempt
   *   - `timeout` — retry also locally timed out
   *   - `parse`   — retry also failed JSON parse
   *   - `provenance` — retry also produced invalid provenance
   *   - `exhausted-budget` — first attempt failed but no retry
   *     budget left (reserved for ARC-278.future; current code
   *     always runs the retry within the static budget).
   */
  synthRetry?: {
    used: boolean
    outcome: SynthAttemptOutcome | "n/a" | "exhausted-budget"
  }
  /**
   * SIG-228 Phase 3c: populated when the synth-bypass single-specialist
   * hot path fired (dispatcher returned 1 specialist + no major-severity
   * findings + `OPENCLAW_SYNTH_BYPASS_ENABLED === "on"`). When present,
   * `synthesizer.modelUsed` is the bypass sentinel and `synthesizer.elapsedMs`
   * reflects the bypass synth-construction time (near-zero), so post-
   * rollout analysis can compute the wall-time saved vs the legacy
   * synth path. Absent on the synth path (default) AND when the flag
   * is off.
   */
  synthBypass?: {
    reason: "single_specialist_no_major"
    specialistRole: SpecialistRole
    findingCount: number
  }
  specialistVerdicts: Array<{
    role: SpecialistRole
    /** Configured primary model. Kept for backward telemetry compat. */
    model: string
    /** The model that actually answered (or last attempted on failure).
     *  Differs from `model` when the cross-provider fallback fired. */
    modelUsed?: string
    /** Total model invocations across primary retries + fallback.
     *  Used by finalize() to charge the daily budget accurately
     *  (CR PR #37 catch — previously assumed 1 call per specialist). */
    attemptsUsed?: number
    verdict: PrReviewVerdictWithIds | null
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  }>
  synthesizer: {
    model: string
    modelUsed?: string
    attemptsUsed?: number
    verdict: PrReviewVerdict | null
    provenance: SynthesizerProvenance | null
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  } | null
  postValidation: {
    droppedForInvalidLine: number
    remappedInvalidLineToInline: number
    droppedForHallucination: number
    demotedScore1: number
    /** ARC-156: count of synth findings dropped by the vague-prefix
     * post-processing filter (headline or body starts with
     * Ensure/Verify/Validate/Consider/Review/Confirm). */
    droppedForVaguePrefix: number
    /** SIG-113: count of `category: "testing"` findings dropped
     * because the specialist failed to cite evidence (no
     * inspectedTestFiles AND no evidenceRefs:siblingMapping). */
    droppedForUncitedTestingEvidence: number
    /** SIG-108: count of security findings the evidence gate flagged
     * (would-drop in shadow mode, actual-drop in enforce mode). */
    droppedForFailedValidation: number
    /** SIG-111: count of sev>=4 testing findings the specificity gate
     * flagged (would-drop in shadow mode, actual-drop in enforce
     * mode). */
    droppedForFailedTestValidation: number
    /** SIG-109: count of sev>=4 logic findings the evidence gate flagged
     * (would-drop in shadow mode, actual-drop in enforce mode). */
    droppedForFailedLogicValidation: number
    /** SIG-308: count of sev>=4 logic findings the refutation backstop flagged
     * for missing a survival rationale (would-drop shadow / actual-drop enforce). */
    droppedForFailedLogicRefutation: number
    /** SIG-328: count of sev>=4 logic findings the logic-claim refutation gate
     * flagged for a provably-false control-flow / sync-race claim (would-drop
     * shadow / actual-drop enforce). */
    droppedForFailedLogicClaimRefutation: number
    /** SIG-325: count of sev>=4 self-originated findings the refutation-survival
     * gate flagged for a missing mechanism rationale (would-demote shadow /
     * actual-demote enforce). */
    droppedForFailedRefutationSurvival: number
    /** SIG-110: count of sev>=4 perf findings the evidence gate flagged
     * (would-drop in shadow mode, actual-drop in enforce mode). */
    droppedForFailedPerfValidation: number
    /** SIG-281 PR C: count of score 2-3 findings the inline-grounding gate
     * flagged as ungrounded (would-demote-to-body in shadow, actual-demote
     * in enforce mode). */
    droppedForFailedInlineGroundingValidation: number
    /** SIG-290 v1: count of absence-claim findings the absence-grounding
     * gate flagged as ungrounded — evidence provably outside the window
     * (would-demote-to-body in shadow, actual-demote in enforce; 0 when
     * the gate is off). */
    droppedForFailedAbsenceGroundingValidation: number
    /** Cross-cutting over-fire Option B: count of window-blindness gate hits
     * (would-demote-to-body in shadow, actual-demote in enforce; 0 when the
     * gate is off). */
    droppedForFailedWindowBlindnessValidation: number
    /** SIG-293 v1: count of secrets-exposure findings the security-
     * grounding gate flagged as ungrounded — cited line held no credential
     * token, uncorroborated by any scanner fact (would-demote-to-body in
     * shadow, actual-demote in enforce; 0 when the gate is off). */
    droppedForFailedSecurityGroundingValidation: number
    droppedForFailedSecurityUsageValidation: number
  }
  retrievalCacheStats: RetrievalCacheStats | null
  /**
   * SIG-149: per-review token spend, keyed by the model that produced
   * it (summed across every settled attempt — specialist primary +
   * retries + cross-provider fallback + synth + synth retry). Populated
   * live during the run via `perfCtx.recordTokens`; read by `finalize()`
   * to compute modeled cost for the `review-slo-summary` event. Empty
   * `{}` when no model attempt surfaced usage (e.g. stale-head bail
   * before fan-out) — never absent, so the cost path is branch-free.
   */
  tokenUsageByModel: TokenUsageByModel
  /**
   * SIG-369(b): the logic specialist's INPUT-token decomposition for this run.
   * Present ONLY when `OPENCLAW_LOGIC_INPUT_COMPOSITION === "shadow"` AND the
   * logic role was dispatched; absent otherwise (telemetry-only, default-off).
   * Rides into the `ensemble-review-telemetry` KV record so the 140K-vs-13K
   * input gap is readable PER-PR without live-tailing. `summedInputTokens`
   * reconciles with `tokenUsageByModel[<logic model>].inputTokens`.
   */
  logicInputComposition?: LogicInputComposition
  /**
   * SIG-149: time-to-first-overview — `startMs` → the moment the inline
   * PR overview/walkthrough is posted (first customer-visible content).
   * Set only when the overview actually posts; absent on runs that skip
   * it (budget) or bail before reaching it. `finalize()` forwards it to
   * the `review-slo-summary` SLO eval, where absent = "no data" (never a
   * breach). See the `timeToFirstOverviewMs` SloTarget caveat re: the
   * overview currently being on the critical path (SIG-216).
   */
  timeToFirstOverviewMs?: number
  /**
   * ARC-192: hunk-level diff packing telemetry. Records how the diff
   * was split for the model call. `batchCount > 1` means the PR was
   * too large to fit in one specialist call; v1 reviews only the
   * first batch and lists the rest in `filesNotReviewed`. Operators
   * use this to decide whether v2 (multi-call merge) is worth the
   * cost increase.
   */
  diffPacking?: {
    diffTokensEstimated: number
    totalFiles: number
    batchCount: number
    filesReviewed: string[]
    filesDroppedTooLarge: string[]
    filesNotReviewed: string[]
    /**
     * ARC-176: paths excluded by `sigilix.json` `pathFilters` BEFORE
     * packing. Helps operators tune the filter list — surfacing files
     * we filtered lets them spot accidental over-exclusion.
     */
    filesDroppedByFilter?: string[]
    /**
     * ARC-273: when the char-level cap `costControls.maxPatchLength`
     * truncated the post-packing diff, this records the final size
     * the model actually saw. Absent when no truncation fired.
     */
    diffTruncatedToChars?: number
  }
  /**
   * ARC-193: deterministic regex check telemetry. `hits` are the
   * matches injected into specialist prompts as facts; analyses can
   * confirm the rules are firing as expected. `compiledRegexFailures`
   * are rule IDs whose pattern didn't compile — surfaces config
   * mistakes without breaking review.
   */
  deterministicChecks?: {
    hits: DeterministicCheckHit[]
    compiledRegexFailures: string[]
  }
  /**
   * ARC-187: secret-scan telemetry. Stores hit count + fingerprints
   * only. Raw secrets are NEVER stored or logged — fingerprints are
   * `${ruleId}:${path}:${line}:${redactedPreview}` so post-hoc
   * analysis can dedupe across runs without exposing the value.
   */
  secretScan?: {
    hitCount: number
    fingerprints: string[]
  }
  /**
   * SIG-417: the pre-flight cost projection (observe-only telemetry) + the
   * dark-governor trim outcome. Written by `packAndRoute`; read by `finalize`
   * to emit the post-hoc `cost-projection-miss` calibration event.
   * `governorTrimmed` is true only when the default-off governor actually
   * removed files.
   */
  costProjection?: {
    projectedUsd: number
    perCallInputTokens: number
    governorEnabled: boolean
    governorTrimmed: boolean
    trimmedPaths: string[]
    ceilingUnmet: boolean
  }
  /**
   * ARC-186: dependency-vulnerability scan telemetry. `skipped: true`
   * with a reason for the skip-paths (disabled, missing manifest,
   * etc.); `skipped: false` with the finding count + scanned counts
   * on the run path.
   */
  depVulnScan?:
    | { skipped: true; reason: DepVulnSkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; depsScanned: number; manifestsScanned: number }
  /**
   * ARC-181: AST rule-pack scan telemetry. Mirrors the dep-vuln
   * shape — `scanned: true` with metrics on the run path,
   * `scanned: false` with optional `skipReason` on skip paths.
   */
  astRules?:
    | {
        scanned: true
        filesScanned: number
        filesSkippedLarge: number
        filesParseFailed: number
        findingsCount: number
        durationMs: number
      }
    | { scanned: false; skipReason?: "disabled-config" | "no-js-ts-files"; findingsCount: 0 }
  /**
   * ARC-188: SARIF evidence channel telemetry. `findingsCount`
   * reflects the post-200-cap emitted count (Kimi NIT #6); the
   * pre-cap total is `findingsCount + truncatedCount`.
   */
  sarifEvidence?:
    | { skipped: true; reason: SarifSkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; truncatedCount: number; durationMs: number }
  /**
   * ARC-189: cross-PR review-memory lookup telemetry. `skipped`
   * paths emit a reason from the union; the run path carries the
   * per-finding count + duration. `memoriesInjected` mirrors
   * `findingsCount` in v1 (no extra render-time cap beyond what
   * `selectTopMemories` already applied at lookup time).
   */
  reviewMemory?:
    | { skipped: true; reason: ReviewMemorySkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; memoriesInjected: number; durationMs: number }
  /**
   * ARC-194: incremental-review telemetry. `mode` is `incremental`
   * (savings path), `full` (we tried but bailed), or `first-review`
   * (no previous record). `previousSha` is the SHA we previously
   * reviewed (if any). `reason` explains why we didn't take the
   * incremental path (`same_sha`, `compare_fetch_failed`,
   * `compare_empty`, `compare_not_smaller`).
   */
  incrementalReview?: {
    mode: DiffMode
    previousSha?: string
    reason?: string
  }
  shadowVerdict?: PrReviewVerdict
  submitted?: boolean
  /**
   * True when the inline-anchored submission was rejected by GitHub
   * and the orchestrator successfully recovered by re-submitting an
   * anchorless review with all findings rolled into the body. Set
   * alongside `submitted: true` — the review was posted, just not in
   * the inline-comment shape.
   */
  submitFallback?: boolean
  /** Error message from the original (failed) inline submission. */
  submitFallbackReason?: string
  /**
   * SIG-286 PR2 — targeted-inject A/B arm. Set ONLY in `post` mode and ONLY on
   * reviews that WOULD inject (non-empty render): `treatment` got the cross-file
   * inject, `control` did not (so `injected` ≡ `arm === "treatment"` — stored as
   * just `arm`, no redundant flag). Rides into the ensemble-review-telemetry KV
   * alongside `synthesizer.verdict` (NOT the dead `shadowVerdict`), so a per-arm
   * finding-rate comparison — group by arm, count `synthesizer.verdict.findings`
   * — can read whether the inject catches more real findings. Absent in shadow /
   * non-inject reviews.
   */
  graphExpansionAb?: { arm: "treatment" | "control" }
  startMs: number
  totalMs: number
}

export type EnsembleResult = EnsembleResultBase<EnsembleTelemetry>
