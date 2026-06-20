// SIG-471 (quiet-VERIFIED) — the `overview-proof-update` job handler.
//
// When the forge-proof runner receipt for a PR head lands (ingest accepts it),
// this job re-runs ONLY the receipt-join over the PRIOR review's manifest
// findings and patches the Proof line on the editable overview comment in place.
// It is the QUIET replacement for the old noisy "full re-review on receipt
// ingest": NO specialist run, NO second posted review, NO ensemble budget — just
// a deterministic join (the same trust boundary `verifyFindingAgainstReceipt`
// uses in the live review) + a single targeted comment PATCH.
//
// THE RACE (load-bearing): the runner can post its receipt BEFORE the first
// review has written the review manifest / overview status block (CI is fast,
// the review is slow). When the manifest is missing/incomplete OR the overview's
// terminal status block isn't present yet, the handler RE-ENQUEUES the same job
// with a bounded attempt counter (capped, with the queue's own backoff) rather
// than dropping the upgrade. Never infinite-loops; never throws out of the
// consumer (best-effort, like the other quiet jobs).

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { parseSarif, normalizeSarifPath } from "@/src/features/sarif-evidence"
import { runAstRules } from "@/src/features/ast-rules"
import { resolveAstRulesConfig } from "@/src/lib/sigilix-config"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import { lookupRunnerEvidence } from "@/src/lib/runner-evidence/lookup"
import { readReviewManifest, type ReviewManifestFinding } from "@/src/lib/review-manifest"
import {
  buildReceiptIndex,
  extractReceiptScanResults,
  verifyFindingAgainstReceipt,
  coLocatedAstFactIds,
  type ReceiptScanResult,
} from "@/src/lib/verification/verify-finding-receipt"
import { findExistingOverviewComment } from "@/src/lib/triage-pr-overview-scan"
import { parseFindingFingerprint, FINDING_BLOCK_MARKER } from "@/src/lib/pr-finding-markers"
import { renderTrustPill } from "@/src/lib/trust-ledger-render"
import type { FindingTrust } from "@/src/shared/domain/pr-review-finding"
import {
  computeProofCounts,
  patchProofLineInStatusBlock,
  REVIEW_STATUS_BLOCK_START,
  type ReviewStatusProof,
} from "@/src/lib/pr-review-status-render"

/** RACE cap: re-enqueues before the handler gives up (the manifest / overview
 *  may still be in flight from the slow review). Bounded so a permanently-absent
 *  manifest can never loop forever. */
export const MAX_PROOF_UPDATE_ATTEMPTS = 5

/** The security-roled AST facts the receipt-join uses for co-located class
 *  derivation (mirror of `securityAstFactsForReceiptJoin` in verify-and-build;
 *  duplicated here to avoid an `app/ensemble` import edge from this leaf). */
type AstSecurityFact = { path: string; line: number; astFindingId: string }

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

/**
 * Re-enqueue the SAME job with `attempt + 1` while under the cap. Logs the
 * outcome either way. Best-effort: a queue-send failure is swallowed (a
 * subsequent receipt resubmission / the next webhook review can still upgrade
 * the proof). Returns nothing — the caller has already decided to retry.
 */
async function reenqueue(message: Extract<JobMessage, { type: "overview-proof-update" }>, env: Env): Promise<void> {
  const attempt = message.attempt ?? 0
  if (attempt + 1 >= MAX_PROOF_UPDATE_ATTEMPTS) {
    emit("overview-proof-update-retry-exhausted", {
      owner: message.owner,
      repo: message.repo,
      prNumber: message.prNumber,
      attempt,
    })
    return
  }
  try {
    // Codex P2: delay the retry so a fast runner receipt doesn't burn all attempts
    // before the slower review writes the manifest/overview. Linear backoff
    // (60/120/180/240s) spreads the 4 retries over ~10 min — comfortably past the
    // typical review-finish window. CF Queues honor `delaySeconds`.
    const delaySeconds = (attempt + 1) * 60
    await env.OPENCLAW_JOBS.send({ ...message, attempt: attempt + 1 }, { delaySeconds })
    emit("overview-proof-update-retry-enqueued", {
      owner: message.owner,
      repo: message.repo,
      prNumber: message.prNumber,
      attempt: attempt + 1,
      delaySeconds,
    })
  } catch (err) {
    emit("overview-proof-update-retry-send-failed", {
      owner: message.owner,
      repo: message.repo,
      prNumber: message.prNumber,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Re-run the deterministic AST scan over the PR's changed JS/TS HEAD files so the
 * receipt-join can resolve co-located AST facts (the path-(b) class source in
 * `canonicalClassForFinding`). NO LLM. Returns the security-roled facts; any
 * fetch/parse failure degrades to [] (the join still runs on the finding's own
 * AST/CWE class). Bounded: only changed JS/TS files are fetched.
 */
async function scanSecurityAstFacts(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<AstSecurityFact[]> {
  let diff: string
  try {
    diff = await client.getPullRequestDiff(owner, repo, prNumber)
  } catch {
    return []
  }
  const reviewable = parseDiffToReviewablePositions(diff)
  const jsTsPaths = [...reviewable.keys()].filter((p) => /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(p))
  const filesByPath = new Map<string, string>()
  for (const p of jsTsPaths) {
    try {
      const src = await client.getFileContent(owner, repo, p, headSha)
      if (typeof src === "string") filesByPath.set(p, src)
    } catch {
      // A single unreadable file degrades that file only.
    }
  }
  if (filesByPath.size === 0) return []
  try {
    const astResult = await runAstRules({
      diff,
      filesByPath,
      reviewable,
      config: resolveAstRulesConfig(null),
      ctx: { owner, repo, prNumber },
    })
    return astResult.findings
      .filter((f) => f.roleHint === "security")
      .map((f) => ({ path: f.path, line: f.line, astFindingId: f.astFindingId }))
  } catch {
    return []
  }
}

/**
 * Build the verified receipt's HEAD-scan index for this PR head. Returns null
 * (→ caller retries) when no ACCEPTED receipt is renderable-as-verified yet, and
 * an empty index when the receipt is verified but parses to nothing. Reuses the
 * SAME `lookupRunnerEvidence` trust boundary the live review uses (signed-merge
 * bind, integrity hash, SARIF consistency), then the SAME pure extraction
 * (`extractReceiptScanResults` + `buildReceiptIndex`).
 */
async function buildReceiptIndexForHead(
  env: Env,
  client: GitHubClient,
  args: { owner: string; repo: string; prNumber: number; headSha: string; repositoryId: string },
): Promise<Map<string, ReceiptScanResult[]> | null> {
  const meta = await client.getPullRequest(args.owner, args.repo, args.prNumber)
  const mergeSha = meta.merge_commit_sha
  if (!mergeSha) return null
  const evidence = await lookupRunnerEvidence(env, args.repositoryId, args.prNumber, mergeSha, {
    headSha: args.headSha,
    // Forge-proof head bind: parents[1] of the receipt's SIGNED 2-parent merge
    // commit = the PR head it was scanned against. Anchored on the signed sha.
    resolveMergeHead: async (receiptMergeSha) => {
      const commit = await client.getCommit(args.owner, args.repo, receiptMergeSha)
      if (!commit || commit.parents.length !== 2) return null
      return commit.parents[1] ?? null
    },
  })
  if (evidence.state !== "verified") {
    emit("overview-proof-update-evidence-pending", {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      state: evidence.state,
      ...(evidence.state === "evidence-pending" ? { reason: evidence.reason } : {}),
    })
    return null
  }
  const parsed = parseSarif(evidence.sarif)
  if (!parsed.ok) {
    emit("overview-proof-update-sarif-parse-skipped", {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      reason: parsed.reason,
    })
    return new Map()
  }
  return buildReceiptIndex(extractReceiptScanResults(parsed.report.runs, normalizeSarifPath))
}

/**
 * Are the manifest findings carrying the SIG-471 enriched fields the receipt-join
 * needs? A pre-SIG-471 manifest omits `line`/`category`; re-verifying it would
 * systematically under-count VERIFIED. So we treat "no finding carries `line` or
 * `category`" as incomplete and retry (the next webhook review re-writes the
 * manifest with the enriched fields).
 */
function manifestHasEnrichedFields(findings: ReadonlyArray<ReviewManifestFinding>): boolean {
  return findings.some((f) => typeof f.line === "number" || typeof f.category === "string")
}

/**
 * SIG-471: patch ONLY the overview comment's Proof line in place. Locates the
 * overview issue-comment by its marker and replaces the Proof line inside its
 * existing terminal status block (`patchProofLineInStatusBlock` — NOT
 * `upsertReviewStatusBlock`, which rebuilds the whole block and drops the status
 * details). Returns "patched" | "no-overview" | "no-status-block" | "no-op" so
 * the caller can decide whether to retry (the block may still be in flight).
 */
async function patchOverviewProof(
  client: GitHubClient,
  args: { owner: string; repo: string; prNumber: number },
  proof: ReviewStatusProof,
): Promise<"patched" | "no-overview" | "no-status-block" | "no-op"> {
  const existing = await findExistingOverviewComment(client, args.owner, args.repo, args.prNumber)
  if (existing === null) return "no-overview"
  if (!existing.body.includes(REVIEW_STATUS_BLOCK_START)) return "no-status-block"
  const next = patchProofLineInStatusBlock(existing.body, proof)
  if (next === existing.body) return "no-op"
  await client.updateIssueComment(args.owner, args.repo, existing.id, next)
  return "patched"
}

/**
 * SIG-473: flip the inline review-comment trust pill GROUNDED→VERIFIED in place
 * for each confirmed finding that carries a stored `inlineCommentId`. Runs AFTER
 * (and never blocks) the primary overview proof-line patch. Per-finding
 * best-effort: fetch the comment, REVALIDATE it's still our finding comment with
 * the SAME fingerprint (skip on edited/deleted/mismatch), then PATCH the body
 * with the grounded pill replaced by the runner-verified pill. Idempotent: if the
 * grounded pill isn't present (already upgraded / drift) we skip. Bounded — only
 * the confirmed (`verifiedKeys`) findings that have an id.
 */
async function patchInlinePills(
  client: GitHubClient,
  args: { owner: string; repo: string; prNumber: number },
  findings: ReadonlyArray<ReviewManifestFinding>,
  verifiedKeys: ReadonlySet<string>,
): Promise<void> {
  const newPill = renderTrustPill("runner-confirmed")
  for (const f of findings) {
    if (!verifiedKeys.has(f.key)) continue
    if (typeof f.inlineCommentId !== "number" || typeof f.contentFingerprint !== "string") continue
    try {
      const comment = await client.getPullRequestReviewComment(args.owner, args.repo, f.inlineCommentId)
      if (comment === null) continue // deleted
      // REVALIDATE: still our finding comment, same fingerprint (not edited/recycled).
      if (!comment.body.includes(FINDING_BLOCK_MARKER)) continue
      if (parseFindingFingerprint(comment.body) !== f.contentFingerprint) continue
      // The pre-receipt pill rendered from the finding's post-time trust tier.
      const oldPill = renderTrustPill(f.trustTier as FindingTrust["tier"])
      if (oldPill === newPill) continue // already runner-confirmed at post time
      if (!comment.body.includes(oldPill)) continue // already upgraded / drift → idempotent skip
      const next = comment.body.replace(oldPill, newPill) // single replace
      await client.updatePullRequestReviewComment(args.owner, args.repo, f.inlineCommentId, next)
      emit("overview-proof-update-inline-pill-patched", {
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        commentId: f.inlineCommentId,
      })
    } catch (err) {
      emit("overview-proof-update-inline-pill-failed", {
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        commentId: f.inlineCommentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Resolve the immutable repository id for the receipt join key, preferring the
 * message-carried `repoId` and falling back to a `getRepository` lookup (legacy
 * ingest paths omit it). Returns null when neither resolves (→ caller skips, not
 * retries — a missing repo id is not a race).
 */
async function resolveRepositoryId(
  client: GitHubClient,
  message: Extract<JobMessage, { type: "overview-proof-update" }>,
): Promise<string | null> {
  if (typeof message.repoId === "number" && message.repoId > 0) return String(message.repoId)
  try {
    const repository = await client.getRepository(message.owner, message.repo)
    return typeof repository?.id === "number" && repository.id > 0 ? String(repository.id) : null
  } catch {
    return null
  }
}

/**
 * The `overview-proof-update` job handler. Best-effort: every branch either
 * returns or re-enqueues; nothing throws out of the consumer. NEVER calls a
 * specialist or posts a review.
 */
export async function handleOverviewProofUpdate(
  message: Extract<JobMessage, { type: "overview-proof-update" }>,
  env: Env,
): Promise<void> {
  const { owner, repo, prNumber, headSha } = message
  try {
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
      emit("overview-proof-update-no-app-config", { owner, repo, prNumber })
      return
    }
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId: message.installationId,
    })
    const client = new GitHubClient({ token })

    // 1) The prior review's manifest. Missing/invalid OR not yet enriched → RETRY
    //    (the slow review may still be writing it; the receipt raced ahead).
    const manifest = await readReviewManifest(env, owner, repo, prNumber)
    if (manifest.kind !== "ok" || !manifest.manifest.findings || manifest.manifest.findings.length === 0) {
      emit("overview-proof-update-incomplete", {
        owner,
        repo,
        prNumber,
        reason: manifest.kind !== "ok" ? `manifest-${manifest.kind}` : "no-findings",
      })
      await reenqueue(message, env)
      return
    }
    const findings = manifest.manifest.findings
    if (!manifestHasEnrichedFields(findings)) {
      emit("overview-proof-update-incomplete", { owner, repo, prNumber, reason: "fields-not-enriched" })
      await reenqueue(message, env)
      return
    }
    // Codex P1 — HEAD-BIND. The receipt is verified for THIS job's `headSha`, but the
    // manifest + overview are read by PR number and reflect the LATEST review. If the PR
    // advanced past the receipt's head, this (now-stale) receipt must NOT inflate the
    // newer review's Proof line. SKIP — do not retry (a fresh receipt for the new head
    // arrives via its own runner run; retrying here would never match).
    if (manifest.manifest.headSha !== headSha) {
      emit("overview-proof-update-stale-head", {
        owner,
        repo,
        prNumber,
        receiptHead: headSha.slice(0, 7),
        manifestHead: manifest.manifest.headSha.slice(0, 7),
      })
      return
    }

    // 2) The receipt index for this head. Null = no verified receipt yet → RETRY.
    const repositoryId = await resolveRepositoryId(client, message)
    if (repositoryId === null) {
      emit("overview-proof-update-no-repo-id", { owner, repo, prNumber })
      return
    }
    const receiptIndex = await buildReceiptIndexForHead(env, client, { owner, repo, prNumber, headSha, repositoryId })
    if (receiptIndex === null) {
      await reenqueue(message, env)
      return
    }

    // 3) Re-run the deterministic AST scan (NO LLM) for co-located facts.
    const astSecurityFacts = await scanSecurityAstFacts(client, owner, repo, prNumber, headSha)

    // 4) Receipt-join each eligible (score>=4 && security) finding.
    const verifiedKeys = new Set<string>()
    for (const f of findings) {
      if (f.score < 4 || f.category !== "security") continue
      // Codex/code-reviewer P2 — line-less (file/PR-scope) findings are NOT
      // receipt-join eligible. The live review always joins on a REAL line; a
      // manifest finding without a `line` (omitted for file/PR scope) has no anchor,
      // and a synthetic `line: 0` would wrongly window-confirm against any receipt
      // hit in lines 1–10 of the same file. Skip them — they fall to grounded/model
      // in `computeProofCounts`, exactly matching what the live review would render.
      if (typeof f.line !== "number" || f.line <= 0) continue
      // The receipt-join reads only (path, line, category, evidenceId, cweId) + the
      // supplied fact-ids. `category` is gated to "security" above, so the literal is sound.
      const finding: Parameters<typeof verifyFindingAgainstReceipt>[0] = {
        path: f.path,
        line: f.line,
        headline: f.headline,
        score: f.score,
        category: "security",
        ...(typeof f.evidenceId === "string" ? { evidenceId: f.evidenceId } : {}),
        ...(typeof f.cweId === "string" ? { cweId: f.cweId } : {}),
      }
      // Feed the manifest's stored AST fact-ids + the freshly co-located AST facts
      // through `extraFactIds` (the join folds them into the SAME candidate set as
      // `evidence.deterministicFactIds`), so we needn't reconstruct a full
      // EvidenceRecord just to carry the fact-ids.
      const extraFactIds = [
        ...(f.deterministicFactIds ?? []),
        ...coLocatedAstFactIds({ path: f.path, line: f.line }, astSecurityFacts),
      ]
      const result = verifyFindingAgainstReceipt(finding, receiptIndex, extraFactIds)
      if (result.verdict === "confirmed") verifiedKeys.add(f.key)
    }

    // 5) Compute the proof counts + patch the overview's Proof line in place.
    const proof = computeProofCounts(findings, verifiedKeys)
    const outcome = await patchOverviewProof(client, { owner, repo, prNumber }, proof)
    if (outcome === "no-overview" || outcome === "no-status-block") {
      // The overview / its terminal block isn't present yet → the review is
      // still in flight; RETRY rather than lose the upgrade.
      emit("overview-proof-update-overview-pending", { owner, repo, prNumber, outcome, ...proof })
      await reenqueue(message, env)
      return
    }
    emit("overview-proof-update-applied", { owner, repo, prNumber, outcome, ...proof })
    // SIG-473: AFTER the (primary, unconditional) overview proof-line patch, flip the
    // inline review-comment pills GROUNDED→VERIFIED for the confirmed findings. Wholly
    // best-effort + bounded — failures here never block or delay the overview patch above.
    await patchInlinePills(client, { owner, repo, prNumber }, findings, verifiedKeys)
  } catch (err) {
    // Best-effort: never throw out of the consumer.
    emit("overview-proof-update-error", {
      owner,
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
