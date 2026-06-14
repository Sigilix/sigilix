const MAX_CITATIONS = 24
const CITATION_RE = /(^|[\s`([])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d{1,6})(?:-(\d{1,6}))?/g

export interface Citation {
  raw: string
  path: string
  lineStart: number
  lineEnd: number
}

export interface InvalidCitation extends Citation {
  reason: "file-unavailable" | "invalid-range" | "line-out-of-range"
  totalLines?: number
}

export interface VerifyAndSanitizeCitationsArgs {
  answer: string
  ref: string
  fetchFileContent: (path: string, ref: string) => Promise<string | null>
}

export interface VerifyAndSanitizeCitationsResult {
  answer: string
  invalid: InvalidCitation[]
}

export async function verifyAndSanitizeCitations(
  args: VerifyAndSanitizeCitationsArgs,
): Promise<VerifyAndSanitizeCitationsResult> {
  const citations = extractCodeCitations(args.answer)
  if (citations.length === 0) return { answer: args.answer, invalid: [] }

  const byPath = new Map<string, string | null>()
  const invalid: InvalidCitation[] = []
  const unavailable = new Set<string>()
  for (const citation of citations) {
    let content = byPath.get(citation.path)
    if (!byPath.has(citation.path)) {
      try {
        content = await args.fetchFileContent(citation.path, args.ref)
      } catch {
        unavailable.add(citation.path)
        byPath.set(citation.path, null)
        continue
      }
      byPath.set(citation.path, content)
    }
    if (content === null || content === undefined) {
      unavailable.add(citation.path)
      continue
    }
    const totalLines = countLines(content)
    if (citation.lineEnd < citation.lineStart) {
      invalid.push({ ...citation, reason: "invalid-range", totalLines })
      continue
    }
    if (citation.lineStart > totalLines || citation.lineEnd > totalLines) {
      invalid.push({ ...citation, reason: "line-out-of-range", totalLines })
    }
  }

  let answer =
    invalid.length > 0
      ? appendCitationNotice(rewriteInvalidCitations(args.answer, invalid), invalid, args.ref)
      : args.answer
  if (unavailable.size > 0) answer = prependCitationUnavailableNotice(answer, Array.from(unavailable), args.ref)
  return { answer, invalid }
}

export function extractCodeCitations(answer: string): Citation[] {
  const out: Citation[] = []
  const seen = new Set<string>()
  for (const match of answer.matchAll(CITATION_RE)) {
    if (isInsideMarkdownCodeFence(answer, match.index ?? 0)) continue
    const path = match[2]
    const startRaw = match[3]
    if (!path || !startRaw) continue
    const lineStart = Number(startRaw)
    const lineEnd = match[4] ? Number(match[4]) : lineStart
    if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) continue
    const raw = `${path}:${startRaw}${match[4] ? `-${match[4]}` : ""}`
    const key = `${raw}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ raw, path, lineStart, lineEnd })
    if (out.length >= MAX_CITATIONS) break
  }
  return out
}

function isInsideMarkdownCodeFence(text: string, index: number): boolean {
  let inside = false
  const lines = text.slice(0, index).split("\n")
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inside = !inside
  }
  return inside
}

function countLines(content: string): number {
  if (content.length === 0) return 1
  return content.split("\n").length
}

function rewriteInvalidCitations(answer: string, invalid: InvalidCitation[]): string {
  const byRaw = new Map(invalid.map((citation) => [citation.raw, citation]))
  let out = ""
  let cursor = 0
  for (const match of answer.matchAll(CITATION_RE)) {
    const path = match[2]
    const startRaw = match[3]
    if (!path || !startRaw) continue
    const raw = `${path}:${startRaw}${match[4] ? `-${match[4]}` : ""}`
    const citation = byRaw.get(raw)
    if (!citation) continue
    const rawStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (isInsideMarkdownCodeFence(answer, rawStart)) continue
    out += answer.slice(cursor, rawStart)
    out += formatReplacement(citation)
    cursor = rawStart + raw.length
  }
  return out + answer.slice(cursor)
}

function formatReplacement(citation: InvalidCitation): string {
  const label =
    citation.lineStart === citation.lineEnd
      ? `line ${citation.lineStart}`
      : `lines ${citation.lineStart}-${citation.lineEnd}`
  return `${citation.path} (${label} not verified on current ref)`
}

function appendCitationNotice(answer: string, invalid: InvalidCitation[], ref: string): string {
  const details = invalid
    .map((citation) => {
      const total = citation.totalLines !== undefined ? `; file has ${citation.totalLines} line(s)` : ""
      const label =
        citation.lineStart === citation.lineEnd
          ? `${citation.path} line ${citation.lineStart}`
          : `${citation.path} lines ${citation.lineStart}-${citation.lineEnd}`
      return `${label} (${citation.reason}${total})`
    })
    .join(", ")
  return `${answer}\n\n> Citation check: ${invalid.length} citation(s) were not verified against current ref ${ref.slice(0, 12)}: ${details}.`
}

function prependCitationUnavailableNotice(answer: string, paths: string[], ref: string): string {
  return `> Citation check: Unable to verify cited file/line ranges for ${paths.join(", ")} against current ref ${ref.slice(0, 12)}; leaving those citations unchanged.\n\n${answer}`
}
