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

import type { Env } from "@/src/shared/types/env"
import { type DismissReason, isDismissReason } from "./dismiss-reasons"

const MATCH_THRESHOLD = 0.75
const LINE_TOLERANCE = 5
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
// SIG-217 Part B: a dismissal only SUPPRESSES re-fires for this long. The KV
// record still lives the full TTL above, but once a match is older than the
// decay window we let the finding through (and emit `dismiss-decay-window-
// expired`) so a stale concession can't mute a genuinely re-surfaced issue
// forever. MUST stay < TTL — past the TTL the record is gone and there is
// nothing left to decay.
const DISMISS_DECAY_WINDOW_DAYS = 14
const DISMISS_DECAY_WINDOW_MS = DISMISS_DECAY_WINDOW_DAYS * 24 * 60 * 60 * 1000

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
  /**
   * SIG-173: optional canonical reason label parsed off `@sigilix dismiss
   * <reason>` when the writer has one. Absent on records produced by the
   * model-side concede path (no reviewer label). Forward-compatible —
   * older records loaded from KV simply lack the field.
   */
  dismissReason?: DismissReason
  /**
   * SIG-217: deterministic content fingerprint —
   * `sha256(category + "\0" + path + "\0" + bodySnippet(0,80))`. Stable across
   * pushes even when the model-emitted finding ID changes with each blob hash,
   * so a content-equivalent finding is recognized as already-dismissed even if
   * its body wording drifts below the Jaccard threshold. Optional: legacy
   * records written before SIG-217 lack it and fall back to Jaccard matching.
   */
  contentFingerprint?: string
  /**
   * SIG-217: severity score (1–5) of the finding at the moment it was
   * dismissed. Lets a later content-equivalent re-fire at a HIGHER score be
   * recognized as a severity-escalation attempt (still suppressed, but
   * telemetered separately). Optional for back-compat.
   */
  dismissedScore?: number
}

/**
 * SIG-217: the content-fingerprint primitive. `sha256` per the spec, over the
 * normalized triple (category, path, first 80 body chars after markdown
 * stripping). Async because Workers only expose Web Crypto's async digest.
 *
 * Pure (no I/O beyond the platform hash) — exported for tests + the write path.
 */
export async function computeContentFingerprint(
  category: string,
  path: string,
  body: string,
): Promise<string> {
  const snippet = stripBodyForMatching(body).slice(0, 80)
  const input = `${category}\0${path}\0${snippet}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
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
  finding: { path: string; line: number; body: string; contentFingerprint?: string },
  withdrawal: WithdrawalRecord,
): boolean {
  // SIG-217: deterministic content-fingerprint match takes precedence. It is
  // independent of line drift AND body-Jaccard, so a content-equivalent
  // re-fire is recognized even when (a) the model-emitted finding ID changed
  // with the push's blob hash, or (b) the body wording drifted below the 0.75
  // Jaccard threshold. Both fingerprints must be present (legacy records and
  // un-annotated findings fall through to the Jaccard path below).
  if (
    finding.contentFingerprint &&
    withdrawal.contentFingerprint &&
    finding.contentFingerprint === withdrawal.contentFingerprint
  ) {
    return true
  }
  if (finding.path !== withdrawal.path) return false
  if (Math.abs(finding.line - withdrawal.line) > LINE_TOLERANCE) return false
  const sim = jaccardSimilarity(
    stripBodyForMatching(finding.body),
    stripBodyForMatching(withdrawal.bodySnapshot),
  )
  return sim >= MATCH_THRESHOLD
}

/** A finding shape that can be matched against withdrawals. */
export type MatchableFinding = {
  path: string
  line: number
  body: string
  /** SIG-217: precomputed via `computeContentFingerprint`. */
  contentFingerprint?: string
  /** SIG-217: current severity score (1–5), for escalation detection. */
  score?: number
}

/** SIG-217: one suppressed finding plus why it was suppressed (for telemetry). */
export interface WithdrawnSuppression<F> {
  finding: F
  withdrawal: WithdrawalRecord
  /** Matched via deterministic content fingerprint (vs. Jaccard body similarity). */
  viaFingerprint: boolean
  /** Fingerprint-matched AND re-fired at a higher score than when dismissed. */
  severityEscalated: boolean
}

/**
 * Filter findings against a set of active withdrawals for the same PR.
 * Returns the kept findings + the list of suppressed ones (for telemetry).
 *
 * Pure — exported for tests. Thin wrapper over `filterWithdrawnFindingsDetailed`
 * for the legacy callers that only need the kept/suppressed split.
 */
export function filterWithdrawnFindings<F extends MatchableFinding>(
  findings: ReadonlyArray<F>,
  withdrawals: ReadonlyArray<WithdrawalRecord>,
): { kept: F[]; suppressed: F[] } {
  const { kept, suppressed } = filterWithdrawnFindingsDetailed(findings, withdrawals)
  return { kept, suppressed: suppressed.map((s) => s.finding) }
}

/**
 * SIG-217: like `filterWithdrawnFindings` but reports, per suppression, whether
 * it matched via content fingerprint and whether the re-fire was a severity
 * escalation. The ensemble uses this to emit `repeat-fp-detected` /
 * `severity-escalation-attempt` telemetry while still suppressing the finding.
 *
 * Pure — exported for tests.
 */
export function filterWithdrawnFindingsDetailed<F extends MatchableFinding>(
  findings: ReadonlyArray<F>,
  withdrawals: ReadonlyArray<WithdrawalRecord>,
  now: number = Date.now(),
): { kept: F[]; suppressed: WithdrawnSuppression<F>[]; decayExpired: WithdrawnSuppression<F>[] } {
  if (withdrawals.length === 0) return { kept: [...findings], suppressed: [], decayExpired: [] }
  const kept: F[] = []
  const suppressed: WithdrawnSuppression<F>[] = []
  // SIG-217 Part B: matched a withdrawal but the decay window has lapsed — the
  // finding is KEPT (let through), and the lapse is recorded so the ensemble
  // can emit `dismiss-decay-window-expired`.
  const decayExpired: WithdrawnSuppression<F>[] = []
  for (const f of findings) {
    const w = withdrawals.find((w) => findingMatchesWithdrawal(f, w))
    if (!w) {
      kept.push(f)
      continue
    }
    const viaFingerprint = Boolean(
      f.contentFingerprint &&
        w.contentFingerprint &&
        f.contentFingerprint === w.contentFingerprint,
    )
    const severityEscalated =
      viaFingerprint &&
      typeof f.score === "number" &&
      typeof w.dismissedScore === "number" &&
      f.score > w.dismissedScore
    const entry: WithdrawnSuppression<F> = { finding: f, withdrawal: w, viaFingerprint, severityEscalated }
    // Past the decay window → stop suppressing. Keep the finding and record the
    // lapse instead of muting a concession that may now be stale.
    if (now - w.withdrawnAt > DISMISS_DECAY_WINDOW_MS) {
      kept.push(f)
      decayExpired.push(entry)
      continue
    }
    suppressed.push(entry)
  }
  return { kept, suppressed, decayExpired }
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
  /**
   * SIG-173: optional canonical reason label, threaded through from the
   * `@sigilix dismiss <reason>` flow. The model-side concede caller leaves
   * this unset; the record then omits the field on the wire.
   */
  dismissReason?: DismissReason
  /**
   * SIG-217: the dismissed finding's content fingerprint + score. The
   * fingerprint is computed ONCE from the raw finding at render time (embedded
   * as a `sigilix:fingerprint:` marker) and parsed back here, so it derives
   * from the identical source text the re-fire filter side hashes — recomputing
   * from the rendered comment body would yield a different (non-matching) hash.
   * Both optional: when absent the record falls back to Jaccard matching.
   */
  contentFingerprint?: string
  score?: number
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
    ...(args.dismissReason ? { dismissReason: args.dismissReason } : {}),
    // SIG-217: store the render-time fingerprint as-is (do NOT recompute).
    ...(args.contentFingerprint ? { contentFingerprint: args.contentFingerprint } : {}),
    ...(typeof args.score === "number" ? { dismissedScore: args.score } : {}),
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
    // CodeRabbit T1 (review on PR #142): parallelize KV gets in bounded
    // batches so a PR with 30+ withdrawals doesn't serialize N round-trips.
    // Bounded at 10 to stay well clear of any CF KV concurrency hints
    // without exploding subrequest fan-out.
    const BATCH = 10
    const rawEntries: (string | null)[] = []
    for (let i = 0; i < list.keys.length; i += BATCH) {
      const slice = list.keys.slice(i, i + BATCH)
      const batchResults = await Promise.all(
        slice.map((key) => env.OPENCLAW_STATE.get(key.name)),
      )
      rawEntries.push(...batchResults)
    }
    const records: WithdrawalRecord[] = []
    for (const raw of rawEntries) {
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
          // SIG-173: drop unknown values defensively. The field is optional
          // — pre-SIG-173 records simply lack it, and an out-of-band value
          // (manual KV poke, future-version downgrade) shouldn't poison the
          // softening weight calculation.
          const dismissReason = isDismissReason(parsed.dismissReason)
            ? parsed.dismissReason
            : undefined
          // SIG-217: forward the optional fingerprint/score when well-typed.
          const contentFingerprint =
            typeof parsed.contentFingerprint === "string" ? parsed.contentFingerprint : undefined
          const dismissedScore =
            typeof parsed.dismissedScore === "number" ? parsed.dismissedScore : undefined
          records.push({
            path: parsed.path,
            line: parsed.line,
            bodySnapshot: parsed.bodySnapshot,
            withdrawnAt: parsed.withdrawnAt,
            withdrawnByCommentId: parsed.withdrawnByCommentId,
            prHeadSha: parsed.prHeadSha,
            reason: "mention-reply-accepted",
            ...(dismissReason ? { dismissReason } : {}),
            ...(contentFingerprint ? { contentFingerprint } : {}),
            ...(dismissedScore !== undefined ? { dismissedScore } : {}),
          })
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
