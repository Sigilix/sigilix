// SIG-318 (PR 12c) — the SYNTHESIZE phase of the PR-review orchestrator (app
// layer). Carved verbatim from `handlePrReviewEnsemble`: the SIG-228 synth-bypass
// single-specialist hot path, the full synthesizer path (review-memory injection,
// the ARC-283 shadow-synth kick-off, `attemptSynth` + the one-shot retry ladder),
// the synth telemetry entry + parse-fail bail, and the synth summary emit. Ends
// where the synth has produced a usable (non-null) verdict + provenance; the
// recall floors that follow live in `./recall-floors`.
//
// EXTRACT-METHOD discipline: the moved statements are byte-identical apart from
// the plumbing — the 3 early-exit bails now wrap `bailWithSkipNotice` in the
// `{ kind: "exit" }` arm, `args.repoId` is the destructured `repoId`, and the
// deliberately-parent-indented synth `else` body is re-indented by the carve
// (no statement changed). ZERO behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home
// (the synth domain, the model-provider adapter, the shadow-bakeoff + review-
// memory + prompt + config leaves). It never imports the orchestrator god-file.

import type { Env } from "@/shared/types/env"
import type { PrReviewVerdict } from "@/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/shared/domain/specialist-role"
import type { RouterDecision } from "../../ensemble-router"
import {
  type SigilixConfig,
  resolveCommandConfig,
  renderPathInstructionsForPrompt,
  resolveReviewMemoryConfig,
  resolveAstRulesConfig,
  resolvePathInstructionsForChangedPaths,
} from "../../sigilix-config"
import {
  SYNTHESIZER_PROMPT,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "../../../prompts/pr-review-specialists"
import { renderAstFindingsAsJsonForSynth, runAstRules } from "@/features/ast-rules"
import { renderSarifFindingsAsJsonForSynth, type SarifFinding } from "@/features/sarif-evidence"
import { runSarifEvidence } from "@/features/sarif-evidence"
import { withComposedTimeout } from "../../agent-loop"
import { runReviewMemoryLookup } from "../../review-memory/lookup"
import { renderReviewMemoryForPrompt } from "../../review-memory/render"
import type { ReviewMemoryFinding, ReviewMemorySkipReason } from "../../review-memory/types"
import {
  type EnsembleRunCtx,
  type SynthSummary,
  emitPhaseCompleted,
  emitSynthSummary,
  narrowSynthRetryOutcome,
} from "../../ensemble-perf-telemetry"
import { type SkipNoticeReason } from "../../review-comment-fallback"
import {
  parseShadowEnabledRoles,
  resolveShadowConfig,
} from "../../shadow-bakeoff-config"
import { runShadowSynth } from "../../shadow-bakeoff-runner"
import { composeSignals } from "../domain/shadow-grace"
import {
  SYNTHESIZER_CONFIG,
  SYNTHESIZER_MODEL,
  runSynthesizer,
} from "../adapters/model-provider"
import type { ModelConfig } from "../domain/model-policy"
import {
  SYNTHESIZER_TIMEOUT_MS,
  SYNTHESIZER_RETRY_TIMEOUT_MS,
} from "../domain/budget"
import type { CollectedVerdict, SynthesizerProvenance } from "../domain/validation"
import type { PrReviewVerdictWithIds } from "../domain/findings"
import {
  buildSynthRetryMessage,
  buildAstFindingsSynthBlock,
  classifySynthOutcome,
  isSynthBypassEligible,
  type SynthAttemptOutcome,
} from "../domain/synth"
import type { ShadowBakeoffState } from "./shadow-settle"

type AstResult = Awaited<ReturnType<typeof runAstRules>>
type AstRulesConfig = ReturnType<typeof resolveAstRulesConfig>
type SarifResult = Awaited<ReturnType<typeof runSarifEvidence>>
type MatchedPathInstructions = ReturnType<typeof resolvePathInstructionsForChangedPaths>
/** The synth-input verdicts produced by `buildSynthInputVerdicts(succeeded)`. */
type SynthInputVerdict = CollectedVerdict & { verdict: PrReviewVerdictWithIds }

/**
 * Minimal structural slice of `EnsembleTelemetry` the synthesize phase writes by
 * reference (the orchestrator's telemetry object satisfies it). The phase writes
 * `synthBypass`, `reviewMemory`, `synthRetry`, `synthesizer`, `fellBackToPhase3`,
 * and `fellBackReason`; the writes land on the same object.
 */
export interface SynthesizeTelemetry {
  synthBypass?: {
    reason: "single_specialist_no_major"
    specialistRole: SpecialistRole
    findingCount: number
  }
  reviewMemory?:
    | { skipped: true; reason: ReviewMemorySkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; memoriesInjected: number; durationMs: number }
  synthRetry?: {
    used: boolean
    outcome: SynthAttemptOutcome | "n/a" | "exhausted-budget"
  }
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
  fellBackToPhase3: boolean
  fellBackReason?: string
}

export interface SynthesizeArgs<R> {
  env: Env
  owner: string
  repo: string
  prNumber: number
  /** SIG-247 Phase 1: the immutable repo.id threaded into the review-memory lookup. */
  repoId?: number
  /** Mutated by reference: synthBypass / reviewMemory / synthRetry / synthesizer / fellBack*. */
  telemetry: SynthesizeTelemetry
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  /** By-reference holder: the shadow-synth kick-off writes `synthPromise` + an abort controller. */
  shadowState: ShadowBakeoffState
  /** The skip-notice bail closure; returns the orchestrator's `EnsembleResult` as `R`. */
  bailWithSkipNotice: (reason: SkipNoticeReason, opts?: { dispatchedRoles?: readonly string[] }) => Promise<R>
  sigilixConfig: SigilixConfig
  diff: string
  matchedPathInstructions: MatchedPathInstructions
  stackBlock: string
  graphCtxForPrompt: string
  dynamicEvidenceBlockForPrompt: string
  astResult: AstResult
  astRulesConfig: AstRulesConfig
  sarifFindings: readonly SarifFinding[]
  sarifResult: SarifResult
  filePaths: string[]
  shadowEnabledRoles: ReturnType<typeof parseShadowEnabledRoles>
  router: RouterDecision
  /** The untruncated successful specialist verdicts (the bypass gate reads them). */
  succeeded: CollectedVerdict[]
  degradedCoverage: { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } | null
  /** Hoisted out of the orchestrator so both the bypass + synth branches read the same truncated verdicts. */
  synthInputVerdicts: SynthInputVerdict[]
}

export type SynthesizePhaseResult<R> =
  | { kind: "exit"; result: R }
  | {
      kind: "ok"
      /** NON-NULL (the parse-fail bail returns otherwise) — the recall floors + adjudicate downstream rely on it. */
      synthVerdict: PrReviewVerdict
      synthProvenance: SynthesizerProvenance
      shadowMemoriesForPhase3: ReviewMemoryFinding[]
    }

export async function runSynthPhase<R>(a: SynthesizeArgs<R>): Promise<SynthesizePhaseResult<R>> {
  const {
    env,
    owner,
    repo,
    prNumber,
    repoId,
    telemetry,
    perfCtx,
    orchCtrl,
    shadowState,
    bailWithSkipNotice,
    sigilixConfig,
    diff,
    matchedPathInstructions,
    stackBlock,
    graphCtxForPrompt,
    dynamicEvidenceBlockForPrompt,
    astResult,
    astRulesConfig,
    sarifFindings,
    sarifResult,
    filePaths,
    shadowEnabledRoles,
    router,
    succeeded,
    degradedCoverage,
    synthInputVerdicts,
  } = a
    const synthBypassEligible =
      !shadowEnabledRoles.has("synth") &&
      isSynthBypassEligible(
        env,
        router.specialists.length,
        succeeded,
      )

    // Hoisted from the original synth section below so the bypass
    // path can populate them too — the post-synth validation code
    // reads from one source of truth regardless of which branch fired.
    //
    // `synthStartMs` is captured inside each branch so the metric stays
    // apples-to-apples vs pre-SIG-228 telemetry: synth branch starts
    // its clock right before the LLM call, bypass branch right before
    // its near-zero construction. Otherwise the synth-path elapsedMs
    // would silently accrete prompt-building + review-memory-lookup
    // time and overstate the bypass savings on rollout dashboards.
    let synthOutput: Awaited<ReturnType<typeof runSynthesizer>> | undefined
    let synthStartMs: number
    let synthAttemptsUsed = 0
    let synthRetryUsed = false
    let synthRetryOutcome: "n/a" | "ok" | "timeout" | "parse" | "provenance" | "exhausted-budget" = "n/a"
    // SIG-276 Phase 3: the injected memories captured in the synth-path
    // scope (where `reviewMemoryResult` is alive) so the Site-2 shadow
    // matcher — which runs later, in the outer post-synth scope — can read
    // them. Stays [] on the synth-bypass branch (no memory injection there).
    let shadowMemoriesForPhase3: ReviewMemoryFinding[] = []

    if (synthBypassEligible) {
      synthStartMs = Date.now()
      // Bypass: construct a synth-equivalent output directly from the
      // single specialist's truncated verdict. The provenance entries
      // declare every kept finding as sourced from that one specialist
      // with `action: "kept"` — the only legal shape when synth never
      // ran. The `modelUsed` sentinel lets telemetry consumers
      // distinguish bypass elapsed-ms from real synth elapsed-ms.
      //
      // Known tradeoffs (M2/M3 from code-reviewer): the bypass also
      // skips synth's contextual signals — AST supersession (drops
      // specialist findings that share `(path, line, role_hint)` with
      // a deterministic AST entry), SARIF Fix-Plan ordering, GRAPH
      // CONTEXT contradiction, REVIEW MEMORY softening, and the
      // unified PR-wide summary rewrite. On the 1-role no-major hot
      // path those signals are typically empty or low-signal; on a
      // 1-role + populated-AST/SARIF/memory PR they would actually
      // do useful work. Worth filing a follow-up to either disable
      // bypass when those blocks are non-empty OR fold a minimal
      // post-bypass supersession pass.
      const sole = synthInputVerdicts[0]!
      const verdict = sole.verdict
      synthOutput = {
        verdict,
        provenance: {
          findings: verdict.findings.map((f) => ({
            sourceSpecialists: [sole.role],
            sourceFindingIds: [f.id],
            action: "kept" as const,
            verifiedViaRetrieval: false,
          })),
          dropped: [],
        },
        // `elapsedMs: 0` here is overwritten by `synthEntry.elapsedMs =
        // Date.now() - synthStartMs` below; kept as a defensive stub
        // so callers reading `synthOutput.elapsedMs` directly (vs
        // via the telemetry entry) never see undefined.
        elapsedMs: 0,
        modelUsed: "synth-bypass-single-specialist",
        attemptsUsed: 0,
      }
      telemetry.synthBypass = {
        reason: "single_specialist_no_major",
        specialistRole: sole.role,
        findingCount: verdict.findings.length,
      }
      // Set reviewMemory + synthRetry explicitly for telemetry parity
      // with the synth path — bypass produces a shape that rollout
      // dashboards can filter for without ambiguity.
      // `reason: "retrieval-disabled-config"` is the closest
      // ReviewMemorySkipReason that captures "the bypass path
      // skipped review memory by configuration choice" (the synth-
      // bypass IS a configuration choice).
      telemetry.reviewMemory = {
        skipped: true,
        reason: "retrieval-disabled-config",
        findingsCount: 0,
      }
      telemetry.synthRetry = { used: false, outcome: "n/a" }
      console.log(JSON.stringify({
        event: "ensemble-synth-bypassed",
        owner, repo, prNumber,
        role: sole.role,
        findingCount: verdict.findings.length,
      }))
    } else {
      synthStartMs = Date.now()

    // ─── Synthesizer ───────────────────────────────────────────
    const synthVerdictBlock = renderSpecialistVerdictsForSynth(synthInputVerdicts)
    const synthMessage = buildSynthesizerInitialMessage({
      prNumber,
      diff,
      specialistVerdictsBlock: synthVerdictBlock,
      ...(sigilixConfig.guidance ? { guidance: sigilixConfig.guidance } : {}),
      ...(matchedPathInstructions.length > 0
        ? { pathInstructionsBlock: renderPathInstructionsForPrompt(matchedPathInstructions) }
        : {}),
      ...(stackBlock.length > 0 ? { stackBlock } : {}),
      // ARC-277: when one or more specialists didn't return, tell
      // synth which roles it's missing so it can constrain its
      // output and acknowledge the gap in `summary`.
      ...(degradedCoverage ? { degradedCoverage } : {}),
      // SIG-138 Phase 2: synth sees graph neighbors in post mode.
      ...(graphCtxForPrompt.length > 0 ? { graphContext: graphCtxForPrompt } : {}),
      ...(dynamicEvidenceBlockForPrompt.length > 0
        ? { dynamicEvidenceBlock: dynamicEvidenceBlockForPrompt }
        : {}),
    })

    // ARC-181 Task 8: thread structured AST findings into the synth
    // prompt for (path, line, role_hint) supersession matching.
    const astFindingsForSynth = renderAstFindingsAsJsonForSynth(astResult.findings)
    // SIG-245: only instruct supersession-and-drop when the AST version will be
    // posted (autoInline ON). With it OFF (default) the drop silently loses
    // double-detected real findings — see buildAstFindingsSynthBlock.
    const synthMessageWithAst =
      synthMessage + buildAstFindingsSynthBlock(astFindingsForSynth, astRulesConfig.autoInline)

    // ARC-188: append SARIF structured findings + SBOM summary on
    // top of the AST-augmented prompt. Synth gets the machine-
    // readable JSON for Fix Plan ordering (direct-dep findings
    // outrank deep-transitive). Empty when no SARIF run + no SBOM.
    const sarifSynthBlock = renderSarifFindingsAsJsonForSynth(
      sarifFindings,
      sarifResult.skipped ? undefined : sarifResult.sbom,
    )
    const synthMessageWithSarif = sarifSynthBlock.length > 0
      ? `${synthMessageWithAst}\n\n[SARIF EVIDENCE — synth-only structured]\n\n\`\`\`\n${sarifSynthBlock}\n\`\`\``
      : synthMessageWithAst

    // ─── ARC-189: cross-PR review-memory injection ────────────
    // Synth-only (specialists do NOT see this block — we want them to
    // surface the finding and let synth decide whether to soften).
    // Gates per spec §5.2 truth table: env=on AND sigilix.json
    // enabled=true. Lookup pipeline does its own gate-check; this
    // outer guard avoids paying the (cheap) lookup cost when
    // disabled.
    const reviewMemoryConfig = resolveReviewMemoryConfig(sigilixConfig)
    const reviewMemoryResult = await runReviewMemoryLookup({
      env, owner, repo, prNumber,
      paths: filePaths,
      config: reviewMemoryConfig,
      // SIG-247 Phase 1: thread the immutable repo.id so the lookup
      // hits the dual-write keyspace. When absent (legacy queue
      // message / slash-command raw-send), the lookup degrades to
      // legacy-only reads and the canary telemetry `key_mode` field
      // surfaces the gap.
      ...(repoId !== undefined ? { repoId } : {}),
    })
    const memoryBlock = reviewMemoryResult.skipped
      ? ""
      : renderReviewMemoryForPrompt(reviewMemoryResult.findings)
    // SIG-276 Phase 3: hand the injected memories (which carry telemetry
    // `shadowClaims` when the shadow flag is on) to the outer-scope holder
    // for the Site-2 shadow matcher. Telemetry-only; never affects the
    // prompt or softening.
    shadowMemoriesForPhase3 = reviewMemoryResult.skipped
      ? []
      : reviewMemoryResult.findings
    // Codex BLOCKING on plan v2: gate the append on memoryBlock
    // length, NOT sarifBlock length. The two blocks are independent.
    const synthMessageWithMemory = memoryBlock.length > 0
      ? `${synthMessageWithSarif}\n\n${memoryBlock}`
      : synthMessageWithSarif
    telemetry.reviewMemory = reviewMemoryResult.skipped
      ? {
          skipped: true,
          reason: reviewMemoryResult.reason,
          findingsCount: 0,
        }
      : {
          skipped: false,
          findingsCount: reviewMemoryResult.findings.length,
          memoriesInjected: reviewMemoryResult.findings.length,
          durationMs: reviewMemoryResult.durationMs,
        }

    // Phase 4a.1: distinguish synth-local timeout from outer-orch abort.
    // Without this, `withComposedTimeout` rejection on synth's own 180s
    // timer bubbles to the outer catch and is recorded as
    // `internalError: "Operation aborted"` with `synthesizer: null` —
    // the spec promised `synthesizer.timedOut: true` for this case.
    //
    // SIG-228 Phase 3c: `synthOutput`, `synthStartMs`, `synthRetryUsed`,
    // `synthRetryOutcome` + `synthAttemptsUsed` are now declared in
    // outer scope (just before the bypass-or-synth branch above) so
    // both paths populate the same identifiers.
    // ARC-278 (CR catch on PR #90): runSynthesizer wraps
    // runWithRetryAndFallback, which already does its own internal
    // primary+retry+fallback. So `attempt.attemptsUsed` from a single
    // outer call can be 1, 2, or 3+. Accumulate the real count across
    // BOTH attempts (and across a local timeout, where the outer call
    // never returned attemptsUsed at all — treat as 1).
    // This feeds `finalize()`'s daily-budget charge; under-counting
    // here would under-charge the budget and over-count head-room.
    //
    // SIG-228 Phase 3c: hoisted to outer scope (see comment block at
    // the top of the bypass-or-synth branch above).
    try {
      // ARC-185: per-PR commands.review.{prompt.addendum, model.{primary,
      // fallbacks}} override. Specialists left untouched on the v3.1
      // LOCKED lineup. v1 limitation: ModelConfig.fallback is a single
      // string — only the first user-supplied fallback reaches the
      // synth runtime. Telemetry records the dropped count.
      const reviewCmdConfig = resolveCommandConfig(sigilixConfig, "review")
      const synthSystemPrompt = reviewCmdConfig.promptAddendum
        ? `${SYNTHESIZER_PROMPT}\n\n[REPO-SPECIFIC GUIDANCE]\n${reviewCmdConfig.promptAddendum}`
        : SYNTHESIZER_PROMPT
      const synthConfigOverride: ModelConfig | undefined = (
        reviewCmdConfig.modelPrimary !== null ||
        reviewCmdConfig.modelFallbacks.override
      )
        ? {
            primary: reviewCmdConfig.modelPrimary ?? SYNTHESIZER_CONFIG.primary,
            retries: SYNTHESIZER_CONFIG.retries,
            fallback: reviewCmdConfig.modelFallbacks.override
              ? (reviewCmdConfig.modelFallbacks.models[0] ?? SYNTHESIZER_CONFIG.fallback)
              : SYNTHESIZER_CONFIG.fallback,
          }
        : undefined
      if (
        reviewCmdConfig.promptAddendum !== null ||
        reviewCmdConfig.modelPrimary !== null ||
        reviewCmdConfig.modelFallbacks.override
      ) {
        console.log(JSON.stringify({
          event: "command-config-resolved",
          owner, repo, prNumber,
          command: "review",
          hasPromptAddendum: reviewCmdConfig.promptAddendum !== null,
          modelPrimary: reviewCmdConfig.modelPrimary,
          modelFallbacksCount: reviewCmdConfig.modelFallbacks.override
            ? reviewCmdConfig.modelFallbacks.models.length
            : 0,
        }))
      }

      // ARC-283 Phase B1b — shadow synth kick-off. Fires BEFORE
      // `attempt1` so both lineups run in parallel; the shadow
      // promise is captured at the outer scope so `finally` can
      // settle it even when prod synth bails to skip-notice.
      // Same `synthSystemPrompt` + `synthMessageWithMemory` the prod
      // path uses, so the comparison is apples-to-apples on input.
      // Shadow shares `orchCtrl.signal` — aborts with the outer
      // orchestrator timer. The shadow synth is allowed to take
      // longer than the prod synth's 420s budget; what bounds it
      // is the 895s outer orchestrator wall.
      const shadowSynthConfig = resolveShadowConfig("synth", shadowEnabledRoles)
      if (shadowSynthConfig !== null) {
        // ARC-283 Phase B1b CR-2: per-shadow synth AbortController,
        // same pattern as the specialist fan-out above. Lets the
        // finally block cancel an in-flight synth shadow when the
        // grace deadline fires instead of leaving the request to
        // burn provider capacity invisibly.
        const shadowSynthCtrl = new AbortController()
        shadowState.abortControllers.set("synth", shadowSynthCtrl)
        const composedSynthSignal = composeSignals(orchCtrl.signal, shadowSynthCtrl.signal)
        shadowState.synthPromise = runShadowSynth({
          shadowConfig: shadowSynthConfig,
          apiKey: env.OLLAMA_API_KEY,
          systemPrompt: synthSystemPrompt,
          userMessage: synthMessageWithMemory,
          chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
          signal: composedSynthSignal,
          perfCtx,
        }).finally(() => {
          shadowState.abortControllers.delete("synth")
        })
      }

      // ARC-278: extract the attempt-runner so we can call it twice
      // (primary + at most one retry). The closure captures every
      // input that's stable between attempts (system prompt, config
      // override, env, orchCtrl); only `userMessage` and `timeoutMs`
      // vary per call. Returns null on local timeout (so callers
      // don't have to discriminate between catch and `failureReason:
      // "aborted"` shapes). Re-throws on orchestrator-wall abort.
      const attemptSynth = async (
        userMessage: string,
        timeoutMs: number,
      ): Promise<Awaited<ReturnType<typeof runSynthesizer>> | null> => {
        try {
          return await withComposedTimeout(
            // Use the composed signal so a synth-only timeout actually
            // cancels the underlying model call. Passing `orchCtrl.signal`
            // directly only rejects this await; the in-flight model fetch
            // would keep running until the outer 490s orch wall fires
            // (CR catch on PR #42).
            (signal) => runSynthesizer({
              apiKey: env.OLLAMA_API_KEY,
              systemPrompt: synthSystemPrompt,
              userMessage,
              chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
              signal,
              // ARC-283 Phase B1b: same correlation context as the
              // specialist fan-out above.
              perfCtx,
              ...(synthConfigOverride ? { configOverride: synthConfigOverride } : {}),
            }),
            timeoutMs,
            orchCtrl.signal,
          )
        } catch (err) {
          // Orchestrator-wall abort propagates — that's the
          // internal_error path. Synth-local timer is a local
          // failure: return null so the retry path can run.
          if (orchCtrl.signal.aborted) throw err
          return null
        }
      }

      const attempt1 = await attemptSynth(synthMessageWithMemory, SYNTHESIZER_TIMEOUT_MS)
      synthOutput = attempt1 ?? undefined
      // attempt1 === null → local timeout, runSynthesizer never returned
      // anything; charge 1 for the in-flight call. attempt1 !== null →
      // trust the inner retry/fallback count.
      synthAttemptsUsed += attempt1?.attemptsUsed ?? 1
      const attempt1Outcome = classifySynthOutcome(synthOutput, attempt1 === null)

      // ARC-278: if the primary attempt failed in a way we can
      // retry, run one more attempt with a tightened prompt hint.
      // Retry budget is bounded by SYNTHESIZER_RETRY_TIMEOUT_MS
      // (which fits inside RESERVED_HEADROOM_MS, per the static
      // invariant at module load). On retry success → telemetry
      // logs which path recovered; on retry failure → existing
      // failure-handling code below still fires.
      if (attempt1Outcome !== "ok") {
        synthRetryUsed = true
        const retryUserMessage = buildSynthRetryMessage(synthMessageWithMemory, attempt1Outcome)
        console.log(JSON.stringify({
          event: "synth-retry-dispatched",
          owner, repo, prNumber,
          attempt1_outcome: attempt1Outcome,
        }))
        const attempt2 = await attemptSynth(retryUserMessage, SYNTHESIZER_RETRY_TIMEOUT_MS)
        synthOutput = attempt2 ?? undefined
        // Same attempts-accounting rationale as attempt1 above.
        synthAttemptsUsed += attempt2?.attemptsUsed ?? 1
        const attempt2Outcome = classifySynthOutcome(synthOutput, attempt2 === null)
        synthRetryOutcome = attempt2Outcome
        console.log(JSON.stringify({
          event: "synth-retry-completed",
          owner, repo, prNumber,
          attempt1_outcome: attempt1Outcome,
          retry_outcome: attempt2Outcome,
          recovered: attempt2Outcome === "ok",
        }))
      }
    } catch (err) {
      // If the orchestrator's outer signal aborted, propagate — outer
      // timeout is a genuine internal_error and lands in the top-level
      // catch as before.
      if (orchCtrl.signal.aborted) throw err
      // Defensive: any other unexpected throw from the attempt-runner
      // gets recorded as a synth-local timeout (same shape as the
      // pre-ARC-278 behavior). Should be unreachable since
      // attemptSynth handles its own catch — but kept as a safety
      // net so a future refactor that surfaces a thrown exception
      // doesn't crash the dispatcher.
      telemetry.synthesizer = {
        model: SYNTHESIZER_MODEL,
        modelUsed: SYNTHESIZER_MODEL,
        // Defensive catch-block — `synthAttemptsUsed` may or may not
        // have been incremented depending on which await threw.
        // Fall back to a minimum of 1 if accounting got skipped.
        attemptsUsed: Math.max(1, synthAttemptsUsed),
        verdict: null,
        provenance: null,
        elapsedMs: Date.now() - synthStartMs,
        timedOut: true,
        failureReason: "synth_timeout",
      }
      telemetry.synthRetry = { used: synthRetryUsed, outcome: synthRetryOutcome }
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "synth_timeout"
      return { kind: "exit", result: await bailWithSkipNotice("synth_timeout") }
    }

    // ARC-278: persist the retry telemetry regardless of which path
    // wins below. Done BEFORE the post-call processing so even
    // happy-path success carries `synthRetry: { used: false,
    // outcome: "n/a" }` for stable rollout analysis.
    telemetry.synthRetry = { used: synthRetryUsed, outcome: synthRetryOutcome }

    // ARC-278: if both attempts locally timed out, synthOutput is
    // undefined here. Synthesize a stub entry that matches the
    // pre-ARC-278 "synth-local timeout caught in the outer catch"
    // shape so the failure-handling code below stays uniform.
    if (synthOutput === undefined) {
      telemetry.synthesizer = {
        model: SYNTHESIZER_MODEL,
        modelUsed: SYNTHESIZER_MODEL,
        // CR catch on PR #90: trust the accumulated count from
        // attempt1.attemptsUsed (+ attempt2.attemptsUsed if retry
        // ran). Local-timeout branches charge 1 per missed
        // returned-attempt count, so the minimum is correctly 1 for
        // a single-attempt timeout, 2 for primary-then-retry both
        // locally timing out.
        attemptsUsed: Math.max(1, synthAttemptsUsed),
        verdict: null,
        provenance: null,
        elapsedMs: Date.now() - synthStartMs,
        timedOut: true,
        failureReason: "synth_timeout",
      }
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "synth_timeout"
      return { kind: "exit", result: await bailWithSkipNotice("synth_timeout") }
    }
    } // SIG-228 Phase 3c: close the `else { /* synth path */ }` opened
      // above the prompt-building block.

    // Phase 4a.2: withComposedTimeout no longer throws when its own
    // timer or the orch signal aborts an abort-aware factory — it
    // returns the factory's structured wrapFailure with
    // failureReason="aborted". That now reaches this branch instead of
    // the synth_timeout catch above, so derive timedOut + fellBackReason
    // here too. Without this, synth-timer aborts would silently land in
    // synth_failed_parse with timedOut=false (CR catch on PR #44).
    const synthFailureReason = synthOutput.failureReason ?? ""
    const synthAborted = /abort/i.test(synthFailureReason) || /timeout/i.test(synthFailureReason)

    const synthEntry: NonNullable<SynthesizeTelemetry["synthesizer"]> = {
      model: SYNTHESIZER_MODEL,
      modelUsed: synthOutput.modelUsed,
      // ARC-278 (CR catch on PR #90): use the accumulated count.
      // `synthAttemptsUsed` sums each outer-attempt's inner
      // attemptsUsed (where each is itself
      // primary+retry+cross-provider-fallback inside
      // runWithRetryAndFallback). The previous `+ 1` undercounted
      // whenever the inner retry/fallback fired.
      attemptsUsed: synthAttemptsUsed > 0 ? synthAttemptsUsed : synthOutput.attemptsUsed,
      verdict: synthOutput.verdict,
      provenance: synthOutput.provenance,
      elapsedMs: Date.now() - synthStartMs,
      timedOut: synthAborted,
    }
    if (synthOutput.failureReason) synthEntry.failureReason = synthOutput.failureReason
    if (synthOutput.failureRawAnswer) synthEntry.failureRawAnswer = synthOutput.failureRawAnswer
    telemetry.synthesizer = synthEntry

    if (!synthOutput.verdict || !synthOutput.provenance) {
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      const synthFailReason: SkipNoticeReason = synthAborted
        ? "synth_timeout"
        : synthOutput.failureReason === "synth_invalid_provenance"
          ? "synth_invalid_provenance"
          : "synth_failed_parse"
      telemetry.fellBackReason = synthFailReason
      return { kind: "exit", result: await bailWithSkipNotice(synthFailReason) }
    }

    // ARC-284: phase + synth summary fire on the SUCCESS join. Failure
    // paths above (`return bailWithSkipNotice(...)`) skip these — the
    // skip-notice event captures the bail reason; synth-summary is
    // scoped to "synth produced a usable verdict."
    emitPhaseCompleted(perfCtx, "synth", synthStartMs)
    {
      const inputFindingCount = synthInputVerdicts.reduce(
        (sum, v) => sum + (v.verdict?.findings.length ?? 0),
        0,
      )
      const summary: SynthSummary = {
        elapsedMs: Date.now() - synthStartMs,
        attemptsUsed: synthAttemptsUsed > 0 ? synthAttemptsUsed : synthOutput.attemptsUsed,
        retryUsed: synthRetryUsed,
        // ARC-284 Sigilix-PR-#95 catch: coercion extracted to
        // `narrowSynthRetryOutcome` for unit-testability. Collapses
        // the orchestrator-internal `"n/a"` and `"exhausted-budget"`
        // sentinels to `null` for the telemetry contract.
        retryOutcome: narrowSynthRetryOutcome(synthRetryUsed, synthRetryOutcome),
        inputSpecialistCount: synthInputVerdicts.length,
        inputFindingCount,
        outputFindingCount: synthOutput.verdict.findings.length,
        modelUsed: synthOutput.modelUsed,
      }
      emitSynthSummary(perfCtx, summary)
    }

    return {
      kind: "ok" as const,
      // The parse-fail bail above returns otherwise, so verdict/provenance are
      // narrowed non-null here (the recall floors + adjudicate downstream rely on it).
      synthVerdict: synthOutput.verdict,
      synthProvenance: synthOutput.provenance,
      shadowMemoriesForPhase3,
    }
}
