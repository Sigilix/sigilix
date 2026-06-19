import { OVERVIEW_MARKER } from "./triage-pr-overview-scan"

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
  footerSeed?: string
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
  if (proof.verified > 0) parts.push(`${proof.verified} runner-verified`)
  if (proof.grounded > 0) parts.push(`${proof.grounded} grounded`)
  if (proof.model > 0) parts.push(`${proof.model} model-only`)
  return parts.length > 0 ? `**Proof:** ${parts.join(" · ")}` : null
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
  if (snapshot.final) lines.push(`**Result:** ${finalSummary(snapshot.final)}`)
  const proofLine = formatProofLine(snapshot.proof)
  if (proofLine) lines.push(proofLine)
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
 * SIG-471: patch ONLY the Proof line inside an existing status block, preserving
 * every other line (Phase/Commit/Specialists/Result/…). The runner-receipt
 * proof-update job uses this — it does NOT hold the full terminal snapshot, so it
 * must NOT call `upsertReviewStatusBlock` (which rebuilds the whole block and would
 * drop the status details). Removes any prior Proof line, then inserts the new one
 * immediately before the block END marker. Returns `body` unchanged when there is
 * no status block to patch (the caller's retry waits for the terminal block first)
 * or when `proof` renders nothing.
 */
export function patchProofLineInStatusBlock(body: string, proof: ReviewStatusProof | undefined): string {
  const proofLine = formatProofLine(proof)
  if (proofLine === null) return body
  const start = body.indexOf(REVIEW_STATUS_BLOCK_START)
  if (start < 0) return body
  const end = body.indexOf(REVIEW_STATUS_BLOCK_END, start + REVIEW_STATUS_BLOCK_START.length)
  if (end <= start) return body
  const block = body.slice(start, end)
  const after = body.slice(end)
  // Drop any existing Proof line, then re-insert before the trailing blank/END.
  const kept = block.split("\n").filter((l) => !/^\*\*Proof:\*\*/.test(l.trim()))
  // Trim trailing blank lines off the kept block, append the proof line + one blank,
  // so the END marker (in `after`) stays separated by exactly one blank line.
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop()
  kept.push(proofLine, "")
  return kept.join("\n") + after
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
  return /^\*\*(?:Phase|Commit|Specialists|Dispatched|Completed|Missing|Not needed|Dropped files|Graph context|Result|Proof):\*\*/.test(
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

function finalSummary(final: ReviewStatusFinal): string {
  const pieces: string[] = [phaseLabel(final.status)]
  if (typeof final.findingsCount === "number")
    pieces.push(`${final.findingsCount} ${plural("finding", final.findingsCount)}`)
  if (final.surface) pieces.push(`surface: ${final.surface}`)
  if (final.reviewUrl) pieces.push(`[View review](${final.reviewUrl})`)
  return pieces.join(" - ")
}

function appendList(lines: string[], label: string, values: readonly string[] | undefined): void {
  if (!values || values.length === 0) return
  lines.push(`**${label}:** ${values.slice(0, 8).join(", ")}${values.length > 8 ? `, +${values.length - 8} more` : ""}`)
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}
