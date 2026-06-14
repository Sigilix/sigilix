import { OVERVIEW_MARKER } from "./triage-pr-overview-scan"

export { REVIEW_STATUS_ASCII_FOOTERS, selectReviewStatusAsciiFooter } from "./pr-review-status-ascii"

export const REVIEW_STATUS_BLOCK_START = "<!-- sigilix:review-run-status:start -->"
export const REVIEW_STATUS_BLOCK_END = "<!-- sigilix:review-run-status:end -->"

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
  const lines: string[] = [REVIEW_STATUS_BLOCK_START, "", "### Sigilix Review Status", ""]
  lines.push(`**Phase:** ${phaseLabel(snapshot.phase)}`)
  lines.push(`**Commit:** \`${snapshot.headSha.slice(0, 7)}\``)
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
  const start = body.indexOf(REVIEW_STATUS_BLOCK_START)
  const end = body.indexOf(REVIEW_STATUS_BLOCK_END)
  if (start >= 0 && end > start) {
    return `${body.slice(0, start).trimEnd()}\n\n${block}\n\n${body.slice(end + REVIEW_STATUS_BLOCK_END.length).trimStart()}`
  }
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
  const text = pieces.join(" - ")
  return final.reviewUrl ? `${text} - [View review](${final.reviewUrl})` : text
}

function appendList(lines: string[], label: string, values: readonly string[] | undefined): void {
  if (!values || values.length === 0) return
  lines.push(`**${label}:** ${values.slice(0, 8).join(", ")}${values.length > 8 ? `, +${values.length - 8} more` : ""}`)
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}
