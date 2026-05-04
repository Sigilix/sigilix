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
} from "./triage-pr-review"
import {
  decideSpecialists,
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

const SPECIALIST_MODELS: Record<SpecialistRole, string> = {
  logic: "deepseek-v4-pro:cloud",
  security: "qwen3-coder:30b:cloud",
  performance: "minimax-m2.1:cloud",
  tests: "qwen3-coder:30b:cloud",
}
const SYNTHESIZER_MODEL = "kimi-k2.6:cloud"

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
    const router = decideSpecialists({ paths: filePaths, totalLinesChanged }, env)
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
    if (!checkQuorum(succeeded, mode)) {
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
    const submission = buildReviewSubmission({
      verdict: validated.verdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
    })
    await client.submitReview(owner, repo, prNumber, submission)
    telemetry.submitted = true
    return finalize(telemetry, env, "posted", cache)
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

async function dailyBudgetAvailable(env: Env): Promise<boolean> {
  const cap = parseIntEnv(env.OPENCLAW_ENSEMBLE_DAILY_BUDGET, DEFAULT_DAILY_BUDGET)
  if (cap <= 0) return false
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD UTC
  const key = `ensemble-budget:${today}`
  const raw = await env.OPENCLAW_STATE.get(key)
  const used = raw ? Number.parseInt(raw, 10) : 0
  return used < cap
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
}

async function runSpecialist(args: SpecialistRunArgs): Promise<SpecialistRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return { verdict: null, failureReason: "missing_api_key", elapsedMs: 0 }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.initialMessage },
  ]
  try {
    const result = await chat({
      model: SPECIALIST_MODELS[args.role],
      messages,
      apiKey: args.apiKey,
      signal: args.signal,
      chatEnabled: args.chatEnabled,
      format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
    })
    const verdict = parsePrReviewResponse(result.message.content)
    if (!verdict) {
      return {
        verdict: null,
        failureReason: "specialist_did_not_parse",
        failureRawAnswer: result.message.content.slice(0, 32_000),
        elapsedMs: Date.now() - t0,
      }
    }
    return { verdict, elapsedMs: Date.now() - t0 }
  } catch (e) {
    return {
      verdict: null,
      failureReason: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    }
  }
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

async function runSynthesizer(args: SynthesizerRunArgs): Promise<SynthesizerRunOutput> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return { verdict: null, provenance: null, failureReason: "missing_api_key", elapsedMs: 0 }
  }

  // Phase 4a: synthesizer is a single chat() call (no tools yet).
  // Phase 4b can extend to give it retrieve_codebase for sev≥4 conflicts.
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]
  let raw: string
  try {
    const result = await chat({
      model: SYNTHESIZER_MODEL,
      messages,
      apiKey: args.apiKey,
      signal: args.signal,
      chatEnabled: args.chatEnabled,
      // No format here — synth output is `{verdict, provenance}` which
      // doesn't match PR_REVIEW_SCHEMA shape directly. Tolerated by
      // parseFirstJsonObject + post-validation.
      temperature: 0,
    })
    raw = result.message.content
  } catch (e) {
    return {
      verdict: null,
      provenance: null,
      failureReason: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    }
  }

  // Parse: expect `{verdict: PrReviewVerdict, provenance: {...}}`.
  const parsed = parseFirstJsonObject(raw)
  if (!parsed) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "synth_failed_parse",
      failureRawAnswer: raw.slice(0, 32_000),
      elapsedMs: Date.now() - t0,
    }
  }

  const verdict = parsePrReviewResponse(JSON.stringify(parsed.verdict))
  const provenance = isValidProvenance(parsed.provenance) ? (parsed.provenance as SynthesizerProvenance) : null

  if (!verdict) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "synth_failed_parse",
      failureRawAnswer: raw.slice(0, 32_000),
      elapsedMs: Date.now() - t0,
    }
  }
  if (!provenance) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "synth_invalid_provenance",
      failureRawAnswer: raw.slice(0, 32_000),
      elapsedMs: Date.now() - t0,
    }
  }
  return {
    verdict,
    provenance,
    elapsedMs: Date.now() - t0,
  }
}

function isValidProvenance(value: unknown): value is SynthesizerProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.findings) && Array.isArray(v.dropped) && typeof v.retrievalCallsUsed === "number"
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

export function checkQuorum(succeeded: CollectedVerdict[], mode: "shadow" | "post"): boolean {
  if (succeeded.length < 2) return false
  if (mode === "shadow") return true  // any 2 OK in shadow
  // post mode: require ≥1 of {logic, security}
  const hasLogicOrSec = succeeded.some((v) => v.role === "logic" || v.role === "security")
  return hasLogicOrSec
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
  let droppedForInvalidLine = 0
  let droppedForHallucination = 0
  let demotedScore1 = 0
  const advisoryNits: PrReviewFinding[] = []

  // Walk by INDEX (v3.1 catch — not by headline).
  for (let i = 0; i < synthOutput.verdict.findings.length; i++) {
    const f = synthOutput.verdict.findings[i]!
    const provenance = synthOutput.provenance.findings[i]

    // Hallucination guard
    if (!provenance || provenance.sourceFindingIds.length === 0) {
      droppedForHallucination++
      continue
    }
    if (!provenance.sourceFindingIds.every((id) => validIds.has(id))) {
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
    model: string
    verdict: PrReviewVerdictWithIds | null
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  }>
  synthesizer: {
    model: string
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
  // Best-effort daily-budget increment (model calls actually used).
  const callsUsed = telemetry.specialistVerdicts.length + (telemetry.synthesizer ? 1 : 0)
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
