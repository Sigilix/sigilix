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

export interface ReviewStatusSnapshot {
  phase: ReviewStatusPhase
  headSha: string
  sequence: number
  specialists?: ReviewStatusSpecialists
  droppedFiles?: readonly string[]
  graphCoverage?: ReviewStatusGraphCoverage
  final?: ReviewStatusFinal
  footerSeed?: string
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
  lines.push("")
  lines.push(REVIEW_STATUS_BLOCK_END)
  return lines.join("\n")
}

export function upsertReviewStatusBlock(body: string, snapshot: ReviewStatusSnapshot): string {
  const block = buildReviewStatusBlock(snapshot)
  const bodyWithoutStatus = removeReviewStatusBlock(body)
  return insertReviewStatusBlock(bodyWithoutStatus, block)
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
  return /^\*\*(?:Phase|Commit|Specialists|Dispatched|Completed|Missing|Not needed|Dropped files|Graph context|Result):\*\*/.test(
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
