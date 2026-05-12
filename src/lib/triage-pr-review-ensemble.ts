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
import { GitHubClient, GitHubHttpError } from "./github"
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
import {
  detectStack,
  computeFileOverlap,
  type FileOverlap,
  type StackContext,
} from "./pr-stack"
import { renderStackPromptBlock } from "../prompts/pr-stack-prompt"
import type { ListOpenPullsItem } from "./github"
import { withComposedTimeout } from "./agent-loop"
import {
  loadSigilixConfig,
  resolveCommandConfig,
  resolveAstRulesConfig,
  type SigilixConfig,
} from "./sigilix-config"
import {
  splitDiffByFile,
  packFilesIntoBatches,
  batchToDiff,
  estimateTokens,
} from "./diff-packing"
import { shouldReview } from "./path-glob"
import {
  runDeterministicChecks,
  renderHitsForPrompt,
  type DeterministicCheckHit,
} from "./deterministic-checks"
import {
  runSecretScan,
  renderSecretHitsForPrompt,
  type SecretHit,
} from "./secret-scan"
import {
  readLastReviewedSha,
  writeLastReviewedSha,
  selectDiff,
  type DiffMode,
} from "./incremental-review"
import { isRepoSensitive } from "./repo-policy"
import {
  computeFileListHash,
  writeReviewManifest,
  type ReviewManifestV1,
} from "./review-manifest"
import { PROMPT_VERSION } from "../prompts/pr-review"
import { runDepVulnScan, type ScanSkipReason as DepVulnSkipReason } from "./dep-vulns/scanner"
import { runAstRules } from "./ast-rules/runner"
import { renderAstFindingsForPrompt, renderAstFindingsAsJsonForSynth } from "./ast-rules/render"
import { postAstInlineFindings } from "./ast-rules/inline-poster"
import { runSarifEvidence, type ScanSkipReason as SarifSkipReason } from "./sarif-evidence/runner"
import {
  renderSarifFindingsForPrompt,
  renderSarifFindingsAsJsonForSynth,
} from "./sarif-evidence/render"
import { resolveSarifEvidenceConfig } from "./sigilix-config"
import { renderDepVulnFindingsForPrompt } from "./dep-vulns/render"
import {
  buildSigilixMarker,
  categoryFromRoleHint,
  markerSeverityFromScore,
} from "./review-memory/marker"
import { runReviewMemoryLookup } from "./review-memory/lookup"
import { renderReviewMemoryForPrompt } from "./review-memory/render"
import { resolveReviewMemoryConfig } from "./sigilix-config"
import type { ReviewMemorySkipReason } from "./review-memory/types"
import type { Env } from "../index"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// DEFAULT_MAX_MODEL_CALLS_PER_PR is configured via env but currently
// unused at the orchestrator level — Phase 4a relies on the per-call
// timeouts + the retrieve budget for cost control. Reserved for Phase
// 4b when the synthesizer's optional retrieve_codebase tool path is
// fully wired.
const DEFAULT_MAX_RETRIEVE_CALLS_PER_PR = 3
const DEFAULT_DAILY_BUDGET = 200

// Phase 4a.3 timeout schedule (rebalanced 2026-05-06 after Phase 4a.2
// telemetry validation, ARC-171). The Phase 4a.1 sizing (180s) was
// based on "median successful logic latency = 78s" — but that figure
// excluded the failed-aborted runs that were silently capped at 90s
// pre-Phase-4a.1 and 180s pre-Phase-4a.3. Real post-4a.2 telemetry
// (PR #45 record) showed `deepseek-v4-pro:cloud` consistently doing 2
// primary attempts of ~90s each, exhausting the 180s budget mid-
// second-attempt and killing the cross-provider fallback before it
// could fire.
//
// Sized to fit `2 primary attempts (2×90s) + retry backoff (~1s) +
// 1 cross-provider fallback attempt (~80s, kimi-k2.5:cloud)` = 261s,
// rounded up to 270s for slack. The static invariant test below
// regression-guards this so a future "tighten for headroom" change
// can't silently re-break the fallback firing.
export const SPECIALIST_TIMEOUT_MS = 270_000
// Synth on 4× 8K-token verdicts observed at 22-100s post-4a.2; 180s
// gives p99 headroom for cross-specialist disagreement cases. Kept
// unchanged in 4a.3 — observed margin is fine, and a tighter synth
// budget would mix concerns with the specialist rebalance.
export const SYNTHESIZER_TIMEOUT_MS = 180_000
// Reserved for pre-flight retrieval + diff parse + stale-head guards +
// telemetry write. The orchestrator must always have at least this much
// headroom beyond (specialist + synth) so a slow Vectorize round-trip
// doesn't eat into the synth budget.
export const RESERVED_HEADROOM_MS = 40_000
// 270 + 180 + 40 = 490. Cloudflare queue ceiling is 900s. The 90s
// orch bump (Phase 4a.3) is well under any user-perceptible review
// latency budget for background PR triage.
export const ORCHESTRATOR_TIMEOUT_MS = 490_000
// Cap the pre-flight Vectorize round-trip so a slow retrieval can't
// silently consume the synth budget. Failed pre-flight is non-fatal
// per v3.1 §8 — specialists fall back to empty snapshot.
export const RETRIEVAL_PREFLIGHT_TIMEOUT_MS = 15_000
// Phase 4a.4 (ARC-175): cap each individual model attempt inside
// `runWithRetryAndFallback` so a single slow primary call can't eat
// the entire `SPECIALIST_TIMEOUT_MS` budget and starve the retry +
// fallback. Telemetry on PR #47 (Phase 4a.3 era) showed v4-pro logic
// stalling for the full 270s on a single attempt with `attempts=1` —
// the budget extension just gave the primary more rope.
//
// Math under this cap: 2 × 85s primary + ~1s backoff + 85s fallback
// = ~256s, fits within the 270s SPECIALIST budget. Sized to leave
// each attempt enough room for v4-pro reasoning on real PRs (median
// successful logic latency was 78s on healthy runs) while still
// guaranteeing the fallback gets its slot.
export const PER_ATTEMPT_TIMEOUT_MS = 85_000
const SPECIALIST_VERDICT_TOKEN_CAP = 8_000
const MAX_ADVISORY_NITS = 5

// Static budget invariant — guarantees the synth always has its full
// 180s budget regardless of pre-flight + diff-parse + stale-head latency.
// Tripped → throws at module load, not at runtime, so misconfigured
// builds fail fast.
if (SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS > ORCHESTRATOR_TIMEOUT_MS) {
  throw new Error(
    `[ensemble] timeout invariant violated: ` +
      `SPECIALIST_TIMEOUT_MS (${SPECIALIST_TIMEOUT_MS}) + ` +
      `SYNTHESIZER_TIMEOUT_MS (${SYNTHESIZER_TIMEOUT_MS}) + ` +
      `RESERVED_HEADROOM_MS (${RESERVED_HEADROOM_MS}) ` +
      `must be ≤ ORCHESTRATOR_TIMEOUT_MS (${ORCHESTRATOR_TIMEOUT_MS}).`,
  )
}

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

export const SPECIALIST_CONFIGS: Record<SpecialistRole, ModelConfig> = {
  logic: {
    primary: "deepseek-v4-pro:cloud",
    // Phase 4a.1: dropped 2 → 1. Two retries at ~80s each = 240s of primary
    // attempts, exceeds the original 180s specialist budget. One retry +
    // cross-provider fallback gives better resilience per unit time,
    // validated by shadow telemetry showing 12/15 logic runs hit "Operation
    // aborted" at 90s wall.
    //
    // Phase 4a.3 (ARC-171): specialist budget extended to 270s. Two
    // retries (3 primary attempts ≈ 270s at the 90s/attempt observed
    // in Phase 4a.2 telemetry, + backoffs) would exceed the new budget
    // too, so retries=1 stays. The new headroom funds the cross-
    // provider fallback (kimi-k2.5:cloud) which Phase 4a.2 telemetry
    // proved was being killed by the 180s wall before it could fire.
    retries: 1,
    fallback: "kimi-k2.5:cloud",  // Moonshot — different infra than DeepSeek
  },
  security: {
    primary: "deepseek-v4-flash:cloud",  // known-working family member
    retries: 1,
    fallback: "qwen3-coder-next:cloud",  // cross-provider
  },
  performance: {
    // Phase 4a.1: glm-5.1 promoted from fallback → primary.
    // Shadow telemetry: glm-5.1 won 6/12 fallback runs, minimax was unreliable.
    primary: "glm-5.1:cloud",
    retries: 1,
    // Cross-provider fallback retained — kimi-k2.5 same family as logic's
    // fallback so we know it's reachable. Concentrates Moonshot risk on the
    // logic + perf fallback paths simultaneously (noted in v2 risk register).
    fallback: "kimi-k2.5:cloud",
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

export const SYNTHESIZER_CONFIG: ModelConfig = {
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
  // ARC-183: sensitive repo — skip ALL review pipelines. Sigilix
  // never fetches the diff or sends content to any LLM. Caller logs
  // the skip + reason for audit but performs no GitHub API call.
  | { primary: "skipped-sensitive"; reason: "repo_in_sensitive_denylist" }

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

  // ARC-183: sensitive-repo gate runs FIRST, before any other
  // routing logic. Even Phase 3 is blocked — the policy is "no LLM
  // ever sees this repo's content," not "use a different review
  // path." Match is case-insensitive on `owner/repo`.
  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    return { primary: "skipped-sensitive", reason: "repo_in_sensitive_denylist" }
  }

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

    // ARC-182: fetch open PRs in parallel with the full PR diff. Stack
    // detection needs the open-PR list to find downstack/upstack peers;
    // running the fetch here (after the stale-head guard, in parallel
    // with the diff) avoids an extra serial round-trip. Best-effort
    // with `.catch` → empty list = no-stack review (degraded but
    // correct).
    const [fullPrDiff, openPrsForStack] = await Promise.all([
      client.getPullRequestDiff(owner, repo, prNumber),
      client.listOpenPullRequests(owner, repo).catch((err) => {
        console.warn(
          JSON.stringify({
            event: "pr-stack-open-prs-fetch-failed",
            owner, repo, prNumber,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        return [] as ListOpenPullsItem[]
      }),
    ])

    // ARC-194: incremental review. If we've reviewed this PR before
    // and the current head SHA differs from the recorded one, fetch
    // the compare diff and use that — saves model spend on
    // iteration-heavy PRs where most pushes only touch a small subset
    // of files. Fail-safe: any error / suspicious shape falls back to
    // full diff so we never review LESS than what's open.
    const lastReviewed = await readLastReviewedSha(env, owner, repo, prNumber)
    let compareDiff: string | null = null
    if (lastReviewed !== null && lastReviewed.reviewedSha !== headSha) {
      try {
        compareDiff = await client.getCompareDiff(
          owner, repo, lastReviewed.reviewedSha, headSha,
        )
      } catch {
        compareDiff = null
      }
    }
    const diffSelection = selectDiff({
      fullDiff: fullPrDiff,
      compareDiff,
      previousSha: lastReviewed?.reviewedSha ?? null,
      currentHeadSha: headSha,
    })
    telemetry.incrementalReview = {
      mode: diffSelection.mode,
      ...(diffSelection.previousSha ? { previousSha: diffSelection.previousSha } : {}),
      ...(diffSelection.reason ? { reason: diffSelection.reason } : {}),
    }
    const fullDiff = diffSelection.diff

    // ARC-174: per-repo `sigilix.json` config. Read at the PR head SHA
    // so the guidance reflects whatever the PR author committed (lets
    // them iterate on the rules in the same PR). Always resolves —
    // missing or malformed config falls back to EMPTY_CONFIG. Loaded
    // BEFORE the diff split so ARC-176 pathFilters can drop files
    // before packing decides what to send to specialists.
    const sigilixConfig = await loadSigilixConfig(client, owner, repo, headSha)

    // ARC-192 + ARC-176: hunk-level diff packing with config-aware
    // filtering. Split the diff by file, drop files matched by
    // `sigilixConfig.pathFilters` (lockfiles, generated content, etc.
    // that shouldn't burn token budget), pack the remainder greedily
    // into batches under the per-call token cap. v1 reviews only the
    // FIRST batch; files in subsequent batches are recorded in
    // telemetry as `filesNotReviewed`. Files larger than the cap
    // individually are dropped via `filesDroppedTooLarge`. Multi-batch
    // with parallel specialist calls + verdict merge is the v2
    // enhancement; v1 ships the bound + telemetry.
    const splitFiles = splitDiffByFile(fullDiff)
    const filterPatterns = sigilixConfig.pathFilters ?? []
    const filesAfterFilter = filterPatterns.length === 0
      ? splitFiles
      : splitFiles.filter((f) => shouldReview(f.path, filterPatterns))
    const filesDroppedByFilter = filterPatterns.length === 0
      ? []
      : splitFiles.filter((f) => !shouldReview(f.path, filterPatterns)).map((f) => f.path)
    const { batches, droppedTooLarge } = packFilesIntoBatches(filesAfterFilter)
    const reviewedFiles = batches[0] ?? []
    const filesNotReviewed: string[] = batches.slice(1).flatMap((b) => b.map((f) => f.path))
    const diff = reviewedFiles.length === splitFiles.length && droppedTooLarge.length === 0
      ? fullDiff
      : batchToDiff(reviewedFiles)

    telemetry.diffPacking = {
      diffTokensEstimated: estimateTokens(fullDiff),
      totalFiles: splitFiles.length,
      batchCount: batches.length,
      filesReviewed: reviewedFiles.map((f) => f.path),
      filesDroppedTooLarge: droppedTooLarge,
      filesNotReviewed,
      ...(filesDroppedByFilter.length > 0 ? { filesDroppedByFilter } : {}),
    }

    const reviewable = parseDiffToReviewablePositions(diff)
    const filePaths = [...reviewable.keys()]

    // ARC-193: deterministic regex checks run BEFORE specialist fanout.
    // Hits become structured findings prepended to specialist prompts
    // as authoritative facts (LLM still weighs context). Cheap +
    // deterministic — closes the well-known LLM miss-rate gap on flat
    // patterns (TODO markers, console.log, hardcoded API-key shapes).
    const deterministicRunResult = runDeterministicChecks(
      diff,
      sigilixConfig.deterministicChecks ?? [],
    )
    const deterministicHits: DeterministicCheckHit[] = deterministicRunResult.hits
    if (deterministicHits.length > 0 || deterministicRunResult.compiledRegexFailures.length > 0) {
      telemetry.deterministicChecks = {
        hits: deterministicHits,
        compiledRegexFailures: deterministicRunResult.compiledRegexFailures,
      }
    }

    // ARC-187: secret scan. Built-in baseline rule set (AWS, GitHub,
    // Slack, Stripe, OpenAI, Anthropic keys + private-key PEM headers
    // + a generic high-entropy safety net). Hits are redacted before
    // anything reaches logs / prompts / telemetry — raw secrets never
    // leave the runner. Always-on; no config knob in v1 because secret
    // detection is baseline behavior, not opt-in.
    const secretHits: SecretHit[] = runSecretScan(diff)
    if (secretHits.length > 0) {
      telemetry.secretScan = {
        hitCount: secretHits.length,
        // Telemetry stores fingerprints (path:line:redacted) — never
        // the raw values. Lets post-hoc analysis dedupe across runs
        // without exposing the secret to KV reads.
        fingerprints: secretHits.map((h) => h.fingerprint),
      }
    }

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
    // Phase 4a.1: cap the pre-flight Vectorize round-trip so a slow
    // retrieval can't silently consume the synth budget. Failure here
    // is non-fatal (per v3.1 §8) — specialists fall back to empty
    // snapshot and may still call `retrieve_codebase` themselves.
    // Capture cache locally so the lambda below sees a non-null narrowing.
    const preflightCache = cache
    let preflightChunks: Awaited<ReturnType<typeof preflightCache.cachedRetrieve>>["chunks"] = null
    try {
      const preflight = await withComposedTimeout(
        () => preflightCache.cachedRetrieve({
          caller: "preflight",
          query: preflightQuery,
          namespace,
          fetcher: () => retrieveChunks({ text: preflightQuery, teamKey: namespace, env }),
        }),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      )
      preflightChunks = preflight.chunks
    } catch (err) {
      // If the orchestrator's outer signal aborted, propagate — that's a
      // genuine internal_error, not a pre-flight timeout.
      if (orchCtrl.signal.aborted) throw err
      // Pre-flight-only timeout / error. The cache itself wraps the
      // fetcher in its own try/catch so its log will eventually capture
      // the fetcher's outcome (success/error) once the background call
      // settles — we just stop awaiting it and proceed with an empty
      // snapshot. Total wall-clock vs. the cache log's elapsedMs lets
      // post-hoc analysis distinguish "we gave up at 15s" from "fetcher
      // threw a hard error".
      preflightChunks = null
    }
    const retrievalSnapshot = preflightChunks
      ? formatChunksForPrompt(preflightChunks) ?? ""
      : ""

    // ─── ARC-186: dependency-vulnerability scan ────────────────
    // Runs after secret-scan + deterministic-checks but BEFORE the
    // specialist fanout. Findings are pre-LLM facts injected alongside
    // the other deterministic blocks.
    const depVulnEnabled = sigilixConfig.depVulnScan?.enabled !== false
    const baseShaForDepVuln = meta.base?.sha ?? ""
    const depVulnResult = await runDepVulnScan({
      env,
      client,
      owner, repo, prNumber,
      headSha,
      baseSha: baseShaForDepVuln,
      enabled: depVulnEnabled,
    })
    const depVulnFindings = depVulnResult.skipped ? [] : depVulnResult.findings
    const depVulnBlock = renderDepVulnFindingsForPrompt(depVulnFindings)
    telemetry.depVulnScan = depVulnResult.skipped
      ? { skipped: true, reason: depVulnResult.reason, findingsCount: 0 }
      : {
          skipped: false,
          findingsCount: depVulnResult.findings.length,
          depsScanned: depVulnResult.depsScanned,
          manifestsScanned: depVulnResult.manifestsScanned,
        }

    // ─── ARC-181: AST rule-pack scan ────────────────────────────
    // Pre-LLM AST scan over pathFiltered JS/TS files.
    const astRulesConfig = resolveAstRulesConfig(sigilixConfig)
    const jsTsPaths = filePaths.filter((p) => /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(p))
    const astFilesByPath = new Map<string, string>()
    if (astRulesConfig.enabled && jsTsPaths.length > 0) {
      const fetchResults = await Promise.allSettled(
        jsTsPaths.map(async (p) => {
          const src = await client.getFileContent(owner, repo, p, headSha)
          return { p, src }
        }),
      )
      for (const r of fetchResults) {
        if (r.status === "fulfilled" && typeof r.value.src === "string") {
          astFilesByPath.set(r.value.p, r.value.src)
        }
      }
    }
    const astResult = await runAstRules({
      diff,
      filesByPath: astFilesByPath,
      reviewable,
      config: astRulesConfig,
      ctx: { owner, repo, prNumber },
    })
    const astBlock = renderAstFindingsForPrompt(astResult.findings)
    telemetry.astRules = astResult.telemetry.scanned
      ? {
          scanned: true,
          filesScanned: astResult.telemetry.filesScanned,
          filesSkippedLarge: astResult.telemetry.filesSkippedLarge,
          filesParseFailed: astResult.telemetry.filesParseFailed,
          findingsCount: astResult.findings.length,
          durationMs: astResult.telemetry.durationMs,
        }
      : {
          scanned: false,
          ...(astResult.telemetry.skipReason ? { skipReason: astResult.telemetry.skipReason } : {}),
          findingsCount: 0,
        }

    // ─── ARC-188: SARIF evidence channel ──────────────────────
    // Reads `.sigilix/trivy.sarif.json` (or configured path) at PR
    // head; emits Trivy / Kubescape / generic SARIF v2.1.0 findings
    // as authoritative facts alongside the other deterministic
    // blocks. SBOM (when present) goes to the synth prompt only.
    const sarifConfig = resolveSarifEvidenceConfig(sigilixConfig)
    const sarifResult = await runSarifEvidence({
      env, client, owner, repo, prNumber, headSha,
      diff, config: sarifConfig,
    })
    const sarifFindings = sarifResult.skipped ? [] : sarifResult.findings
    const sarifBlock = renderSarifFindingsForPrompt(sarifFindings)
    telemetry.sarifEvidence = sarifResult.skipped
      ? { skipped: true, reason: sarifResult.reason, findingsCount: 0 }
      : {
          skipped: false,
          findingsCount: sarifResult.findings.length,
          truncatedCount: sarifResult.telemetry.truncatedCount,
          durationMs: sarifResult.telemetry.durationMs,
        }

    // ─── Fan out specialists ────────────────────────────────────
    const deterministicBlock = renderHitsForPrompt(deterministicHits)
    const secretScanBlock = renderSecretHitsForPrompt(secretHits)
    // Combine all pre-LLM fact blocks. Order: secrets first
    // (highest severity), dep vulns, AST rules, SARIF (Trivy IaC +
    // CVE + license), regex deterministic checks last.
    const combinedFactsBlock = [secretScanBlock, depVulnBlock, astBlock, sarifBlock, deterministicBlock]
      .filter((s) => s.length > 0)
      .join("\n\n")
    void renderAstFindingsAsJsonForSynth // referenced by Task 8 synth wiring

    // ARC-181 Task 9: auto-inline poster — gated behind
    // `astRules.autoInline === true` AND mode === "post". Default-
    // false v1 cautious rollout; flips after 2 weeks of FP telemetry
    // shows < 5% rate.
    //
    // Posting is DEFERRED until the ensemble's own review submits
    // successfully (CR catch on PR #67) so an aborted run — stale
    // head SHA, synth_timeout, specialist failure-cascade — doesn't
    // leave orphan AST comments on a PR whose ensemble review never
    // landed. The closure captures everything we need; the two
    // submission-success paths below invoke it.
    const maybePostAstAutoInline = async (): Promise<void> => {
      if (mode !== "post") return
      if (!astRulesConfig.autoInline) return
      if (astResult.findings.length === 0) return
      try {
        await postAstInlineFindings({
          client,
          owner, repo, prNumber, headSha,
          findings: astResult.findings,
          perFindingPositions: astResult.perFinding,
        })
      } catch {
        // Swallowed — the poster's own try/catch already does this;
        // belt-and-suspenders so a poster bug never blocks the
        // ensemble's finalize.
      }
    }
    // ARC-182: compute stack context just before specialist fanout.
    // Stack detection is pure + cheap; the only async work is the
    // optional parent-files fetch when isStacked && parent. Render
    // a single stackBlock string and pass to BOTH specialist and
    // synth messages so they see the same context.
    const repoFullName = `${owner}/${repo}`
    const stack: StackContext = detectStack({
      currentPr: {
        number: prNumber,
        title: meta.title ?? "",
        headRef: meta.head?.ref ?? "",
        baseRef: meta.base?.ref ?? "",
        headRepo: repoFullName,
        baseRepo: repoFullName,
        author: meta.user?.login ?? null,
      },
      openPrs: openPrsForStack,
    })
    let stackOverlap: FileOverlap | undefined
    if (stack.isStacked && stack.parent) {
      const [currentFilesList, parentFilesList] = await Promise.all([
        // Reuse the diff-derived file list for the current PR — it's
        // already in memory (splitFiles) and the parent files fetch
        // is the only extra request.
        Promise.resolve(splitFiles.map((f) => ({ filename: f.path }))),
        client
          .listPullRequestFiles(owner, repo, stack.parent.number, { maxFiles: 100 })
          .catch(() => []),
      ])
      stackOverlap = computeFileOverlap({
        currentFiles: currentFilesList.map((f) => f.filename),
        parentFiles: parentFilesList.map((f) => f.filename),
      })
    }
    const stackBlock = stack.isStacked ? renderStackPromptBlock(stack, stackOverlap) : ""

    console.log(JSON.stringify({
      event: "pr-stack-context",
      owner, repo, prNumber,
      mode,
      isStacked: stack.isStacked,
      position: stack.position,
      depth: stack.depth,
      parentPrNumber: stack.parent?.number ?? null,
      childCount: stack.children.length,
      openPrCount: openPrsForStack.length,
      openPrsTruncated: openPrsForStack.length >= 200,
      cycleDetected: stack.cycleDetected,
      stackWalkCapped: stack.stackWalkCapped,
      hasUpstackFork: stack.hasUpstackFork,
      overlapShared: stackOverlap?.sharedCount ?? null,
      overlapCurrentOnly: stackOverlap?.currentOnlyCount ?? null,
    }))

    const baseInitialMessage = buildSpecialistInitialMessage({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff,
      retrievalSnapshot,
      namespace,
      ...(sigilixConfig.guidance ? { guidance: sigilixConfig.guidance } : {}),
      ...(sigilixConfig.profile ? { profile: sigilixConfig.profile } : {}),
      ...(combinedFactsBlock ? { deterministicChecksBlock: combinedFactsBlock } : {}),
      ...(stackBlock.length > 0 ? { stackBlock } : {}),
    })

    const specialistResults = await Promise.allSettled(
      router.specialists.map((role) =>
        withComposedTimeout(
          // Use the composed signal `withComposedTimeout` provides — it
          // aborts on EITHER the per-specialist 270s timer OR the outer
          // orch abort. Passing `orchCtrl.signal` directly only cancels
          // the await wrapper, leaving the in-flight model fetch alive
          // until the outer 490s wall fires (CR catch on PR #42).
          (signal) => runSpecialist({
            role,
            apiKey: env.OLLAMA_API_KEY,
            systemPrompt: SPECIALIST_PROMPTS[role],
            initialMessage: appendRoleRule(baseInitialMessage, role, sigilixConfig),
            chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
            signal,
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
      ...(sigilixConfig.guidance ? { guidance: sigilixConfig.guidance } : {}),
      ...(stackBlock.length > 0 ? { stackBlock } : {}),
    })

    // ARC-181 Task 8: thread structured AST findings into the synth
    // prompt for (path, line, role_hint) supersession matching.
    const astFindingsForSynth = renderAstFindingsAsJsonForSynth(astResult.findings)
    const synthMessageWithAst = astFindingsForSynth.length > 0
      ? `${synthMessage}\n\n[AST RULE FINDINGS — pre-LLM, structured]\n\nMatch these against specialist findings on \`(path, line, role_hint)\` triple. When a specialist finding shares ALL THREE with an AST entry, drop it from your output and include \`{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<id>" }\` in \`provenance.dropped[]\`. Cross-role matches (e.g. AST=security vs specialist=performance) do NOT supersede.\n\n\`\`\`json\n${astFindingsForSynth}\n\`\`\``
      : synthMessage

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
    })
    const memoryBlock = reviewMemoryResult.skipped
      ? ""
      : renderReviewMemoryForPrompt(reviewMemoryResult.findings)
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
    let synthOutput: Awaited<ReturnType<typeof runSynthesizer>> | undefined
    const synthStartMs = Date.now()
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
      synthOutput = await withComposedTimeout(
        // Use the composed signal so a synth-only 180s timeout actually
        // cancels the underlying model call. Passing `orchCtrl.signal`
        // directly only rejects this await; the in-flight model fetch
        // would keep running until the outer 490s orch wall fires
        // (CR catch on PR #42).
        (signal) => runSynthesizer({
          apiKey: env.OLLAMA_API_KEY,
          systemPrompt: synthSystemPrompt,
          userMessage: synthMessageWithMemory,
          chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
          signal,
          ...(synthConfigOverride ? { configOverride: synthConfigOverride } : {}),
        }),
        SYNTHESIZER_TIMEOUT_MS,
        orchCtrl.signal,
      )
    } catch (err) {
      // If the orchestrator's outer signal aborted, propagate — outer
      // timeout is a genuine internal_error and lands in the top-level
      // catch as before.
      if (orchCtrl.signal.aborted) throw err
      // Synth-local timeout. Record as a structured synth failure and
      // short-circuit through the failure path. Quorum already passed
      // so this is a synth-only fall-back.
      telemetry.synthesizer = {
        model: SYNTHESIZER_MODEL,
        modelUsed: SYNTHESIZER_MODEL,
        attemptsUsed: 1,
        verdict: null,
        provenance: null,
        retrievalCallsUsed: 0,
        elapsedMs: Date.now() - synthStartMs,
        timedOut: true,
        failureReason: "synth_timeout",
      }
      telemetry.fellBackToPhase3 = mode === "post"
      telemetry.fellBackReason = "synth_timeout"
      return finalize(telemetry, env, "skipped", cache)
    }

    // Phase 4a.2: withComposedTimeout no longer throws when its own
    // timer or the orch signal aborts an abort-aware factory — it
    // returns the factory's structured wrapFailure with
    // failureReason="aborted". That now reaches this branch instead of
    // the synth_timeout catch above, so derive timedOut + fellBackReason
    // here too. Without this, synth-timer aborts would silently land in
    // synth_failed_parse with timedOut=false (CR catch on PR #44).
    const synthFailureReason = synthOutput.failureReason ?? ""
    const synthAborted = /abort/i.test(synthFailureReason) || /timeout/i.test(synthFailureReason)

    const synthEntry: NonNullable<EnsembleTelemetry["synthesizer"]> = {
      model: SYNTHESIZER_MODEL,
      modelUsed: synthOutput.modelUsed,
      attemptsUsed: synthOutput.attemptsUsed,
      verdict: synthOutput.verdict,
      provenance: synthOutput.provenance,
      retrievalCallsUsed: 0,  // Phase 4a synth doesn't use retrieve; reserved for Phase 4b
      elapsedMs: synthOutput.elapsedMs,
      timedOut: synthAborted,
    }
    if (synthOutput.failureReason) synthEntry.failureReason = synthOutput.failureReason
    if (synthOutput.failureRawAnswer) synthEntry.failureRawAnswer = synthOutput.failureRawAnswer
    telemetry.synthesizer = synthEntry

    if (!synthOutput.verdict || !synthOutput.provenance) {
      telemetry.fellBackToPhase3 = mode === "post"
      telemetry.fellBackReason = synthAborted
        ? "synth_timeout"
        : synthOutput.failureReason === "synth_invalid_provenance"
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
      // Shadow: telemetry only, no GitHub submission. Deliberately
      // do NOT write the last-reviewed SHA — shadow runs don't post
      // findings, so a later real review must still see the full
      // base..head diff to surface them. Recording the shadow SHA
      // would cause subsequent post-mode runs to incrementally
      // review only `shadowSha..head` and miss everything before
      // (sigilix-bot dogfood catch on PR #53).
      telemetry.shadowVerdict = validated.verdict
      return finalize(telemetry, env, "shadow_recorded", cache)
    }

    // ARC-194: record the SHA we just reviewed (post mode only) so
    // subsequent pushes can fetch the compare diff (`reviewedSha...
    // newHead`) instead of the full PR diff. Best-effort — write
    // failures don't fail the run; next push falls back to full diff
    // and re-establishes the marker on the following review.
    await writeLastReviewedSha(env, owner, repo, prNumber, headSha)

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
    // Pass `unanchoredFindings` to the primary submission so any
    // findings that failed line-validity are still rolled into the
    // body (instead of being recovered ONLY when the inline submit
    // fails). CR PR #38 catch — without this, GitHub's success path
    // silently drops the unanchored set.
    //
    // ARC-189 Task 10b: apply review-memory soften BEFORE rendering.
    // The synth's `provenance.softened[]` references specialist
    // sourceFindingIds (e.g., "logic-3"); for each kept finding whose
    // provenance.sourceFindingIds intersects the softened set, build
    // a CLONE of the finding with `score = Math.max(1, score - 1)`.
    // Original finding objects are NEVER mutated (Kimi MINOR on plan
    // v2 — preserves immutability for downstream telemetry).
    const softenedSet = new Set<string>()
    if (synthOutput.provenance?.softened) {
      for (const s of synthOutput.provenance.softened) {
        if (typeof s.sourceFindingId === "string") {
          softenedSet.add(s.sourceFindingId)
        }
      }
    }
    let softenedCount = 0
    const renderableFindings = validated.verdict.findings.map((f, i) => {
      const sourceIds = validated.cleanFindingProvenance[i]?.sourceFindingIds ?? []
      const matched = sourceIds.some((id) => softenedSet.has(id))
      if (!matched) return f
      const effectiveScore = Math.max(1, f.score - 1)
      if (effectiveScore === f.score) return f  // already at floor
      softenedCount++
      return { ...f, score: effectiveScore }
    })
    const renderableUnanchored = validated.unanchoredFindings  // unanchored never matches by index
    const renderableVerdict: PrReviewVerdict = {
      ...validated.verdict,
      findings: renderableFindings,
    }
    if (softenedCount > 0) {
      console.log(JSON.stringify({
        event: "review-memory-softened-rendered",
        owner, repo, prNumber, softenedCount,
      }))
    }

    // ARC-189: pre-compute the per-finding sigilix marker BEFORE
    // calling buildReviewSubmission so marker construction (async via
    // crypto.subtle) doesn't force the whole renderer async. Markers
    // align by index with `validated.verdict.findings` AND
    // `validated.cleanFindingProvenance` — the same walk in
    // validateForSubmission produced both. Findings with no source
    // specialist (defensive, shouldn't happen post-hallucination
    // guard) emit `null` and skip the marker.
    //
    // Marker severity uses the ORIGINAL (pre-soften) score so the
    // marker reflects what synth actually emitted; the soften
    // applies to the rendered finding body only.
    const findingMarkers: Array<string | null> = await Promise.all(
      validated.verdict.findings.map(async (f, i) => {
        const sourceSpec = validated.cleanFindingProvenance[i]?.sourceSpecialists?.[0]
        if (!sourceSpec) return null
        return await buildSigilixMarker({
          ruleId: null,
          path: f.path,
          line: f.line,
          headline: f.headline,
          category: categoryFromRoleHint(sourceSpec),
          severity: markerSeverityFromScore(f.score),
        })
      }),
    )
    const submission = buildReviewSubmission({
      verdict: renderableVerdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
      unanchored: renderableUnanchored,
      findingMarkers,
      // ARC-182 (code-review C1): thread stack so the "### Stack
      // context" sticky-summary block actually renders on ensemble
      // reviews. Without this the block only appears on single-model
      // path (handlePrReview) — which is the dev/legacy path. Most
      // production reviews go through this ensemble entry point.
      ...(stack.isStacked ? { stack } : {}),
    })
    try {
      const submitted = await client.submitReview(owner, repo, prNumber, submission)
      telemetry.submitted = true
      // ARC-184: write review-provenance manifest. Best-effort.
      await writeReviewManifestForEnsemble({
        env, client, owner, repo, prNumber,
        headSha,
        baseSha: meta.base?.sha ?? "",
        modelId: "ensemble-synth",
        reviewId: submitted.id,
      })
      await maybePostAstAutoInline()
      return finalize(telemetry, env, "posted", cache)
    } catch (submitErr) {
      // Narrow the fallback to GitHub HTTP 422 (Unprocessable Entity)
      // — that's the specific status GitHub returns when an inline
      // anchor is invalid. CR PR #38 round-2 catch: the original
      // catch-all retry was unsafe because `POST /pulls/{n}/reviews`
      // is non-idempotent. A timeout / network error after GitHub
      // accepted the first submission would have produced a duplicate
      // review on retry. Rethrow anything that isn't a 422 so the
      // outer try/catch records it as `internal_error` (the original
      // pre-fallback behaviour for those failure modes).
      //
      // I originally chose "catch any error" via the dispatch Q&A
      // because it sounded more defensive. Round-2 review showed the
      // opposite — the broader catch creates a worse failure mode.
      if (
        !(submitErr instanceof GitHubHttpError) ||
        submitErr.status !== 422
      ) {
        throw submitErr
      }
      const fallbackReason = `HTTP 422 ${submitErr.message}`
      // Set telemetry BEFORE the fallback submit. If the fallback
      // ALSO fails, the outer catch overwrites `internalError` but
      // these two fields stay set — preserves the "we attempted a
      // fallback" signal that Phase 4b shadow-mode monitoring needs.
      // CR PR #38 round-2 catch.
      telemetry.submitFallback = true
      telemetry.submitFallbackReason = fallbackReason
      console.warn("[ensemble] inline submit rejected (HTTP 422); falling back to anchorless review", {
        owner,
        repo,
        prNumber,
        reason: fallbackReason,
      })
      const fallback = buildFallbackSubmission({
        // ARC-189: fallback path also receives the soften-applied
        // verdict. Markers are NOT emitted on the fallback (it's a
        // body-only review with no inline anchors) — see Task 2.5.
        verdict: renderableVerdict,
        unanchored: renderableUnanchored,
        prAuthor: meta.user?.login ?? null,
        headSha,
        // ARC-182 (code-review C1): thread stack to the anchorless
        // fallback as well — the stack-context block belongs in the
        // body regardless of whether inline anchoring succeeded.
        ...(stack.isStacked ? { stack } : {}),
      })
      const submittedFallback = await client.submitReview(owner, repo, prNumber, fallback)
      telemetry.submitted = true
      // ARC-184: write manifest for the fallback path too. Same target
      // shape (kind: "review") because the fallback is still a GitHub
      // review (just anchorless body).
      await writeReviewManifestForEnsemble({
        env, client, owner, repo, prNumber,
        headSha,
        baseSha: meta.base?.sha ?? "",
        modelId: "ensemble-synth",
        reviewId: submittedFallback.id,
      })
      await maybePostAstAutoInline()
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

// ─── ARC-184 manifest helper ──────────────────────────────────────────

/**
 * Best-effort write of the review-provenance manifest from the
 * ensemble post-mode submit paths. Captures the full manifest shape
 * required by Linear AC #1 (head/base/merge-base SHAs, file-list hash,
 * prompt version, model id, target id). KV write failures degrade
 * gracefully — never block the review flow.
 *
 * Skipped when the kill-switch is set: `OPENCLAW_REVIEW_MANIFEST_ENABLED=off`.
 */
async function writeReviewManifestForEnsemble(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  modelId: string
  reviewId: number
}): Promise<void> {
  const { env, client, owner, repo, prNumber, headSha, baseSha, modelId, reviewId } = args
  if (env.OPENCLAW_REVIEW_MANIFEST_ENABLED === "off") return
  try {
    const [files, mergeBaseSha] = await Promise.all([
      client.listPullFilesForManifest(owner, repo, prNumber),
      baseSha ? client.getMergeBase(owner, repo, baseSha, headSha) : Promise.resolve(null),
    ])
    const fileListHash = await computeFileListHash(files)
    const manifest: ReviewManifestV1 = {
      v: 1,
      prNumber,
      baseSha,
      headSha,
      mergeBaseSha,
      fileListHash,
      promptVersion: PROMPT_VERSION,
      modelId,
      target: { kind: "review", reviewId },
      reviewedAt: Date.now(),
    }
    const ok = await writeReviewManifest(env, owner, repo, prNumber, manifest)
    if (ok) {
      console.log(JSON.stringify({
        event: "review-manifest-written",
        owner, repo, prNumber,
        headSha, baseSha, modelId,
        promptVersion: PROMPT_VERSION,
        target: { kind: "review", id: reviewId },
      }))
    } else {
      console.error(JSON.stringify({
        event: "review-manifest-write-failed",
        owner, repo, prNumber,
        err: "writeReviewManifest returned false",
      }))
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "review-manifest-write-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * ARC-174: append the per-role rule from `sigilix.json` to a
 * specialist's initial message. No-op when the config defines no rule
 * for that role. The role-specific rule is rendered as a labeled
 * block so the specialist can clearly attribute it to repo config
 * rather than mistake it for ambient context.
 */
function appendRoleRule(
  baseMessage: string,
  role: SpecialistRole,
  config: SigilixConfig,
): string {
  const rule = config.rules?.[role]
  if (!rule) return baseMessage
  return `${baseMessage}\n\n[REPO RULES — ${role.toUpperCase()} (from sigilix.json)]\n${rule}`
}

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
export const MAX_CALLS_PER_ENSEMBLE_RUN = (
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
  /**
   * Phase 4a.4 (ARC-175): per-attempt timeout cap. Each individual
   * `attemptChat` call aborts after this many ms so a single slow
   * primary can't eat the entire `SPECIALIST_TIMEOUT_MS` budget.
   * Defaults to `PER_ATTEMPT_TIMEOUT_MS` (85s) — tests pass a smaller
   * value to exercise the abort path without real-time waits.
   */
  perAttemptTimeoutMs?: number
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}> {
  const { config, apiKey, messages, signal, chatEnabled, format, parseAnswer, parseFailureLabel, startedAt } = args
  const perAttemptCap = args.perAttemptTimeoutMs ?? PER_ATTEMPT_TIMEOUT_MS

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
    // Phase 4a.4: per-attempt cap. attemptChat already returns a
    // structured failure on AbortError (its inner try/catch catches
    // chat()'s thrown abort), so withComposedTimeout's grace path
    // observes a settled `{verdict: null, failureReason: ...}` and
    // returns it cleanly — no extra throw/catch needed here.
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({
        model: config.primary, apiKey, messages, signal: perAttemptSignal,
        chatEnabled, format, parseAnswer, parseFailureLabel,
      }),
      perAttemptCap,
      signal,
    )
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
    const fallbackModel = config.fallback
    attemptsUsed++
    // Phase 4a.4: same per-attempt cap on the fallback. The fallback
    // gets one shot — capped — so even if the cross-provider model is
    // also slow, the overall specialist run finishes within budget.
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({
        model: fallbackModel, apiKey, messages, signal: perAttemptSignal,
        chatEnabled, format, parseAnswer, parseFailureLabel,
      }),
      perAttemptCap,
      signal,
    )
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
  /**
   * ARC-185: per-PR synthesizer config override sourced from
   * `commands.review.{model.primary, model.fallbacks}` in
   * `sigilix.json`. When undefined, the runner uses the
   * `SYNTHESIZER_CONFIG` constant (current default behavior).
   *
   * v1 limitation: `ModelConfig.fallback` is a single string; if
   * the user supplies multiple fallbacks, only the first is used at
   * the synth path. The user-facing API still accepts an array (so
   * the schema doesn't churn when we extend the runtime support)
   * but the runtime drops the tail. Telemetry records the count.
   */
  configOverride?: ModelConfig
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
  /**
   * ARC-189: findings the synth softened in response to a [REVIEW
   * MEMORY] block (matched on category, optionally on pathSha12 for
   * path-scoped memories). Optional + sparse: synths emitting
   * pre-v2 outputs (no review memory) omit this field, which
   * `isValidProvenance` accepts. The renderer applies a one-tier
   * `score` decrement on the matched finding before posting.
   */
  softened?: Array<{
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
  const effectiveConfig: ModelConfig = args.configOverride ?? SYNTHESIZER_CONFIG
  if (!args.apiKey) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: effectiveConfig.primary,
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
    config: effectiveConfig,
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
  // ARC-189: `softened` is OPTIONAL on the wire (synth outputs from
  // pre-v2 prompts omit it). When present, must be an array of
  // object-shaped entries. The renderer dereferences
  // `softened[i].sourceFindingId` to look up the corresponding
  // finding for score-decrement, so we tighten the per-item check
  // to require a string-shaped sourceFindingId — same belt-and-
  // suspenders pattern as the findings.sourceFindingIds[] guard.
  if (v.softened !== undefined) {
    if (!Array.isArray(v.softened)) return false
    for (const s of v.softened) {
      if (!s || typeof s !== "object" || Array.isArray(s)) return false
      const entry = s as Record<string, unknown>
      if (typeof entry.sourceFindingId !== "string") return false
    }
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
      // Phase 4a.2: aborts (timer- or parent-signal-driven) now reach
      // this branch via withComposedTimeout's grace window — the
      // factory's structured wrapFailure(reason="aborted", ...) flows
      // through Promise.allSettled as a fulfilled value with verdict
      // null. Derive timedOut from the reason string so timer-driven
      // aborts stay visible in telemetry. The reason can be the
      // canonical "aborted" (signal.aborted check between attempts),
      // a DOMException message like "The operation was aborted." (when
      // fetch threw mid-attempt), or `fallback_failed: ... aborted`
      // (primary AND fallback both aborted) — a single /abort/i regex
      // captures all three.
      const reason = value.failureReason ?? ""
      const telEntry: EnsembleTelemetry["specialistVerdicts"][number] = {
        role,
        model: SPECIALIST_MODELS[role],
        modelUsed: value.modelUsed,
        attemptsUsed: value.attemptsUsed,
        verdict: null,
        elapsedMs: value.elapsedMs,
        timedOut: /abort/i.test(reason) || /timeout/i.test(reason),
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
  /**
   * ARC-189: per-clean-finding provenance, aligned by INDEX with
   * `verdict.findings`. Captured during the same walk that filters
   * findings so the ensemble caller can derive the source specialist
   * for each surviving finding without re-walking with the same
   * filter rules. Used by Task 2.5 marker emission to map each
   * finding to its `ReviewMemoryCategory`.
   */
  cleanFindingProvenance: SynthesizerProvenance["findings"]
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
  const cleanFindingProvenance: SynthesizerProvenance["findings"] = []
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
    // ARC-189: keep the per-clean-finding provenance aligned by index
    // for the ensemble caller's marker-emission step. `provenance` is
    // narrowed by the hallucination guard above (sourceIds.length >= 1
    // implies provenance was non-null).
    if (provenance) cleanFindingProvenance.push(provenance)
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
    cleanFindingProvenance,
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
    | { scanned: true; filesScanned: number; filesSkippedLarge: number; filesParseFailed: number; findingsCount: number; durationMs: number }
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
