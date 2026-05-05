// Phase 4 ensemble PR-review orchestrator. Per v3.1 LOCKED spec.
//
// Lifecycle (shadow + post modes):
//
//   1. Routing decision (mode + repo allowlist + budget gate)
//   2. Stale-head guard #1 (before fanout)
//   3. Pre-flight retrieval snapshot (cached)
//   4. Router decides which specialists to invoke (default: all 4)
//   5. Fan out specialists in parallel via runAgentLoop, each wrapped in
//      withComposedTimeout(90s). Promise.allSettled captures failures.
//   6. Quorum check (post mode requires ≥1 of logic/security succeeded)
//   7. Truncate each specialist verdict to 8k tokens before fan-in
//   8. Assign stable IDs (logic-0, security-1, ...) so synthesizer can
//      reference them in provenance.sourceFindingIds
//   9. Synthesizer (Kimi K2.6) runs as a constrained agent loop with
//      retrieve_codebase as its only tool, capped per remaining budget,
//      120s timeout
//  10. Post-synthesis validation:
//      - Hallucination guard: provenance.findings[i].sourceFindingIds
//        must reference real specialist findings
//      - Line validity: drop findings whose (path, line) isn't a
//        reviewable position in the diff
//      - Side derivation: orchestrator picks LEFT/RIGHT from parsed diff
//      - Score-1 demotion: aggregated into Advisory nits (top 5),
//        never inline
//  11. Stale-head guard #2 (before posting)
//  12. Submit OR skip (shadow mode = telemetry-only)
//  13. Write ensemble telemetry record (paired with any Phase 3 record
//      for the same {owner, repo, prNumber, headSha})
//
// In `shadow` mode this runs IN PARALLEL TO Phase 3 — Phase 3 posts the
// customer-facing review, ensemble writes telemetry only. In `post` mode
// the ensemble verdict gets posted to GitHub.

import { chat, type ChatMessage } from "./ollama-chat"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { GitHubClient } from "./github"
import { getInstallationToken } from "./github-app"
import { parseFirstJsonObject } from "./json-extract"
import { PR_REVIEW_SCHEMA } from "./schemas"
import {
  type PrReviewVerdict,
  type PrReviewFinding,
  parsePrReviewResponse,
  buildReviewSubmission,
  buildFallbackSubmission,
} from "./triage-pr-review"
import {
  decideSpecialists,
  ALL_SPECIALISTS,
  type SpecialistRole,
  type RouterDecision,
} from "./ensemble-router"
import {
  createRetrievalCache,
  type RetrievalCacheStats,
} from "./retrieval-cache"
import {
  parseDiffToReviewablePositions,
  deriveSide,
  type ReviewableMap,
} from "./diff-positions"
import {
  SPECIALIST_PROMPTS,
  SYNTHESIZER_PROMPT,
  buildSpecialistInitialMessage,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "../prompts/pr-review-specialists"
import { withComposedTimeout } from "./agent-loop"
import type { Env } from "../index"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// DEFAULT_MAX_MODEL_CALLS_PER_PR is configured via env but currently
// unused at the orchestrator level — Phase 4a relies on the per-call
// timeouts + the retrieve budget for cost control. Reserved for Phase
// 4b when the synthesizer's optional retrieve_codebase tool path is
// fully wired.
const DEFAULT_MAX_RETRIEVE_CALLS_PER_PR = 3
const DEFAULT_DAILY_BUDGET = 200
const SPECIALIST_TIMEOUT_MS = 90_000
const SYNTHESIZER_TIMEOUT_MS = 120_000
const ORCHESTRATOR_TIMEOUT_MS = 240_000
const SPECIALIST_VERDICT_TOKEN_CAP = 8_000
const MAX_ADVISORY_NITS = 5

/**
 * Per-role model lineup with retry/fallback config (v3.1 LOCKED spec
 * amendment, post-shadow-mode telemetry from PR #35-36 dogfooding).
 *
 * Initial v3.1 lineup had two real bugs:
 *   - `qwen3-coder:30b:cloud` was a phantom — Ollama Turbo's tag list
 *     doesn't include a 30B variant on cloud (verified via /api/tags).
 *     Security + tests specialists 404'd on every call.
 *   - `deepseek-v4-pro:cloud` is the latest reasoning model, capacity-
 *     constrained on Ollama Turbo's underlying provider; routinely
 *     returns 503 under demand spikes. With specialist retries
 *     disabled per original spec, that = silent specialist failure
 *     and quorum loss.
 *
 * After dual sign-off (Codex + Kimi K2.6) the lineup is now:
 *   - Same primary models where they were working (logic, perf, synth)
 *   - Replaced phantom qwen3-coder:30b → deepseek-v4-flash for
 *     security + tests (known-working family member, predictable cost)
 *   - Cross-provider fallbacks per role (true uncorrelated resilience —
 *     Kimi-B's argument: same-family fallback fails when the upstream
 *     provider has an outage, defeating the fallback's purpose)
 *   - Retries enabled per-role, sized by criticality (logic gets 2,
 *     others 1, synth 1; user constraint "logic cannot fail").
 */
interface ModelConfig {
  primary: string
  /** Number of retry attempts on the primary BEFORE falling back. 0 = no retry. */
  retries: number
  /** Cross-provider fallback model. null = fail without fallback. */
  fallback: string | null
}

const SPECIALIST_CONFIGS: Record<SpecialistRole, ModelConfig> = {
  logic: {
    primary: "deepseek-v4-pro:cloud",
    retries: 2,
    fallback: "kimi-k2.5:cloud",  // Moonshot — different infra than DeepSeek
  },
  security: {
    primary: "deepseek-v4-flash:cloud",  // known-working family member
    retries: 1,
    fallback: "qwen3-coder-next:cloud",  // cross-provider
  },
  performance: {
    primary: "minimax-m2.1:cloud",  // worked in initial telemetry
    retries: 1,
    fallback: "glm-5.1:cloud",  // cross-provider
  },
  tests: {
    primary: "deepseek-v4-flash:cloud",
    retries: 1,
    // Reuses qwen3-coder-next:cloud as the cross-provider fallback
    // rather than devstral-small-2:24b:cloud — the size tag (`24b`)
    // and the cloud-routing tag (`cloud`) don't compose in Ollama's
    // syntax (same gotcha that broke `qwen3-coder:30b:cloud`).
    // qwen3-coder-next has no size tag baked in, so `:cloud` works.
    fallback: "qwen3-coder-next:cloud",
  },
}

const SYNTHESIZER_CONFIG: ModelConfig = {
  primary: "kimi-k2.6:cloud",
  retries: 1,
  fallback: "kimi-k2.5:cloud",
}

/** @deprecated kept for telemetry compatibility — derive from SPECIALIST_CONFIGS instead */
const SPECIALIST_MODELS: Record<SpecialistRole, string> = {
  logic: SPECIALIST_CONFIGS.logic.primary,
  security: SPECIALIST_CONFIGS.security.primary,
  performance: SPECIALIST_CONFIGS.performance.primary,
  tests: SPECIALIST_CONFIGS.tests.primary,
}
const SYNTHESIZER_MODEL = SYNTHESIZER_CONFIG.primary

/** Backoff schedule (ms) for retry attempts. 800ms, 2.5s — short
 *  enough to fit within specialist timeout budget (90s), long enough
 *  to ride through most transient 503s. */
const RETRY_BACKOFF_MS = [800, 2500]

// ─── public types ──────────────────────────────────────────────────────

export type EnsembleMode = "off" | "shadow" | "post"

export interface EnsembleHandlerArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
}

export type RouteDecision =
  | { primary: "ensemble-shadow"; secondary: "phase3-agentic" }
  | { primary: "ensemble-post" }
  | { primary: "phase3-agentic" }
  | { primary: "phase3-singleshot-legacy" }

/**
 * Top-level routing: given env + repo + budget state, decide which
 * review pipeline runs. Pure-ish (does check the daily-budget KV
 * counter, which is async — but called from the queue handler, not
 * inside any tight loop).
 */
export async function routeReview(args: {
  env: Env
  owner: string
  repo: string
}): Promise<RouteDecision> {
  const { env, owner, repo } = args
  const mode = parseMode(env.OPENCLAW_ENSEMBLE_REVIEW_MODE)

  if (mode === "off") {
    return env.OPENCLAW_AGENTIC_GITHUB_MODE === "on"
      ? { primary: "phase3-agentic" }
      : { primary: "phase3-singleshot-legacy" }
  }

  if (!isRepoAllowed(env.OPENCLAW_ENSEMBLE_REVIEW_ALLOWED_REPOS, owner, repo)) {
    return env.OPENCLAW_AGENTIC_GITHUB_MODE === "on"
      ? { primary: "phase3-agentic" }
      : { primary: "phase3-singleshot-legacy" }
  }

  if (!(await dailyBudgetAvailable(env))) {
    return env.OPENCLAW_AGENTIC_GITHUB_MODE === "on"
      ? { primary: "phase3-agentic" }
      : { primary: "phase3-singleshot-legacy" }
  }

  if (mode === "shadow") {
    return { primary: "ensemble-shadow", secondary: "phase3-agentic" }
  }
  return { primary: "ensemble-post" }
}

// ─── orchestrator ──────────────────────────────────────────────────────

export async function handlePrReviewEnsemble(
  args: EnsembleHandlerArgs,
  mode: "shadow" | "post",
): Promise<EnsembleResult> {
  const { owner, repo, prNumber, headSha, installationId, env } = args
  const startMs = Date.now()
  const orchCtrl = new AbortController()
  const orchTimer = setTimeout(() => orchCtrl.abort(), ORCHESTRATOR_TIMEOUT_MS)

  // Lifted out of the try block so the finally cleanup can read cache
  // stats into telemetry on every exit path (success, failure, throw).
  let cache: ReturnType<typeof createRetrievalCache> | null = null

  // Telemetry skeleton — populated as we go so we can write a record
  // even on early failure paths.
  const telemetry: EnsembleTelemetry = {
    schemaVersion: 3,
    owner,
    repo,
    prNumber,
    headSha,
    mode,
    fellBackToPhase3: false,
    routerDecision: null,
    specialistVerdicts: [],
    synthesizer: null,
    postValidation: { droppedForInvalidLine: 0, droppedForHallucination: 0, demotedScore1: 0 },
    retrievalCacheStats: null,
    startMs,
    totalMs: 0,
  }

  try {
    const client = await buildClient(env, installationId)

    // ─── Stale-head guard #1 ───────────────────────────────────
    const meta = await client.getPullRequest(owner, repo, prNumber)
    if (meta.head?.sha && meta.head.sha !== headSha) {
      telemetry.fellBackToPhase3 = true
      telemetry.fellBackReason = "stale_head_before_fanout"
      return finalize(telemetry, env, "skipped", cache)
    }

    const diff = await client.getPullRequestDiff(owner, repo, prNumber)
    const reviewable = parseDiffToReviewablePositions(diff)
    const filePaths = [...reviewable.keys()]

    // ─── Router decision ───────────────────────────────────────
    const totalLinesChanged = countLines(diff)
    // CR PR #35 catch: pass diffText so the router can content-aware
    // check markdown fenced code blocks before taking the docs-only
    // shortcut.
    const router = decideSpecialists({ paths: filePaths, totalLinesChanged, diffText: diff }, env)
    telemetry.routerDecision = router

    if (router.specialists.length === 0) {
      // Router said "no specialists for this PR." Skip ensemble entirely.
      // Phase 3 has already submitted (in shadow mode) or will be
      // delegated to (in post mode — but ensemble-post with empty
      // router is a degenerate case; fall back to Phase 3).
      telemetry.fellBackToPhase3 = mode === "post"
      telemetry.fellBackReason = "router_no_specialists"
      return finalize(telemetry, env, "skipped", cache)
    }

    // ─── Pre-flight retrieval snapshot ─────────────────────────
    cache = createRetrievalCache({
      maxCalls: parseIntEnv(env.OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR, DEFAULT_MAX_RETRIEVE_CALLS_PER_PR),
    })
    const namespace = repo.toLowerCase()
    const preflightQuery = `${meta.title}\n\n${meta.body ?? ""}`
    const preflight = await cache.cachedRetrieve({
      caller: "preflight",
      query: preflightQuery,
      namespace,
      fetcher: () => retrieveChunks({ text: preflightQuery, teamKey: namespace, env }),
    })
    const retrievalSnapshot = preflight.chunks
      ? formatChunksForPrompt(preflight.chunks) ?? ""
      : ""

    // ─── Fan out specialists ────────────────────────────────────
    const initialMessage = buildSpecialistInitialMessage({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff,
      retrievalSnapshot,
      namespace,
    })

    const specialistResults = await Promise.allSettled(
      router.specialists.map((role) =>
        withComposedTimeout(
          () => runSpecialist({
            role,
            apiKey: env.OLLAMA_API_KEY,
            systemPrompt: SPECIALIST_PROMPTS[role],
            initialMessage,
            chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
            signal: orchCtrl.signal,
          }),
          SPECIALIST_TIMEOUT_MS,
          orchCtrl.signal,
        ),
      ),
    )

    // Collect specialist verdicts (with stable IDs assigned).
    const specialistVerdicts = collectSpecialistVerdicts(
      router.specialists,
      specialistResults,
      telemetry,
    )

    // ─── Quorum check ──────────────────────────────────────────
    const succeeded = specialistVerdicts.filter((v) => v.verdict !== null)
    if (!checkQuorum(succeeded, mode, router.specialists)) {
      telemetry.fellBackToPhase3 = mode === "post"
      telemetry.fellBackReason = succeeded.length <= 1
        ? "specialists_failed"
        : "specialists_quorum_missing"
      return finalize(telemetry, env, "skipped", cache)
    }

    // ─── Synthesizer ───────────────────────────────────────────
    const synthVerdictBlock = renderSpecialistVerdictsForSynth(
      succeeded
        .filter((v): v is CollectedVerdict & { verdict: PrReviewVerdictWithIds } => v.verdict !== null)
        .map((v) => ({ role: v.role, verdict: truncateVerdictToTokens(v.verdict, SPECIALIST_VERDICT_TOKEN_CAP) })),
    )
    const synthMessage = buildSynthesizerInitialMessage({
      prNumber,
      diff,
      specialistVerdictsBlock: synthVerdictBlock,
    })

    const synthOutput = await withComposedTimeout(
      () => runSynthesizer({
        apiKey: env.OLLAMA_API_KEY,
        systemPrompt: SYNTHESIZER_PROMPT,
        userMessage: synthMessage,
        chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
        signal: orchCtrl.signal,
      }),
      SYNTHESIZER_TIMEOUT_MS,
      orchCtrl.signal,
    )

    const synthEntry: NonNullable<EnsembleTelemetry["synthesizer"]> = {
      model: SYNTHESIZER_MODEL,
      modelUsed: synthOutput.modelUsed,
      attemptsUsed: synthOutput.attemptsUsed,
      verdict: synthOutput.verdict,
      provenance: synthOutput.provenance,
      retrievalCallsUsed: 0,  // Phase 4a synth doesn't use retrieve; reserved for Phase 4b
      elapsedMs: synthOutput.elapsedMs,
      timedOut: false,
    }
    if (synthOutput.failureReason) synthEntry.failureReason = synthOutput.failureReason
    if (synthOutput.failureRawAnswer) synthEntry.failureRawAnswer = synthOutput.failureRawAnswer
    telemetry.synthesizer = synthEntry

    if (!synthOutput.verdict || !synthOutput.provenance) {
      telemetry.fellBackToPhase3 = mode === "post"
      telemetry.fellBackReason = synthOutput.failureReason === "synth_invalid_provenance"
        ? "synth_invalid_provenance"
        : "synth_failed_parse"
      return finalize(telemetry, env, "skipped", cache)
    }

    // ─── Post-synthesis validation ─────────────────────────────
    const validated = validateForSubmission({
      synthOutput: { verdict: synthOutput.verdict, provenance: synthOutput.provenance },
      reviewable,
      specialistVerdicts: succeeded,
    })
    telemetry.postValidation = {
      droppedForInvalidLine: validated.droppedForInvalidLine,
      droppedForHallucination: validated.droppedForHallucination,
      demotedScore1: validated.demotedScore1,
    }

    if (mode === "shadow") {
      // Shadow: telemetry only, no GitHub submission.
      telemetry.shadowVerdict = validated.verdict
      return finalize(telemetry, env, "shadow_recorded", cache)
    }

    // ─── Stale-head guard #2 ───────────────────────────────────
    const meta2 = await client.getPullRequest(owner, repo, prNumber)
    if (meta2.head?.sha && meta2.head.sha !== headSha) {
      telemetry.fellBackToPhase3 = true
      telemetry.fellBackReason = "stale_head_after_review"
      return finalize(telemetry, env, "skipped", cache)
    }

    // ─── Submit ────────────────────────────────────────────────
    // GitHub validates every inline anchor and rejects the entire review
    // on a single bad position (typical 422). When that happens the
    // ensemble verdict is good but unsubmittable in its inline shape —
    // Greptile's pr_review.ts handles this by re-posting the review
    // anchorless with all findings rolled into the body. Same pattern
    // here: catch any submit error and retry with `buildFallbackSubmission`.
    // If the fallback ALSO fails, the outer try/catch records it as
    // `internal_error` (same behaviour as before this change).
    const submission = buildReviewSubmission({
      verdict: validated.verdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
    })
    try {
      await client.submitReview(owner, repo, prNumber, submission)
      telemetry.submitted = true
      return finalize(telemetry, env, "posted", cache)
    } catch (submitErr) {
      const fallbackReason =
        submitErr instanceof Error ? submitErr.message : String(submitErr)
      console.warn("[ensemble] inline submit rejected; falling back to anchorless review", {
        owner,
        repo,
        prNumber,
        reason: fallbackReason,
      })
      const fallback = buildFallbackSubmission({
        verdict: validated.verdict,
        unanchored: validated.unanchoredFindings,
        prAuthor: meta.user?.login ?? null,
        headSha,
      })
      await client.submitReview(owner, repo, prNumber, fallback)
      telemetry.submitted = true
      telemetry.submitFallback = true
      telemetry.submitFallbackReason = fallbackReason
      return finalize(telemetry, env, "posted", cache)
    }
  } catch (e) {
    telemetry.fellBackToPhase3 = mode === "post"
    telemetry.fellBackReason = "internal_error"
    telemetry.internalError = e instanceof Error ? e.message : String(e)
    return finalize(telemetry, env, "errored", cache)
  } finally {
    clearTimeout(orchTimer)
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function parseMode(raw: string | undefined): EnsembleMode {
  if (raw === "shadow") return "shadow"
  if (raw === "post") return "post"
  return "off"
}

function isRepoAllowed(
  allowedRaw: string | undefined,
  owner: string,
  repo: string,
): boolean {
  if (!allowedRaw || allowedRaw.trim().length === 0) return true  // unset = all allowed
  const list = allowedRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  const target = `${owner}/${repo}`.toLowerCase()
  return list.includes(target)
}

/**
 * Max model invocations one ensemble run can possibly consume.
 * Derived from SPECIALIST_CONFIGS + SYNTHESIZER_CONFIG (CR PR #37
 * catch: hard-coded 5 was wrong because retries + fallbacks can push
 * a single run to ~16 calls).
 *
 * Per role: (1 primary attempt) + (config.retries) + (1 fallback if set)
 * Sum across all 4 specialists + synth.
 *
 * Used at admission time to reserve worst-case budget so we don't
 * admit a PR we might overflow. Actual spend at finalize() comes
 * from each role's `attemptsUsed`, not from this constant.
 */
function maxAttempts(config: ModelConfig): number {
  return 1 + config.retries + (config.fallback ? 1 : 0)
}
const MAX_CALLS_PER_ENSEMBLE_RUN = (
  maxAttempts(SPECIALIST_CONFIGS.logic)
  + maxAttempts(SPECIALIST_CONFIGS.security)
  + maxAttempts(SPECIALIST_CONFIGS.performance)
  + maxAttempts(SPECIALIST_CONFIGS.tests)
  + maxAttempts(SYNTHESIZER_CONFIG)
)

async function dailyBudgetAvailable(env: Env): Promise<boolean> {
  const cap = parseIntEnv(env.OPENCLAW_ENSEMBLE_DAILY_BUDGET, DEFAULT_DAILY_BUDGET)
  if (cap <= 0) return false
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD UTC
  const key = `ensemble-budget:${today}`
  const raw = await env.OPENCLAW_STATE.get(key)
  const used = raw ? Number.parseInt(raw, 10) : 0
  // CR catch: previously checked `used < cap`, which could admit a PR
  // when only 1 call of headroom remained, then finalize would charge 5.
  // Now require room for a FULL ensemble run before admitting. Best-
  // effort under concurrent webhooks (KV race window 1-2 calls,
  // documented in v3.1 spec) but no longer per-PR overshoot by 5.
  return used + MAX_CALLS_PER_ENSEMBLE_RUN <= cap
}

async function incrementDailyBudget(env: Env, by: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const key = `ensemble-budget:${today}`
  const raw = await env.OPENCLAW_STATE.get(key)
  const used = raw ? Number.parseInt(raw, 10) : 0
  await env.OPENCLAW_STATE.put(key, String(used + by), { expirationTtl: 48 * 60 * 60 })
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  // Arc PR #35 catch: `parsed > 0` made the `cap <= 0` guard in
  // dailyBudgetAvailable() dead code — operators setting
  // OPENCLAW_ENSEMBLE_DAILY_BUDGET=0 silently got the default (200)
  // instead of disabling ensemble. Allow 0 to propagate.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function countLines(diff: string): number {
  let n = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) n++
    else if (line.startsWith("-") && !line.startsWith("---")) n++
  }
  return n
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}

// ─── specialist runner ────────────────────────────────────────────────

interface SpecialistRunArgs {
  role: SpecialistRole
  apiKey: string | undefined
  systemPrompt: string
  initialMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
}

interface SpecialistRunResult {
  verdict: PrReviewVerdict | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  /** Which model actually produced the verdict (or last attempted on failure).
   *  Differs from SPECIALIST_MODELS[role] when fallback fired. */
  modelUsed: string
  /** Total model invocations across primary retries + fallback. */
  attemptsUsed: number
}

async function runSpecialist(args: SpecialistRunArgs): Promise<SpecialistRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdict: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: SPECIALIST_CONFIGS[args.role].primary,
      attemptsUsed: 0,
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.initialMessage },
  ]
  const config = SPECIALIST_CONFIGS[args.role]
  return runWithRetryAndFallback({
    config,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "specialist_did_not_parse",
    startedAt: t0,
  })
}

/**
 * Run a chat call with retry + cross-provider fallback. Used by both
 * specialist and synthesizer paths to centralize the retry policy
 * (added post-shadow-mode telemetry; original v3.1 spec disabled
 * retries for cost reasons but capacity 503s on frontier models made
 * that untenable for the logic specialist specifically).
 *
 * Sequence:
 *   1. Try primary (attempt 1)
 *   2. If retryable failure (503/429/network/abort-not-from-orch) AND
 *      retries remaining → backoff + retry (attempts 2..N+1)
 *   3. If primary exhausted AND fallback configured → try fallback once
 *   4. Return final outcome (success OR last failure)
 *
 * Parse failures are NOT retried — they indicate a model output
 * problem, not a capacity problem; retrying the same prompt at
 * temperature 0 will yield the same bad output.
 */
export async function runWithRetryAndFallback<T>(args: {
  config: ModelConfig
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
  startedAt: number
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}> {
  const { config, apiKey, messages, signal, chatEnabled, format, parseAnswer, parseFailureLabel, startedAt } = args

  let attemptsUsed = 0
  let lastFailureReason: string | undefined
  let lastFailureRaw: string | undefined

  // Try primary with retries
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted) {
      return wrapFailure("aborted", undefined, config.primary, attemptsUsed, startedAt)
    }
    if (attempt > 0) {
      // Backoff before retry
      const delay = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0
      await sleepWithSignal(delay, signal)
      if (signal.aborted) {
        return wrapFailure("aborted", undefined, config.primary, attemptsUsed, startedAt)
      }
    }
    attemptsUsed++
    const outcome = await attemptChat({ model: config.primary, apiKey, messages, signal, chatEnabled, format, parseAnswer, parseFailureLabel })
    if (outcome.verdict !== null) {
      return {
        verdict: outcome.verdict,
        elapsedMs: Date.now() - startedAt,
        modelUsed: config.primary,
        attemptsUsed,
      }
    }
    lastFailureReason = outcome.failureReason
    lastFailureRaw = outcome.failureRawAnswer
    // Failure classification:
    //
    //   Permanent (404 missing-model, 401/403 auth, 400 validation,
    //   parse failure) → don't retry primary (same prompt → same error).
    //   But DO try the cross-provider fallback (arc PR #37 catch): a
    //   404 on deepseek-v4-pro says nothing about whether kimi-k2.5
    //   exists — they're different providers entirely. Same for parse
    //   failures: a different model may format output correctly. So
    //   `break` out of the retry loop to skip ahead to fallback.
    //
    //   Transient (5xx upstream-overload, 429 rate-limited, network
    //   errors, timeout) → keep retrying primary; backoff helps. Fall
    //   back if all retries exhausted.
    if (isPermanentFailure(outcome.failureReason, parseFailureLabel)) {
      break
    }
  }

  // Primary exhausted (either retries used up on transient errors, OR
  // primary hit a permanent failure and broke early). In BOTH cases
  // try the cross-provider fallback before giving up — fallback runs
  // on different infra and may succeed where primary couldn't.
  if (config.fallback && !signal.aborted) {
    attemptsUsed++
    const outcome = await attemptChat({ model: config.fallback, apiKey, messages, signal, chatEnabled, format, parseAnswer, parseFailureLabel })
    if (outcome.verdict !== null) {
      return {
        verdict: outcome.verdict,
        elapsedMs: Date.now() - startedAt,
        modelUsed: config.fallback,
        attemptsUsed,
      }
    }
    // Fallback also failed. Use ITS failure as the reason (more recent + relevant).
    return wrapFailure(
      `fallback_failed: ${outcome.failureReason ?? "unknown"}`,
      outcome.failureRawAnswer,
      config.fallback,
      attemptsUsed,
      startedAt,
    )
  }

  return wrapFailure(lastFailureReason ?? "exhausted_no_fallback", lastFailureRaw, config.primary, attemptsUsed, startedAt)
}

function wrapFailure<T>(
  reason: string,
  rawAnswer: string | undefined,
  modelUsed: string,
  attemptsUsed: number,
  startedAt: number,
): {
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
} {
  const out: ReturnType<typeof wrapFailure<T>> = {
    verdict: null,
    elapsedMs: Date.now() - startedAt,
    modelUsed,
    attemptsUsed,
  }
  if (reason) out.failureReason = reason
  if (rawAnswer) out.failureRawAnswer = rawAnswer
  return out
}

async function attemptChat<T>(args: {
  model: string
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
}): Promise<{ verdict: T | null; failureReason?: string; failureRawAnswer?: string }> {
  try {
    const result = await chat({
      model: args.model,
      messages: args.messages,
      apiKey: args.apiKey,
      signal: args.signal,
      chatEnabled: args.chatEnabled,
      ...(args.format ? { format: args.format } : {}),
      temperature: 0,
    })
    const verdict = args.parseAnswer(result.message.content)
    if (!verdict) {
      return {
        verdict: null,
        failureReason: args.parseFailureLabel,
        failureRawAnswer: result.message.content.slice(0, 32_000),
      }
    }
    return { verdict }
  } catch (e) {
    return {
      verdict: null,
      failureReason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Classify a failure reason as permanent (don't retry, don't fall back)
 * vs transient (retry primary, then try fallback).
 *
 * Permanent reasons (CR PR #37 catch — caller should fast-fail):
 *   - parse failure label (model output didn't parse; same prompt at
 *     temp=0 will keep failing)
 *   - HTTP 4xx (except 429 which is rate-limit + transient)
 *     - 404: phantom model name (same problem hits the fallback path
 *       if config is wrong, but better to fail loud than retry silently)
 *     - 401/403: auth — retrying won't fix it
 *     - 400: validation error in our request
 *   - "missing_api_key", "aborted" (already short-circuited but defensive)
 *
 * Transient reasons (keep retrying / falling back):
 *   - HTTP 5xx (server overload — the original case we built for)
 *   - HTTP 429 (rate limited; backoff helps)
 *   - Network errors, timeouts
 *   - Unknown (fail open — assume transient so we still try fallback)
 *
 * The chat() helper throws errors with messages like
 * `Ollama HTTP <status>: <body>`, so we extract the status code. For
 * non-HTTP failures (network), the message has no status — treat as
 * transient.
 */
export function isPermanentFailure(failureReason: string | undefined, parseFailureLabel: string): boolean {
  if (!failureReason) return false
  if (failureReason === parseFailureLabel) return true
  if (failureReason === "missing_api_key" || failureReason === "aborted") return true
  // Match `Ollama HTTP <status>` or generic `HTTP <status>` patterns
  const httpMatch = failureReason.match(/HTTP\s+(\d{3})/i)
  if (httpMatch && httpMatch[1]) {
    const status = Number.parseInt(httpMatch[1], 10)
    if (status === 429) return false  // rate-limited = transient
    if (status >= 400 && status < 500) return true  // other 4xx = permanent
  }
  return false
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  // CR + arc PR #37 catch: if the signal is already aborted on entry,
  // the abort event has already fired and our addEventListener will
  // never trigger — without this guard we'd sleep the full ms before
  // returning. Closes the race between caller's abort check + our
  // listener installation.
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// ─── synthesizer runner ───────────────────────────────────────────────

interface SynthesizerRunArgs {
  apiKey: string | undefined
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
}

interface SynthesizerRunOutput {
  verdict: PrReviewVerdict | null
  provenance: SynthesizerProvenance | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}

export interface SynthesizerProvenance {
  findings: Array<{
    sourceSpecialists: SpecialistRole[]
    sourceFindingIds: string[]
    action: "kept" | "merged" | "rewritten"
    verifiedViaRetrieval: boolean
  }>
  dropped: Array<{
    specialist: SpecialistRole
    sourceFindingId: string
    headline: string
    reason: string
  }>
  retrievalCallsUsed: number
}

/**
 * Composite type the synth retry path emits — both verdict + provenance
 * are needed for a successful synth, so the runWithRetryAndFallback
 * helper treats this as the parsed-answer shape.
 */
interface SynthParsedOutput {
  verdict: PrReviewVerdict
  provenance: SynthesizerProvenance
}

function parseSynthAnswer(content: string): SynthParsedOutput | null {
  // Expect `{verdict: PrReviewVerdict, provenance: {...}}`.
  const parsed = parseFirstJsonObject(content)
  if (!parsed) return null
  const verdict = parsePrReviewResponse(JSON.stringify(parsed.verdict))
  if (!verdict) return null
  if (!isValidProvenance(parsed.provenance)) return null
  return { verdict, provenance: parsed.provenance }
}

async function runSynthesizer(args: SynthesizerRunArgs): Promise<SynthesizerRunOutput> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: SYNTHESIZER_CONFIG.primary,
      attemptsUsed: 0,
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]

  // No `format` arg here — synth output is `{verdict, provenance}` which
  // doesn't match PR_REVIEW_SCHEMA shape directly. Tolerated by
  // parseFirstJsonObject + post-validation.
  const outcome = await runWithRetryAndFallback<SynthParsedOutput>({
    config: SYNTHESIZER_CONFIG,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: undefined,
    parseAnswer: parseSynthAnswer,
    parseFailureLabel: "synth_failed_parse",
    startedAt: t0,
  })

  if (outcome.verdict) {
    return {
      verdict: outcome.verdict.verdict,
      provenance: outcome.verdict.provenance,
      elapsedMs: outcome.elapsedMs,
      modelUsed: outcome.modelUsed,
      attemptsUsed: outcome.attemptsUsed,
    }
  }

  // Distinguish parse-vs-provenance failures in telemetry. parseSynthAnswer
  // returns null for either case, but we lose the distinction inside the
  // retry helper. Re-parse the raw answer here to label the failure
  // accurately (CR PR #35 catch — telemetry consumers need this split).
  let failureReason = outcome.failureReason ?? "synth_failed_parse"
  if (outcome.failureRawAnswer) {
    const parsed = parseFirstJsonObject(outcome.failureRawAnswer)
    const hasVerdict = parsed && parsePrReviewResponse(JSON.stringify(parsed.verdict))
    if (hasVerdict && !isValidProvenance(parsed?.provenance)) {
      failureReason = "synth_invalid_provenance"
    }
  }

  const result: SynthesizerRunOutput = {
    verdict: null,
    provenance: null,
    elapsedMs: outcome.elapsedMs,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
  }
  if (failureReason) result.failureReason = failureReason
  if (outcome.failureRawAnswer) result.failureRawAnswer = outcome.failureRawAnswer
  return result
}

function isValidProvenance(value: unknown): value is SynthesizerProvenance {
  // CR PR #35 catch: tighten shape check beyond "are findings + dropped
  // arrays?" — without this, a payload like `{findings:[{}], dropped:[],
  // retrievalCallsUsed:0}` passes and validateForSubmission then crashes
  // on `provenance.findings[i].sourceFindingIds.length` (undefined).
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.findings) || !Array.isArray(v.dropped) || typeof v.retrievalCallsUsed !== "number") {
    return false
  }
  // Each provenance.findings[i] must have an array sourceFindingIds.
  // The hallucination guard in validateForSubmission relies on this.
  for (const f of v.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false
    const entry = f as Record<string, unknown>
    if (!Array.isArray(entry.sourceFindingIds)) return false
    if (!entry.sourceFindingIds.every((id) => typeof id === "string")) return false
  }
  // dropped entries are looser — they're informational only and never
  // dereferenced into the customer-facing verdict, but still validate
  // for shape stability.
  for (const d of v.dropped) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false
  }
  return true
}

// ─── verdict post-processing ──────────────────────────────────────────

interface CollectedVerdict {
  role: SpecialistRole
  verdict: PrReviewVerdictWithIds | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
}

interface PrReviewVerdictWithIds extends PrReviewVerdict {
  findings: Array<PrReviewFinding & { id: string }>
}

function collectSpecialistVerdicts(
  roles: SpecialistRole[],
  results: Array<PromiseSettledResult<SpecialistRunResult>>,
  telemetry: EnsembleTelemetry,
): CollectedVerdict[] {
  const out: CollectedVerdict[] = []
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!
    const settled = results[i]
    if (!settled || settled.status === "rejected") {
      const reason = settled?.status === "rejected"
        ? (settled.reason instanceof Error ? settled.reason.message : String(settled.reason))
        : "unknown_settlement"
      const collected: CollectedVerdict = { role, verdict: null, elapsedMs: 0, failureReason: reason }
      out.push(collected)
      // No attemptsUsed available — the wrapper threw before runSpecialist
      // returned, so we don't know how many attempts ran. Leave undefined
      // so finalize()'s defensive `?? 1` kicks in.
      telemetry.specialistVerdicts.push({
        role,
        model: SPECIALIST_MODELS[role],
        verdict: null,
        failureReason: reason,
        elapsedMs: 0,
        timedOut: reason.includes("timeout") || reason.includes("aborted"),
      })
      continue
    }
    const value = settled.value
    if (!value.verdict) {
      const collected: CollectedVerdict = { role, verdict: null, elapsedMs: value.elapsedMs }
      if (value.failureReason) collected.failureReason = value.failureReason
      if (value.failureRawAnswer) collected.failureRawAnswer = value.failureRawAnswer
      out.push(collected)
      const telEntry: EnsembleTelemetry["specialistVerdicts"][number] = {
        role,
        model: SPECIALIST_MODELS[role],
        modelUsed: value.modelUsed,
        attemptsUsed: value.attemptsUsed,
        verdict: null,
        elapsedMs: value.elapsedMs,
        timedOut: false,
      }
      if (value.failureReason) telEntry.failureReason = value.failureReason
      if (value.failureRawAnswer) telEntry.failureRawAnswer = value.failureRawAnswer
      telemetry.specialistVerdicts.push(telEntry)
      continue
    }
    const withIds = assignStableFindingIds(role, value.verdict)
    out.push({ role, verdict: withIds, elapsedMs: value.elapsedMs })
    telemetry.specialistVerdicts.push({
      role,
      model: SPECIALIST_MODELS[role],
      modelUsed: value.modelUsed,
      attemptsUsed: value.attemptsUsed,
      verdict: withIds,
      elapsedMs: value.elapsedMs,
      timedOut: false,
    })
  }
  return out
}

export function assignStableFindingIds(role: SpecialistRole, verdict: PrReviewVerdict): PrReviewVerdictWithIds {
  return {
    ...verdict,
    findings: verdict.findings.map((f, i) => ({ ...f, id: `${role}-${i}` })),
  }
}

export function checkQuorum(
  succeeded: CollectedVerdict[],
  mode: "shadow" | "post",
  dispatchedSpecialists?: SpecialistRole[],
): boolean {
  // Arc PR #35 catch: when the router dispatches fewer than 4
  // specialists (e.g., CSS-only → ["performance"]), the original
  // `succeeded.length < 2` rule always failed because there were
  // never 2 to begin with. Make quorum proportional to what the
  // router actually requested.
  //
  // Rule:
  //   - Need min(2, dispatched.length) successes (so single-dispatch
  //     PRs need just that 1 to succeed; multi-dispatch needs ≥2).
  //   - In post mode, ALSO require ≥1 of {logic, security} to have
  //     succeeded — but only if the router actually dispatched them.
  //     If the router intentionally excluded both (rare; would only
  //     happen for CSS-only → ["performance"] type cases), the post-
  //     mode check is effectively just the count requirement.
  const dispatched = dispatchedSpecialists ?? [...ALL_SPECIALISTS]
  const dispatchedSet = new Set(dispatched)
  const minSuccesses = Math.min(2, dispatched.length)
  if (succeeded.length < minSuccesses) return false
  if (mode === "shadow") return true
  // post mode: enforce logic/security only if router dispatched them
  const dispatchedLogicOrSec = dispatchedSet.has("logic") || dispatchedSet.has("security")
  if (!dispatchedLogicOrSec) return true
  return succeeded.some((v) => v.role === "logic" || v.role === "security")
}

/**
 * Truncate a verdict's JSON-stringified form to fit the token cap.
 * Drops lowest-score findings first to preserve severity. Approximate
 * — uses 4 chars/token estimate.
 */
export function truncateVerdictToTokens(
  verdict: PrReviewVerdictWithIds,
  maxTokens: number,
): PrReviewVerdictWithIds {
  const charBudget = maxTokens * 4
  let working = { ...verdict, findings: [...verdict.findings] }
  // Sort findings by score DESC so we drop the lowest first.
  working.findings.sort((a, b) => b.score - a.score)
  while (JSON.stringify(working).length > charBudget && working.findings.length > 0) {
    working.findings.pop()
  }
  return working
}

// ─── post-synthesis validation ────────────────────────────────────────

export interface ValidatedOutput {
  verdict: PrReviewVerdict
  /**
   * Findings that passed the hallucination guard and the score-1 demotion
   * check but failed `deriveSide()` (line not in the PR diff). Empty in
   * the success path; the submit-review fallback uses this list to
   * recover findings whose value survives without an inline anchor.
   */
  unanchoredFindings: PrReviewFinding[]
  droppedForInvalidLine: number
  droppedForHallucination: number
  demotedScore1: number
}

export function validateForSubmission(args: {
  synthOutput: { verdict: PrReviewVerdict; provenance: SynthesizerProvenance }
  reviewable: ReviewableMap
  specialistVerdicts: CollectedVerdict[]
}): ValidatedOutput {
  const { synthOutput, reviewable, specialistVerdicts } = args
  const validIds = new Set<string>()
  for (const v of specialistVerdicts) {
    if (!v.verdict) continue
    for (const f of v.verdict.findings) validIds.add(f.id)
  }

  const cleanFindings: PrReviewFinding[] = []
  const unanchoredFindings: PrReviewFinding[] = []
  let droppedForInvalidLine = 0
  let droppedForHallucination = 0
  let demotedScore1 = 0
  const advisoryNits: PrReviewFinding[] = []

  // Walk by INDEX (v3.1 catch — not by headline).
  for (let i = 0; i < synthOutput.verdict.findings.length; i++) {
    const f = synthOutput.verdict.findings[i]!
    const provenance = synthOutput.provenance.findings[i]

    // Hallucination guard. Defensive against malformed provenance
    // even though isValidProvenance pre-validated (belt + suspenders
    // per CR PR #35 — provenance might be partially valid).
    const sourceIds = Array.isArray(provenance?.sourceFindingIds)
      ? provenance.sourceFindingIds
      : []
    if (sourceIds.length === 0) {
      droppedForHallucination++
      continue
    }
    if (!sourceIds.every((id) => validIds.has(id))) {
      droppedForHallucination++
      continue
    }

    // Score-1 advisory demotion
    if (f.score <= 1) {
      advisoryNits.push(f)
      demotedScore1++
      continue
    }

    // Line validity + side derivation
    const side = deriveSide(reviewable, f.path, f.line)
    if (!side) {
      droppedForInvalidLine++
      // Preserve for submit-fallback. Inline anchoring would fail here,
      // but the finding's *content* is still actionable when posted as
      // free-form markdown in the body of an anchorless review.
      unanchoredFindings.push(f)
      continue
    }
    cleanFindings.push(f)
  }

  // Aggregate score-1 advisory nits (cap at 5, sort by score DESC then alpha)
  let summary = synthOutput.verdict.summary
  if (advisoryNits.length > 0) {
    advisoryNits.sort((a, b) => b.score - a.score || a.headline.localeCompare(b.headline))
    const top = advisoryNits.slice(0, MAX_ADVISORY_NITS)
    const rest = advisoryNits.length - top.length
    const headlines = top.map((n) => n.headline).join("; ")
    const tail = rest > 0 ? `; plus ${rest} more advisory nits` : ""
    summary = `${summary}\n\n**Advisory nits:** ${headlines}${tail}`
  }

  return {
    verdict: { ...synthOutput.verdict, summary, findings: cleanFindings },
    unanchoredFindings,
    droppedForInvalidLine,
    droppedForHallucination,
    demotedScore1,
  }
}

// ─── telemetry ─────────────────────────────────────────────────────────

interface EnsembleTelemetry {
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
    retrievalCallsUsed: number
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  } | null
  postValidation: {
    droppedForInvalidLine: number
    droppedForHallucination: number
    demotedScore1: number
  }
  retrievalCacheStats: RetrievalCacheStats | null
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
  startMs: number
  totalMs: number
}

type EnsembleResultStatus = "posted" | "shadow_recorded" | "skipped" | "errored"

export interface EnsembleResult {
  status: EnsembleResultStatus
  telemetry: EnsembleTelemetry
}

async function finalize(
  telemetry: EnsembleTelemetry,
  env: Env,
  status: EnsembleResultStatus,
  cache: ReturnType<typeof createRetrievalCache> | null,
): Promise<EnsembleResult> {
  telemetry.totalMs = Date.now() - telemetry.startMs
  // Capture retrieval cache stats BEFORE the KV write so telemetry
  // reflects everything the cache observed during this run (CR catch).
  if (cache !== null) {
    telemetry.retrievalCacheStats = cache.stats()
  }
  // Best-effort daily-budget increment.
  //
  // CR PR #37 catch: previously this counted dispatched specialists as
  // 1 each + synth as 1. With retries + cross-provider fallback, a
  // single role can use up to 4 model invocations. Using attemptsUsed
  // (set by runWithRetryAndFallback) gives accurate spend telemetry
  // and keeps the daily budget honest.
  let callsUsed = 0
  for (const sv of telemetry.specialistVerdicts) {
    callsUsed += sv.attemptsUsed ?? 1  // ?? 1 — defensive for legacy records
  }
  if (telemetry.synthesizer) {
    callsUsed += telemetry.synthesizer.attemptsUsed ?? 1
  }
  await incrementDailyBudget(env, callsUsed).catch(() => {})
  // Best-effort telemetry write.
  await writeTelemetry(env, telemetry).catch(() => {})
  return { status, telemetry }
}

async function writeTelemetry(env: Env, telemetry: EnsembleTelemetry): Promise<void> {
  const reverseTs = String(9_999_999_999_999 - Date.now()).padStart(13, "0")
  const key = `ensemble-review-telemetry:${reverseTs}:${telemetry.owner}/${telemetry.repo}#${telemetry.prNumber}`
  await env.OPENCLAW_STATE.put(key, JSON.stringify(telemetry), {
    expirationTtl: 30 * 24 * 60 * 60,
  })
}
