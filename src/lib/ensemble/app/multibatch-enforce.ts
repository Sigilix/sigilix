import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { Env } from "@/src/shared/types/env"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { parseDiffToReviewablePositions, type ReviewableMap } from "@/src/shared/util/diff-positions"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { batchToDiff, estimateTokens, type DiffFileBlock } from "@/src/lib/diff-packing"
import type { PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import { decideNextBatchLaunchWithBudget } from "@/src/lib/ensemble/domain/multibatch-budget"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import { namespaceFindingId } from "@/src/lib/ensemble/domain/multibatch-finding-id"
import { type SigilixConfig, resolveSpecialistMcpTools } from "@/src/lib/sigilix-config"
import { applyLogicPromptBudget, type LogicPromptBudgetMode } from "@/src/lib/logic-prompt-budget"
import { modelApiKeys, runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import { specialistSystemPrompt } from "@/src/prompts/pr-review-specialists"
import { appendRoleRule } from "@/src/lib/ensemble/app/role-message"
import { isHighRiskPath } from "@/src/lib/ensemble/domain/resweep"
import { composeSignals } from "@/src/lib/ensemble/domain/shadow-grace"
import { renderHitsForPrompt, runDeterministicChecks } from "@/src/shared/domain/deterministic-checks"
import { renderSecretHitsForPrompt, runSecretScan } from "@/src/lib/secret-scan"
import { buildSecurityFactManifest, type SecurityFactManifest } from "@/src/lib/security-evidence-manifest"

export type MultiBatchHaltReason = "deadline" | "synth-input-cap" | "context-token-cap"

const MIN_USEFUL_BATCH_MS = 60_000
export const MAX_MULTIBATCH_SYNTH_INPUT_CHARS = 256_000

export interface EnforcedReviewUnionArgs {
  reviewedFiles: readonly DiffFileBlock[]
  launchedBatches: readonly (readonly DiffFileBlock[])[]
  unlaunchedBatches: readonly (readonly DiffFileBlock[])[]
  droppedTooLarge: readonly string[]
}

export interface EnforcedReviewUnion {
  reviewedFiles: DiffFileBlock[]
  filesNotReviewed: string[]
  disclosureSkipped: string[]
  diff: string
  reviewable: ReviewableMap
  filePaths: string[]
}

export function buildEnforcedReviewUnion(args: EnforcedReviewUnionArgs): EnforcedReviewUnion {
  const reviewedFiles = [...args.reviewedFiles, ...args.launchedBatches.flatMap((batch) => [...batch])]
  const filesNotReviewed = args.unlaunchedBatches.flatMap((batch) => batch.map((file) => file.path))
  const diff = batchToDiff(reviewedFiles)
  const reviewable = parseDiffToReviewablePositions(diff)
  return {
    reviewedFiles,
    filesNotReviewed,
    disclosureSkipped: [...filesNotReviewed, ...args.droppedTooLarge],
    diff,
    reviewable,
    filePaths: [...reviewable.keys()],
  }
}

export function namespaceBatchVerdict(
  role: SpecialistRole,
  batchIdx: number,
  verdict: PrReviewVerdict,
): PrReviewVerdictWithIds {
  return {
    ...verdict,
    findings: verdict.findings.map((finding, idx) => ({
      ...finding,
      id: namespaceFindingId(role, batchIdx, idx),
    })),
  }
}

export async function buildBatchFactBlockForRole(args: {
  role: SpecialistRole
  batchDiff: string
  sigilixConfig: SigilixConfig
}): Promise<string> {
  if (args.role === "logic") {
    return renderHitsForPrompt(
      runDeterministicChecks(args.batchDiff, args.sigilixConfig.deterministicChecks ?? []).hits,
    )
  }
  if (args.role !== "security") return ""
  const secretHits = runSecretScan(args.batchDiff)
  if (secretHits.length === 0) return ""
  const manifest = await buildSecurityFactManifest({
    secretHits,
    depVulnFindings: [],
    sarifFindings: [],
    astSecurityFindings: [],
  })
  return [renderSecretHitsForPrompt(secretHits), manifest.render()].filter((block) => block.length > 0).join("\n\n")
}

export async function mergeSecurityManifestWithUnionSecrets(
  base: SecurityFactManifest,
  unionDiff: string,
): Promise<SecurityFactManifest> {
  const secretHits = runSecretScan(unionDiff)
  if (secretHits.length === 0) return base
  const unionSecretManifest = await buildSecurityFactManifest({
    secretHits,
    depVulnFindings: [],
    sarifFindings: [],
    astSecurityFindings: [],
  })
  if (unionSecretManifest.manifest.size === 0) return base
  const manifest = new Map(base.manifest)
  for (const [id, fact] of unionSecretManifest.manifest) manifest.set(id, fact)
  return {
    manifest,
    render: () => [base.render(), unionSecretManifest.render()].filter((block) => block.length > 0).join("\n\n"),
  }
}

export interface SynthCoverageScopeInput {
  reviewedFiles: readonly string[]
  skippedFiles: readonly string[]
  haltReason: MultiBatchHaltReason | null
}

export function renderSynthCoverageScopeBlock(input: SynthCoverageScopeInput): string {
  if (input.skippedFiles.length === 0) return ""
  const total = input.reviewedFiles.length + input.skippedFiles.length
  const haltLine =
    input.haltReason === "deadline"
      ? "Deadline/budget halted before every changed file could be launched."
      : input.haltReason === "synth-input-cap"
        ? "Synth-input budget halted before another batch could be launched without truncating source findings."
        : input.haltReason === "context-token-cap"
          ? "Total-context token ceiling halted before another batch could be launched (this PR exceeds the per-review context budget)."
          : "Coverage is partial."
  return [
    "[REVIEW COVERAGE SCOPE]",
    `Reviewed files (${input.reviewedFiles.length}/${total}): ${input.reviewedFiles.join(", ")}`,
    `Skipped or not launched files (${input.skippedFiles.length}/${total}): ${input.skippedFiles.join(", ")}`,
    haltLine,
    "Constraints:",
    "- Do NOT describe the whole PR as fully reviewed.",
    "- Do NOT claim zero risk, no production logic changed, or no issues for the whole PR.",
    "- Scope summary claims to the reviewed files and explicitly mention pending skipped files.",
    "",
  ].join("\n")
}

export interface SynthInputCapInput {
  currentUnionInputChars: number
  candidateBatchDiffChars: number
  maxSynthInputChars: number
}

export function shouldHaltForSynthInputCap(input: SynthInputCapInput): {
  halt: boolean
  reason: "synth-input-cap" | null
} {
  const wouldUse = input.currentUnionInputChars + input.candidateBatchDiffChars
  return wouldUse > input.maxSynthInputChars ? { halt: true, reason: "synth-input-cap" } : { halt: false, reason: null }
}

export interface ContextTokenCapInput {
  /** Estimated INPUT tokens the whole review has spent so far (batch[0] + resweep +
   *  every spillover batch already launched, each counted across all roles). */
  cumulativeInputTokensEst: number
  /** Estimated INPUT tokens the candidate batch would add (its diff, per role). */
  candidateBatchInputTokensEst: number
  /** The giant-PR total-context ceiling (`SIGILIX_MAX_REVIEW_CONTEXT_TOKENS`). */
  maxReviewContextTokens: number
}

/**
 * Giant-PR total-context ceiling. Halts spillover-batch launching once the whole
 * review's cumulative estimated input tokens would cross `maxReviewContextTokens`.
 * Recall-safe: the posted batch[0] is already reviewed before spillover starts, so
 * this only trims the diminishing-returns tail of a rare giant multi-batch PR. A
 * normal PR never reaches the ceiling → the loop never halts here → byte-identical.
 */
export function shouldHaltForContextTokenCap(input: ContextTokenCapInput): {
  halt: boolean
  reason: "context-token-cap" | null
} {
  const wouldUse = input.cumulativeInputTokensEst + input.candidateBatchInputTokensEst
  return wouldUse > input.maxReviewContextTokens
    ? { halt: true, reason: "context-token-cap" }
    : { halt: false, reason: null }
}

export interface CrossBatchSeamInput {
  reviewedBatches: readonly (readonly DiffFileBlock[])[]
  unlaunchedBatches: readonly (readonly DiffFileBlock[])[]
  graphBlastCallerPaths: readonly string[]
  graphBlastDependentPaths: readonly string[]
}

export function selectCrossBatchSeamFiles(input: CrossBatchSeamInput): DiffFileBlock[] {
  const skipped = new Set(input.unlaunchedBatches.flatMap((batch) => batch.map((file) => file.path)))
  const connected = new Set([...input.graphBlastCallerPaths, ...input.graphBlastDependentPaths])
  const batchByPath = new Map<string, number>()
  const fileByPath = new Map<string, DiffFileBlock>()
  input.reviewedBatches.forEach((batch, batchIdx) => {
    for (const file of batch) {
      batchByPath.set(file.path, batchIdx)
      fileByPath.set(file.path, file)
    }
  })
  const connectedReviewed = [...connected].filter((path) => batchByPath.has(path) && !skipped.has(path))
  const connectedBatchIds = new Set(connectedReviewed.map((path) => batchByPath.get(path)!))
  if (connectedBatchIds.size < 2) return []
  return connectedReviewed.flatMap((path) => {
    const file = fileByPath.get(path)
    return file !== undefined && isHighRiskPath(path) ? [file] : []
  })
}

export interface MultiBatchRoleRunArgs {
  role: SpecialistRole
  batchIdx: number
  batchDiff: string
  timeoutMs: number
  perfCtx: EnsembleRunCtx
  signal: AbortSignal
}

export interface RunMultiBatchEnforceArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  startMs: number
  spilloverBatches: readonly (readonly DiffFileBlock[])[]
  roles: readonly SpecialistRole[]
  currentSourceJsonChars: number
  maxSynthInputChars: number
  /** Giant-PR total-context ceiling (`SIGILIX_MAX_REVIEW_CONTEXT_TOKENS`). Spillover
   *  halts once the cumulative estimated input tokens would cross it. */
  maxReviewContextTokens: number
  /** Estimated input tokens already spent BEFORE spillover (batch[0] + resweep,
   *  across roles) — the starting point for the total-context accumulator. */
  priorInputTokensEst: number
  firstBatchIdx?: number
  runRole: (args: MultiBatchRoleRunArgs) => Promise<PrReviewVerdict | null>
}

export interface MultiBatchEnforceResult {
  collected: CollectedVerdict[]
  launchedBatches: DiffFileBlock[][]
  unlaunchedBatches: DiffFileBlock[][]
  batchesLaunched: number
  haltedEarly: boolean
  haltReason: MultiBatchHaltReason | null
}

export async function runMultiBatchEnforce(args: RunMultiBatchEnforceArgs): Promise<MultiBatchEnforceResult> {
  const collected: CollectedVerdict[] = []
  const launchedBatches: DiffFileBlock[][] = []
  let haltReason: MultiBatchHaltReason | null = null
  let currentUnionInputChars = args.currentSourceJsonChars
  let cumulativeInputTokensEst = args.priorInputTokensEst
  let nextBatchIndex = args.spilloverBatches.length

  for (let k = 0; k < args.spilloverBatches.length; k++) {
    const batch = [...args.spilloverBatches[k]!]
    const batchDiff = batchToDiff(batch)
    // Giant-PR total-context ceiling FIRST (outermost budget): a batch is re-sent to
    // every role, so its marginal input ≈ diff tokens × role count. Halt before
    // launching if the whole review would cross the ceiling. batch[0] is already
    // reviewed, so this only trims the tail of a rare giant PR.
    const candidateBatchInputTokensEst = estimateTokens(batchDiff) * args.roles.length
    const contextCapDecision = shouldHaltForContextTokenCap({
      cumulativeInputTokensEst,
      candidateBatchInputTokensEst,
      maxReviewContextTokens: args.maxReviewContextTokens,
    })
    if (contextCapDecision.halt) {
      haltReason = contextCapDecision.reason
      nextBatchIndex = k
      break
    }
    const capDecision = shouldHaltForSynthInputCap({
      currentUnionInputChars,
      candidateBatchDiffChars: batchDiff.length,
      maxSynthInputChars: args.maxSynthInputChars,
    })
    if (capDecision.halt) {
      haltReason = capDecision.reason
      nextBatchIndex = k
      break
    }

    const decision = decideNextBatchLaunchWithBudget({
      startMs: args.startMs,
      now: Date.now(),
      minUsefulBatchMs: MIN_USEFUL_BATCH_MS,
    })
    if (!decision.canLaunchNextBatch) {
      haltReason = "deadline"
      nextBatchIndex = k
      break
    }

    currentUnionInputChars += batchDiff.length
    const batchIdx = (args.firstBatchIdx ?? 1) + k
    const signal = composeSignals(args.orchCtrl.signal, AbortSignal.timeout(decision.batchTimeoutMs))
    const startedAt = Date.now()
    const roleResults = await Promise.all(
      args.roles.map(async (role): Promise<CollectedVerdict> => {
        try {
          const verdict = await args.runRole({
            role,
            batchIdx,
            batchDiff,
            timeoutMs: decision.batchTimeoutMs,
            perfCtx: args.perfCtx,
            signal,
          })
          if (verdict === null) {
            return { role, verdict: null, elapsedMs: Date.now() - startedAt }
          }
          const withIds = namespaceBatchVerdict(role, batchIdx, verdict)
          currentUnionInputChars += JSON.stringify(withIds).length
          return { role, verdict: withIds, elapsedMs: Date.now() - startedAt }
        } catch (err) {
          return {
            role,
            verdict: null,
            elapsedMs: Date.now() - startedAt,
            failureReason: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    collected.push(...roleResults)
    launchedBatches.push(batch)
    cumulativeInputTokensEst += candidateBatchInputTokensEst
    nextBatchIndex = k + 1
  }

  const unlaunchedBatches = args.spilloverBatches.slice(nextBatchIndex).map((batch) => [...batch])
  return {
    collected,
    launchedBatches,
    unlaunchedBatches,
    batchesLaunched: launchedBatches.length,
    haltedEarly: haltReason !== null,
    haltReason,
  }
}

/** SIG-418 lever #3: emit `multibatch-enforce-summary` — observability for the
 *  ENFORCE path on real large PRs once flipped on. Companion to (NOT identical-unit
 *  with) the shadow `multibatch-summary`: fields are named for exactly what they
 *  count here — recovered coverage, recovered findings (the cost-justification
 *  signal), budget/halt state, per-role-verdict failures. Only fires when enforce ran. */
export function emitMultiBatchEnforceSummary(
  args: {
    owner: string
    repo: string
    prNumber: number
    headSha: string
    startMs: number
    spilloverBatches: readonly (readonly DiffFileBlock[])[]
  },
  result: MultiBatchEnforceResult,
): void {
  const spilloverFindingCount = result.collected.reduce((n, v) => n + (v.verdict?.findings.length ?? 0), 0)
  // Per ROLE-verdict failures (one collected entry per batch×role), NOT per-batch —
  // distinct unit from the shadow summary's `erroredBatches`, hence the distinct name.
  const erroredRoleVerdicts = result.collected.filter((v) => v.verdict === null).length
  console.log(
    JSON.stringify({
      event: "multibatch-enforce-summary",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      mode: "on",
      spilloverBatchesAvailable: args.spilloverBatches.length,
      batchesLaunched: result.batchesLaunched,
      unlaunchedBatches: result.unlaunchedBatches.length,
      haltedEarly: result.haltedEarly,
      haltReason: result.haltReason,
      // Spillover files actually reviewed beyond the posted batch[0] (disjoint from
      // batch[0] by construction; the seam pass re-reviews already-counted files, so
      // it is NOT added here). = the recovered-coverage signal.
      spilloverFilesReviewed: result.launchedBatches.reduce((n, b) => n + b.length, 0),
      // recovered findings (incl. the seam pass) + per-role-verdict failure count.
      spilloverFindingCount,
      erroredRoleVerdicts,
      elapsedMs: Date.now() - args.startMs,
    }),
  )
}

export async function runMultiBatchEnforceForSpecialists(args: {
  enabled: boolean
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  startMs: number
  spilloverBatches: readonly (readonly DiffFileBlock[])[]
  reviewedFiles: readonly DiffFileBlock[]
  graphBlastCallerPaths: readonly string[]
  graphBlastDependentPaths: readonly string[]
  roles: readonly SpecialistRole[]
  currentSourceJsonChars: number
  /** Giant-PR total-context ceiling (`SIGILIX_MAX_REVIEW_CONTEXT_TOKENS`). */
  maxReviewContextTokens: number
  sigilixConfig: SigilixConfig
  logicPromptBudgetMode: LogicPromptBudgetMode
  recallRoles: ReadonlySet<SpecialistRole>
  reasoningPromptRoles: ReadonlySet<SpecialistRole>
  reasoningByRole: ReadonlyMap<SpecialistRole, "high" | "medium" | "low">
  messageForBatchRole: (role: SpecialistRole, batchDiff: string, batchFactsBlock: string) => string
}): Promise<MultiBatchEnforceResult | null> {
  if (!args.enabled || args.spilloverBatches.length === 0) return null
  const runRole = async ({ role, batchDiff, signal }: MultiBatchRoleRunArgs): Promise<PrReviewVerdict | null> => {
    const batchFactsBlock = await buildBatchFactBlockForRole({ role, batchDiff, sigilixConfig: args.sigilixConfig })
    let initialMessage = appendRoleRule(
      args.messageForBatchRole(role, batchDiff, batchFactsBlock),
      role,
      args.sigilixConfig,
    )
    if (role === "logic") {
      initialMessage = applyLogicPromptBudget({
        mode: args.logicPromptBudgetMode,
        prompt: initialMessage,
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        headSha: args.headSha,
      })
    }
    const reasoningForRole = args.reasoningByRole.get(role)
    const result = await runSpecialist({
      role,
      apiKeys: modelApiKeys(args.env),
      systemPrompt: specialistSystemPrompt(role, args.recallRoles, args.reasoningPromptRoles),
      initialMessage,
      chatEnabled: args.env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      signal,
      perfCtx: args.perfCtx,
      ...(reasoningForRole !== undefined ? { reasoning: reasoningForRole } : {}),
      mcpTools: resolveSpecialistMcpTools(args.sigilixConfig, role),
    })
    return result.verdict
  }
  const result = await runMultiBatchEnforce({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha,
    perfCtx: args.perfCtx,
    orchCtrl: args.orchCtrl,
    startMs: args.startMs,
    spilloverBatches: args.spilloverBatches,
    roles: args.roles,
    currentSourceJsonChars: args.currentSourceJsonChars,
    maxSynthInputChars: MAX_MULTIBATCH_SYNTH_INPUT_CHARS,
    maxReviewContextTokens: args.maxReviewContextTokens,
    // Seed the total-context accumulator with batch[0]'s already-spent input (its diff
    // × roles) — a conservative floor; real per-review spend (retrieval/graph) is larger.
    priorInputTokensEst: estimateTokens(batchToDiff([...args.reviewedFiles])) * args.roles.length,
    runRole,
  })
  const seamBatch = selectCrossBatchSeamFiles({
    reviewedBatches: [args.reviewedFiles, ...result.launchedBatches],
    unlaunchedBatches: result.unlaunchedBatches,
    graphBlastCallerPaths: args.graphBlastCallerPaths,
    graphBlastDependentPaths: args.graphBlastDependentPaths,
  })
  let finalResult = result
  if (seamBatch.length > 0) {
    const seam = await runMultiBatchEnforce({
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha,
      perfCtx: args.perfCtx,
      orchCtrl: args.orchCtrl,
      startMs: args.startMs,
      spilloverBatches: [seamBatch],
      roles: args.roles,
      currentSourceJsonChars:
        args.currentSourceJsonChars +
        result.launchedBatches.reduce((sum, batch) => sum + batchToDiff(batch).length, 0) +
        JSON.stringify(result.collected.map((v) => v.verdict)).length,
      maxSynthInputChars: MAX_MULTIBATCH_SYNTH_INPUT_CHARS,
      maxReviewContextTokens: args.maxReviewContextTokens,
      // The seam pass runs AFTER the spillover batches, so its total-context accumulator
      // starts from batch[0]'s input PLUS every launched spillover batch's input.
      priorInputTokensEst:
        estimateTokens(batchToDiff([...args.reviewedFiles])) * args.roles.length +
        result.launchedBatches.reduce((sum, batch) => sum + estimateTokens(batchToDiff(batch)) * args.roles.length, 0),
      firstBatchIdx: args.spilloverBatches.length + 1,
      runRole,
    })
    finalResult = { ...result, collected: [...result.collected, ...seam.collected] }
  }
  emitMultiBatchEnforceSummary(args, finalResult)
  return finalResult
}
