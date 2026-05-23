// SIG-160 PR3 (Bug C): persist + consult withdrawn findings across review runs.
//
// When the github-mention handler decides to concede a human's pushback on
// an inline review finding ("you're right — this isn't a real concern,
// withdrawing"), we persist a WithdrawalRecord to KV. Subsequent
// `buildReviewSubmission` runs on the same PR drop any finding whose body
// matches a recorded withdrawal at the same `(path, line)` — preventing
// the bot from re-emitting a finding it already conceded.
//
// Key design (per Codex + DeepSeek 2026-05-22 dual review):
// - Key shape: `withdrawal:{owner}:{repo}:{prNumber}:{withdrawnByCommentId}`.
//   One record per concede action; unique by the reply comment ID. Lets us
//   list-by-prefix to load all of a PR's withdrawals in one KV scan.
// - Matching: Jaccard similarity (>= MATCH_THRESHOLD) on tokenized bodies,
//   scoped to the same path AND a small line tolerance. Per DeepSeek: a
//   pure title-hash key drifts within a week of LLM nondeterminism;
//   body-based similarity is the stable primitive.
// - Expiry: 30-day TTL (founder confirmed PR-lifetime; 30d is a safe upper
//   bound. Clean prefix-delete on `pull_request.closed` is a follow-up).

import type { Env } from "../index"

const MATCH_THRESHOLD = 0.75
const LINE_TOLERANCE = 5
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

export interface WithdrawalRecord {
  /** File path of the conceded finding. */
  path: string
  /** Line number of the conceded finding (model-emitted, may differ slightly across runs). */
  line: number
  /**
   * Snapshot of the original finding's body text (trimmed to first 800
   * chars after stripping markers). Used for Jaccard similarity at
   * filter time. Pure storage — the renderer never re-displays this.
   */
  bodySnapshot: string
  /** Unix epoch ms when the withdrawal was recorded. */
  withdrawnAt: number
  /** GitHub comment ID of the bot's concede reply that triggered persistence. */
  withdrawnByCommentId: number
  /** PR HEAD SHA when the withdrawal happened (audit trail). */
  prHeadSha: string
  /** What signal triggered the write. Today only mention-reply-accepted. */
  reason: "mention-reply-accepted"
}

function withdrawalPrefix(owner: string, repo: string, prNumber: number): string {
  return `withdrawal:${owner}:${repo}:${prNumber}:`
}

function withdrawalKey(owner: string, repo: string, prNumber: number, commentId: number): string {
  return `${withdrawalPrefix(owner, repo, prNumber)}${commentId}`
}

/**
 * Tokenize for Jaccard: lowercase, split on non-word chars, drop short
 * tokens (<=2 chars) and pure-number tokens that drift between runs
 * (line numbers, byte counts, etc). Returns the unique token set.
 *
 * Pure — exported for tests.
 */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2 && !/^\d+$/.test(t))
  return new Set(tokens)
}

/**
 * Standard Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 0 when both
 * inputs tokenize to the empty set (avoids 0/0 = NaN at the boundary).
 *
 * Pure — exported for tests.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 && setB.size === 0) return 0
  let intersection = 0
  for (const t of setA) {
    if (setB.has(t)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  if (union === 0) return 0
  return intersection / union
}

/**
 * Strip GitHub markdown noise that drifts between runs but isn't
 * semantically meaningful for similarity matching: HTML comment
 * markers, suggestion blocks, fenced code blocks, link URLs.
 *
 * Pure — exported for tests.
 */
export function stripBodyForMatching(body: string): string {
  return body
    // HTML comment markers (sigilix:*, coderabbit:*, etc.)
    .replace(/<!--[\s\S]*?-->/g, "")
    // Fenced suggestion blocks
    .replace(/```suggestion[\s\S]*?```/g, "")
    // Other fenced code blocks
    .replace(/```[\s\S]*?```/g, "")
    // Link URLs — keep the link text, drop the URL
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800)
}

/**
 * Determine whether a candidate finding (path + line + body) matches an
 * existing withdrawal. Match requires:
 *   - Same path.
 *   - Anchor line within LINE_TOLERANCE (walk-forward may have re-anchored
 *     a few lines off the original).
 *   - Jaccard similarity on stripped bodies >= MATCH_THRESHOLD.
 *
 * Pure — exported for tests.
 */
export function findingMatchesWithdrawal(
  finding: { path: string; line: number; body: string },
  withdrawal: WithdrawalRecord,
): boolean {
  if (finding.path !== withdrawal.path) return false
  if (Math.abs(finding.line - withdrawal.line) > LINE_TOLERANCE) return false
  const sim = jaccardSimilarity(
    stripBodyForMatching(finding.body),
    stripBodyForMatching(withdrawal.bodySnapshot),
  )
  return sim >= MATCH_THRESHOLD
}

/**
 * Filter findings against a set of active withdrawals for the same PR.
 * Returns the kept findings + the list of suppressed ones (for telemetry).
 *
 * Pure — exported for tests.
 */
export function filterWithdrawnFindings<F extends { path: string; line: number; body: string }>(
  findings: ReadonlyArray<F>,
  withdrawals: ReadonlyArray<WithdrawalRecord>,
): { kept: F[]; suppressed: F[] } {
  if (withdrawals.length === 0) return { kept: [...findings], suppressed: [] }
  const kept: F[] = []
  const suppressed: F[] = []
  for (const f of findings) {
    const hit = withdrawals.some((w) => findingMatchesWithdrawal(f, w))
    if (hit) suppressed.push(f)
    else kept.push(f)
  }
  return { kept, suppressed }
}

interface WriteArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  path: string
  line: number
  bodySnapshot: string
  withdrawnByCommentId: number
  prHeadSha: string
}

/**
 * Persist a withdrawal record. KV write is best-effort: failure logs +
 * returns false but never throws — the caller (mention-reply handler)
 * already posted the reply, and a failed withdrawal write is a missed
 * suppression, not a correctness break.
 */
export async function writeWithdrawal(args: WriteArgs): Promise<boolean> {
  const record: WithdrawalRecord = {
    path: args.path,
    line: args.line,
    bodySnapshot: stripBodyForMatching(args.bodySnapshot),
    withdrawnAt: Date.now(),
    withdrawnByCommentId: args.withdrawnByCommentId,
    prHeadSha: args.prHeadSha,
    reason: "mention-reply-accepted",
  }
  const key = withdrawalKey(args.owner, args.repo, args.prNumber, args.withdrawnByCommentId)
  try {
    await args.env.OPENCLAW_STATE.put(key, JSON.stringify(record), {
      expirationTtl: TTL_SECONDS,
    })
    console.log(JSON.stringify({
      event: "review-withdrawal-recorded",
      owner: args.owner, repo: args.repo, pr_number: args.prNumber,
      path: args.path, line: args.line,
      comment_id: args.withdrawnByCommentId,
      head_sha: args.prHeadSha,
    }))
    return true
  } catch (err) {
    console.error(JSON.stringify({
      event: "review-withdrawal-write-failed",
      owner: args.owner, repo: args.repo, pr_number: args.prNumber,
      comment_id: args.withdrawnByCommentId,
      error: err instanceof Error ? err.message : String(err),
    }))
    return false
  }
}

/**
 * Load all active withdrawals for a PR. Wraps `OPENCLAW_STATE.list` +
 * per-key fetch. Best-effort: failure logs + returns []. Empty array
 * means "no withdrawals to consult," which is the safe default — the
 * renderer emits findings exactly as before when this is empty.
 */
export async function loadWithdrawals(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<WithdrawalRecord[]> {
  try {
    // Note: KV `list` returns at most 1000 keys per call (Cloudflare
    // hard limit). A PR with 1000+ separate concede actions is
    // pathological — we accept the truncation rather than paginate.
    // If we ever observe a PR pushing past ~100 withdrawals, revisit
    // and add cursor pagination.
    const list = await env.OPENCLAW_STATE.list({
      prefix: withdrawalPrefix(owner, repo, prNumber),
    })
    const records: WithdrawalRecord[] = []
    for (const key of list.keys) {
      const raw = await env.OPENCLAW_STATE.get(key.name)
      if (raw === null) continue
      try {
        const parsed = JSON.parse(raw) as Partial<WithdrawalRecord>
        if (
          typeof parsed.path === "string" &&
          typeof parsed.line === "number" &&
          typeof parsed.bodySnapshot === "string" &&
          typeof parsed.withdrawnAt === "number" &&
          typeof parsed.withdrawnByCommentId === "number" &&
          typeof parsed.prHeadSha === "string"
        ) {
          records.push(parsed as WithdrawalRecord)
        }
      } catch {
        // Skip malformed records; they auto-expire via TTL.
      }
    }
    return records
  } catch (err) {
    console.error(JSON.stringify({
      event: "review-withdrawal-load-failed",
      owner, repo, pr_number: prNumber,
      error: err instanceof Error ? err.message : String(err),
    }))
    return []
  }
}
