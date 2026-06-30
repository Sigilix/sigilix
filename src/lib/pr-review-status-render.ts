import { OVERVIEW_MARKER } from "./triage-pr-overview-scan"
import { ALL_DISMISS_REASONS } from "./dismiss-reasons"

export const REVIEW_STATUS_BLOCK_START = "<!-- sigilix:review-run-status:start -->"
export const REVIEW_STATUS_BLOCK_END = "<!-- sigilix:review-run-status:end -->"
const OVERVIEW_HEADING = "## Sigilix Overview"

export type ReviewStatusPhase =
  | "queued"
  | "retrieval"
  | "specialists"
  | "synth"
  | "posted"
  | "degraded"
  | "skipped"
  | "failed"

export interface ReviewStatusSpecialists {
  total?: number
  completed?: number
  dispatched?: readonly string[]
  succeeded?: readonly string[]
  failed?: readonly string[]
  missing?: readonly string[]
  notNeeded?: readonly string[]
}

export interface ReviewStatusGraphCoverage {
  mode?: string
  filesWithContext?: number
  totalFiles?: number
  nodes?: number
}

export interface ReviewStatusFinal {
  status: "posted" | "skipped" | "failed"
  findingsCount?: number
  surface?: "review" | "comment" | "skip-notice"
  reviewUrl?: string
}

/**
 * SIG-471: per-review proof-tier counts, rendered as the overview "Proof" line.
 * The runner-receipt proof-update job (the quiet GROUNDED→VERIFIED upgrade) patches
 * this in place once the forge-proof receipt lands — no second review. Absent →
 * no Proof line (pre-receipt overviews and reviews with no eligible findings).
 */
export interface ReviewStatusProof {
  verified: number
  reproduced: number
  grounded: number
  model: number
}

export interface ReviewStatusSnapshot {
  phase: ReviewStatusPhase
  headSha: string
  sequence: number
  specialists?: ReviewStatusSpecialists
  droppedFiles?: readonly string[]
  graphCoverage?: ReviewStatusGraphCoverage
  final?: ReviewStatusFinal
  proof?: ReviewStatusProof
  /**
   * SIG-471 PR-3: the editable-overview "Manage" footer. The Greptile-style
   * minimal review BODY no longer carries the Dismiss/Re-run/Review#/SHA footer
   * (the inline comments speak for themselves); it moves here, into the overview
   * status block, rendered as the LAST line of the block (after Proof). Built by
   * `formatManageLine` at the terminal status-reporter call site. Absent → no
   * Manage line (pre-terminal phases, or when the review number isn't known).
   */
  manage?: string
  /**
   * SIG-38 Task 7: per-developer usage footer (`_Sigilix · N of M reviews used
   * in past 5h[· resets in Xm]_`), already formatted by `formatUsageFooter`.
   * Rendered as the last `> <sub>…</sub>` line in the terminal footer block.
   * ENFORCE-ONLY: only passed in enforce mode; shadow and off stay dark.
   * Display-only — never gates anything.
   */
  rateLimitFooter?: string
  footerSeed?: string
}

// SIG-471 PR-3 (was SIG-306): the canonical dismiss reasons (minus the
// `unlabeled` default), listed in the Manage line's dismiss hint so reviewers
// SUPPLY a label — an unlabeled dismissal can't be classified hard-vs-soft on the
// FP-rate ruler. Derived from `ALL_DISMISS_REASONS` so the nudge can never drift
// from the parser's accepted set.
const DISMISS_REASON_HINT = ALL_DISMISS_REASONS.filter((r) => r !== "unlabeled").join("` | `")

/**
 * SIG-471 PR-3: build the overview "Manage" footer line. ONE markdown-only line
 * (no `<sub>`/HTML so it survives a GitHub-comment PATCH edit), carrying the
 * dismiss hint, the re-run hint, the per-PR review counter, and the reviewed-at
 * short SHA — the exact info the old `<sub>` body footer carried, relocated to the
 * editable overview. Pure — exported for tests.
 */
export function formatManageLine(args: { reviewNumber?: number; shortSha?: string }): string {
  // SIG (Kimi 2026-06-19): compact, de-emphasized affordance text for the muted
  // terminal footer — no bold "**Manage:**" prefix and no trailing sha (the sha
  // is shown once after the phase in the headline). `shortSha` stays in the
  // signature for back-compat with the caller but is no longer rendered here.
  const parts = [`Dismiss \`@sigilix dismiss <reason>\` (\`${DISMISS_REASON_HINT}\`)`, "Re-run `/sigilix review`"]
  if (typeof args.reviewNumber === "number" && args.reviewNumber > 0) {
    parts.push(`Review #${args.reviewNumber}`)
  }
  return parts.join(" · ")
}

/**
 * SIG-471: the overview Proof line, Kimi-specified. Only non-zero tiers render, in
 * verified→grounded→model order, so it reads `**Proof:** 2 grounded · 1 model-only`
 * pre-receipt and `**Proof:** 1 runner-verified · 1 grounded` after the receipt
 * patches a finding to VERIFIED. Returns null when there's nothing to show.
 */
export function formatProofLine(proof: ReviewStatusProof | undefined): string | null {
  if (!proof) return null
  const parts: string[] = []
  // SIG-482 (Kimi 2026-06-20): tiers render strongest→weakest —
  // runner-verified → reproduced → grounded → model-only.
  if (proof.verified > 0) parts.push(`${proof.verified} runner-verified`)
  if (proof.reproduced > 0) parts.push(`${proof.reproduced} reproduced`)
  if (proof.grounded > 0) parts.push(`${proof.grounded} grounded`)
  if (proof.model > 0) parts.push(`${proof.model} model-only`)
  // SIG (Kimi 2026-06-19): the Proof line lives in the MUTED terminal footer —
  // a blockquoted `<sub>` line. Kept as a STANDALONE line (still carrying the
  // `**Proof:**` token) so the runner-receipt `patchProofLineInStatusBlock` can
  // find + replace it in place for the quiet grounded→verified upgrade.
  return parts.length > 0 ? `> <sub>**Proof:** ${parts.join(" · ")}</sub>` : null
}

/**
 * SIG-482 (Kimi 2026-06-20): the one-line trust-tier LEGEND, rendered directly
 * UNDER the Proof line so a reader understands what model/grounded/reproduced/
 * runner-verified mean. A standalone muted `<sub>` line (NOT carrying the
 * `**Proof:**` token, so `patchProofLineInStatusBlock` never matches it). Copy is
 * Kimi's, verbatim.
 */
export function formatProofLegend(): string {
  return (
    "> <sub>`runner-verified` = CI receipt · `reproduced` = sandbox observed diff · " +
    "`grounded` = deterministic detector/worker-token · `model-only` = model judgment only</sub>"
  )
}

/**
 * Bucket a finding into exactly ONE proof tier. Mutually exclusive, and a
 * receipt-verified finding counts ONLY as `verified` (never also grounded). The
 * tier strings are `FindingTrustTier` values persisted on the manifest:
 *   - grounded  ← runner-confirmed | deterministic-grounded | worker-token-confirmed
 *                 | grounded-model (any tier that cites real evidence + passed gates)
 *   - model     ← body-only-ungrounded, an unknown tier string, OR a missing tier
 * Robust to a missing/garbage `trustTier`: treats it as model-only.
 */
export function isGroundedTier(tier: string | undefined): boolean {
  switch (tier) {
    case "runner-confirmed":
    case "deterministic-grounded":
    case "worker-token-confirmed":
    case "grounded-model":
      return true
    default:
      // "body-only-ungrounded", unknown strings, undefined → model-only.
      // NB: "reproduced-by-execution" is deliberately NOT here — it's its own
      // (stronger) tier, bucketed by `isReproducedTier` BEFORE this check.
      return false
  }
}

/**
 * SIG-482: the REPRODUCED tier — a finding the execution sandbox ran and observed
 * diverge (rank 6, below runner-verified, above grounded). Its own proof bucket so
 * the overview Proof line shows `N reproduced` instead of miscounting it as model-only
 * (it is not in `isGroundedTier`). */
export function isReproducedTier(tier: string | undefined): boolean {
  return tier === "reproduced-by-execution"
}

/**
 * Pure: count the four proof tiers over the manifest findings, given the set of
 * finding keys the receipt-join CONFIRMED. A confirmed finding is `verified`
 * (and counts ONLY there); every other finding is `grounded` or `model` by its
 * stored `trustTier`. Mutually exclusive buckets; the four sum to the finding
 * count. Side-effect-free + dependency-free (structural finding shape, no
 * `review-manifest` import) so the bucketing is unit-tested in isolation.
 */
export function computeProofCounts(
  findings: ReadonlyArray<{ key: string; trustTier?: string }>,
  verifiedKeys: ReadonlySet<string>,
): ReviewStatusProof {
  let verified = 0
  let reproduced = 0
  let grounded = 0
  let model = 0
  for (const f of findings) {
    if (verifiedKeys.has(f.key)) {
      verified += 1
    } else if (isReproducedTier(f.trustTier)) {
      reproduced += 1
    } else if (isGroundedTier(f.trustTier)) {
      grounded += 1
    } else {
      model += 1
    }
  }
  return { verified, reproduced, grounded, model }
}

export function reviewStatusPhaseRank(phase: ReviewStatusPhase): number {
  switch (phase) {
    case "queued":
      return 0
    case "retrieval":
      return 1
    case "specialists":
      return 2
    case "synth":
      return 3
    case "degraded":
    case "skipped":
    case "failed":
      return 4
    case "posted":
      return 5
  }
}

export function buildReviewStatusBlock(snapshot: ReviewStatusSnapshot): string {
  // SIG (Kimi 2026-06-19): the TERMINAL state (`final` set — posted/failed/
  // skipped) renders a compact, MUTED footer (thin rule + small blockquoted
  // `<sub>` lines) so it reads as a footer, not a headline. The IN-PROGRESS
  // phases keep the detailed status block below (Specialists/Dispatched/… — the
  // founder finds that live "ascii" detail useful), so the compaction is
  // terminal-only.
  if (snapshot.final) return buildTerminalFooterBlock(snapshot)

  const lines: string[] = [
    REVIEW_STATUS_BLOCK_START,
    "",
    `**Phase:** ${phaseLabel(snapshot.phase)}`,
    `**Commit:** \`${snapshot.headSha.slice(0, 7)}\``,
  ]
  if (snapshot.specialists) lines.push(`**Specialists:** ${specialistSummary(snapshot.specialists)}`)
  appendList(lines, "Dispatched", snapshot.specialists?.dispatched)
  appendList(lines, "Completed", snapshot.specialists?.succeeded)
  appendList(lines, "Missing", snapshot.specialists?.missing)
  appendList(lines, "Not needed", snapshot.specialists?.notNeeded)
  appendList(lines, "Dropped files", snapshot.droppedFiles)
  const graph = graphSummary(snapshot.graphCoverage)
  if (graph) lines.push(`**Graph context:** ${graph}`)
  lines.push("")
  lines.push(REVIEW_STATUS_BLOCK_END)
  return lines.join("\n")
}

/**
 * SIG (Kimi 2026-06-19): the compact muted terminal footer. One bold phase +
 * commit + result line, the optional Proof line, then the manage affordances —
 * each a small `> <sub>…</sub>` line under a thin `---` rule. Keeps the Proof
 * line standalone for the quiet grounded→verified `patchProofLineInStatusBlock`.
 */
function buildTerminalFooterBlock(snapshot: ReviewStatusSnapshot): string {
  const headline: string[] = [`**${phaseLabel(snapshot.phase)}**`, `\`${snapshot.headSha.slice(0, 7)}\``]
  const final = snapshot.final
  if (final) {
    if (typeof final.findingsCount === "number") {
      const count = `${final.findingsCount} ${plural("finding", final.findingsCount)}`
      headline.push(final.reviewUrl ? `${count} — [View review](${final.reviewUrl})` : count)
    } else if (final.reviewUrl) {
      headline.push(`[View review](${final.reviewUrl})`)
    }
  }
  const lines: string[] = [REVIEW_STATUS_BLOCK_START, "", "---", `> <sub>${headline.join(" · ")}</sub>`]
  const proofLine = formatProofLine(snapshot.proof)
  if (proofLine) {
    lines.push(proofLine)
    // SIG-482: the trust-tier legend directly under the Proof line (only when a Proof
    // line renders). A standalone line so `patchProofLineInStatusBlock` never matches it.
    lines.push(formatProofLegend())
  }
  if (snapshot.manage) lines.push(`> <sub>${snapshot.manage}</sub>`)
  if (snapshot.rateLimitFooter) lines.push(`> <sub>${snapshot.rateLimitFooter}</sub>`)
  lines.push("")
  lines.push(REVIEW_STATUS_BLOCK_END)
  return lines.join("\n")
}

export function upsertReviewStatusBlock(body: string, snapshot: ReviewStatusSnapshot): string {
  const block = buildReviewStatusBlock(snapshot)
  const bodyWithoutStatus = removeReviewStatusBlock(body)
  return insertReviewStatusBlock(bodyWithoutStatus, block)
}

/**
 * SIG-472: extract the well-formed `review-run-status` block (START…END,
 * inclusive of both delimiters) from a comment body, or null when the body has
 * no such block (or only a malformed half-block missing its END marker). Pure —
 * the symmetric read counterpart to `insertReviewStatusBlock`.
 */
export function extractReviewStatusBlock(body: string): string | null {
  const start = body.indexOf(REVIEW_STATUS_BLOCK_START)
  if (start < 0) return null
  const end = body.indexOf(REVIEW_STATUS_BLOCK_END, start + REVIEW_STATUS_BLOCK_START.length)
  if (end <= start) return null
  return body.slice(start, end + REVIEW_STATUS_BLOCK_END.length)
}

/**
 * SIG-472: graft the status block carried by `sourceBody` onto a freshly-rendered
 * overview body, so an overview re-write PRESERVES the existing review-run-status
 * block (Phase/Commit/Specialists/Result/Proof/Manage) instead of clobbering it.
 *
 * This is the missing symmetric half of the two overview writers: the status
 * writer already preserves the overview (`upsertReviewStatusBlock` =
 * remove-then-insert around the surrounding content), but the overview writer
 * builds its body from scratch via `formatOverviewComment` and used to drop the
 * status block entirely. Grafting here makes both writers symmetric, so the
 * overview + status block coexist regardless of write order.
 *
 * Strips EVERY status block already present in `overviewBody` first (defensive —
 * `formatOverviewComment` output carries none today) so the result holds exactly
 * one block regardless of the input. When `sourceBody` carries no block, returns
 * `overviewBody` unchanged.
 */
export function graftReviewStatusBlock(overviewBody: string, sourceBody: string): string {
  const block = extractReviewStatusBlock(sourceBody)
  if (block === null) return overviewBody
  let stripped = overviewBody
  while (extractReviewStatusBlock(stripped) !== null) {
    stripped = removeReviewStatusBlock(stripped)
  }
  return insertReviewStatusBlock(stripped, block)
}

/**
 * SIG-471: patch ONLY the Proof line inside an existing status block, preserving
 * every other line (Phase/Commit/Specialists/Result/…). The runner-receipt
 * proof-update job uses this — it does NOT hold the full terminal snapshot, so it
 * must NOT call `upsertReviewStatusBlock` (which rebuilds the whole block and would
 * drop the status details). Replaces the existing Proof line IN PLACE so the
 * compact-footer order (headline → Proof → manage) is preserved across the quiet
 * grounded→verified upgrade; if there's no Proof line yet it inserts one right
 * after the headline (or, for a legacy flat block with no `> <sub>` headline,
 * before the trailing blank/END). Returns `body` unchanged when there is no status
 * block to patch (the caller's retry waits for the terminal block first) or when
 * `proof` renders nothing.
 */
export function patchProofLineInStatusBlock(body: string, proof: ReviewStatusProof | undefined): string {
  const proofLine = formatProofLine(proof)
  if (proofLine === null) return body
  const start = body.indexOf(REVIEW_STATUS_BLOCK_START)
  if (start < 0) return body
  const end = body.indexOf(REVIEW_STATUS_BLOCK_END, start + REVIEW_STATUS_BLOCK_START.length)
  if (end <= start) return body
  const after = body.slice(end)
  const lines = body.slice(start, end).split("\n")
  // Contain-match (not anchored): the Proof line is wrapped in `> <sub>…</sub>` in
  // the compact terminal footer, so `**Proof:**` is no longer at line-start.
  const isProof = (l: string): boolean => /\*\*Proof:\*\*/.test(l)
  const existingIdx = lines.findIndex(isProof)
  if (existingIdx >= 0) {
    // Replace in place (preserves headline → Proof → manage order), then drop any
    // stray duplicate Proof lines after it.
    lines[existingIdx] = proofLine
    for (let i = lines.length - 1; i > existingIdx; i--) {
      if (isProof(lines[i]!)) lines.splice(i, 1)
    }
    return lines.join("\n") + after
  }
  // No Proof line yet: insert right after the compact headline (first `> <sub>`
  // line) so it lands above the manage line; else (legacy flat block) append
  // before the trailing blank/END.
  const headlineIdx = lines.findIndex((l) => /^>\s*<sub>/.test(l))
  if (headlineIdx >= 0) {
    lines.splice(headlineIdx + 1, 0, proofLine)
    return lines.join("\n") + after
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  lines.push(proofLine, "")
  return lines.join("\n") + after
}

function removeReviewStatusBlock(body: string): string {
  const start = body.indexOf(REVIEW_STATUS_BLOCK_START)
  if (start < 0) return body
  const end = body.indexOf(REVIEW_STATUS_BLOCK_END, start + REVIEW_STATUS_BLOCK_START.length)
  if (end > start) {
    return `${body.slice(0, start).trimEnd()}\n\n${body.slice(end + REVIEW_STATUS_BLOCK_END.length).trimStart()}`.trimEnd()
  }
  return joinBodyParts(
    body.slice(0, start),
    stripMalformedStatusPreamble(body.slice(start + REVIEW_STATUS_BLOCK_START.length)),
  )
}

function stripMalformedStatusPreamble(tail: string): string {
  const lines = tail.trimStart().split("\n")
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed === "" || trimmed === "### Sigilix Review Status" || isStatusMetadataLine(trimmed)) {
      index += 1
      continue
    }
    if (trimmed === "```text") {
      index += 1
      while (index < lines.length && lines[index]!.trim() !== "```") index += 1
      if (index < lines.length) index += 1
      continue
    }
    break
  }
  return lines.slice(index).join("\n")
}

function isStatusMetadataLine(trimmed: string): boolean {
  // Compact terminal footer (Kimi 2026-06-19): the headline/Proof/manage lines are
  // `> <sub>…</sub>` and the section opens with a `---` rule — recognize both so a
  // malformed (END-less) block's footer lines are stripped, not stranded as body.
  if (trimmed === "---" || /^>\s*<sub>/.test(trimmed)) return true
  return /^\*\*(?:Phase|Commit|Specialists|Dispatched|Completed|Missing|Not needed|Dropped files|Graph context|Result|Proof|Manage):\*\*/.test(
    trimmed,
  )
}

function joinBodyParts(before: string, after: string): string {
  const prefix = before.trimEnd()
  const suffix = after.trimStart()
  if (!prefix) return suffix
  if (!suffix) return prefix
  return `${prefix}\n\n${suffix}`.trimEnd()
}

function insertReviewStatusBlock(body: string, block: string): string {
  const heading = body.indexOf(OVERVIEW_HEADING)
  if (heading >= 0) return `${body.trimEnd()}\n\n${block}`
  if (body.startsWith(OVERVIEW_MARKER)) {
    return `${OVERVIEW_MARKER}\n\n${block}\n\n${body.slice(OVERVIEW_MARKER.length).trimStart()}`
  }
  return `${block}\n\n${body}`
}

function phaseLabel(phase: ReviewStatusPhase): string {
  switch (phase) {
    case "queued":
      return "Queued"
    case "retrieval":
      return "Retrieval"
    case "specialists":
      return "Specialists"
    case "synth":
      return "Synth"
    case "posted":
      return "Posted"
    case "degraded":
      return "Degraded"
    case "skipped":
      return "Skipped"
    case "failed":
      return "Failed"
  }
}

function specialistSummary(s: ReviewStatusSpecialists): string {
  const total = s.total ?? s.dispatched?.length ?? 0
  const completed = s.completed ?? s.succeeded?.length ?? 0
  return `${completed}/${total} completed`
}

function graphSummary(g: ReviewStatusGraphCoverage | undefined): string | null {
  if (!g) return null
  const parts: string[] = []
  if (g.mode) parts.push(g.mode)
  if (typeof g.filesWithContext === "number" && typeof g.totalFiles === "number") {
    parts.push(`${g.filesWithContext}/${g.totalFiles} files`)
  }
  if (typeof g.nodes === "number") parts.push(`${g.nodes} nodes`)
  return parts.length > 0 ? parts.join("; ") : null
}

function appendList(lines: string[], label: string, values: readonly string[] | undefined): void {
  if (!values || values.length === 0) return
  lines.push(`**${label}:** ${values.slice(0, 8).join(", ")}${values.length > 8 ? `, +${values.length - 8} more` : ""}`)
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}
