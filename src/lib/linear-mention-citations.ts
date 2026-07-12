import type { RetrievedChunk } from "@/src/lib/retrieval"

export const MAX_LINEAR_MENTION_CITATIONS = 24

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/
const FULL_SHA = /^[0-9a-fA-F]{40}$/

export interface LinearMentionCitation {
  repo: string
  path: string
  lineStart: number
  lineEnd: number
  ref: string
}

interface CitationResult {
  citation: LinearMentionCitation | null
  status: "verified" | "unverified"
  reason?: "invalid-metadata" | "repository-not-allowed" | "file-unavailable" | "invalid-range"
}

export interface PrependLinearCitationVerificationArgs {
  answer: string
  citations: unknown[]
  allowedRepos: string[]
  fetchFileContent: (owner: string, repo: string, path: string, ref: string) => Promise<string | null>
}

/**
 * Verify only the model's structured citation sidecar. Prose is deliberately
 * opaque: this function never scans or rewrites the answer body.
 */
export async function prependLinearCitationVerification(args: PrependLinearCitationVerificationArgs): Promise<string> {
  if (args.citations.length === 0) return args.answer

  const allowed = new Map(args.allowedRepos.map((repo) => [repo.toLowerCase(), repo]))
  const fileCache = new Map<string, Promise<string | null>>()
  const results: CitationResult[] = []
  for (const raw of args.citations.slice(0, MAX_LINEAR_MENTION_CITATIONS)) {
    const citation = parseCitation(raw)
    if (!citation) {
      results.push({ citation: null, status: "unverified", reason: "invalid-metadata" })
      continue
    }
    const canonicalRepo = allowed.get(citation.repo.toLowerCase())
    if (!canonicalRepo) {
      results.push({ citation, status: "unverified", reason: "repository-not-allowed" })
      continue
    }
    const normalizedCitation = { ...citation, repo: canonicalRepo }
    const [owner, repo] = canonicalRepo.split("/") as [string, string]
    const cacheKey = `${canonicalRepo}\0${citation.path}\0${citation.ref}`
    let request = fileCache.get(cacheKey)
    if (!request) {
      request = args.fetchFileContent(owner, repo, citation.path, citation.ref).catch(() => null)
      fileCache.set(cacheKey, request)
    }
    const content = await request
    if (content === null) {
      results.push({ citation: normalizedCitation, status: "unverified", reason: "file-unavailable" })
      continue
    }
    const totalLines = content.length === 0 ? 1 : content.split("\n").length
    if (citation.lineEnd < citation.lineStart || citation.lineEnd > totalLines) {
      results.push({ citation: normalizedCitation, status: "unverified", reason: "invalid-range" })
      continue
    }
    results.push({ citation: normalizedCitation, status: "verified" })
  }

  const lines = results.map((result, index) => renderResult(index + 1, result))
  return ["```verification", ...lines, "```", "", args.answer].join("\n")
}

/** Add copyable, structured citation metadata ahead of a Linear prompt chunk. */
export function addLinearCitationMetadata(chunks: RetrievedChunk[], primaryRepo: string): RetrievedChunk[] {
  return chunks.map((chunk) => {
    const citation = parseCitation({
      repo: chunk.repo ?? primaryRepo,
      path: chunk.path,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      ref: chunk.indexedHeadSha,
    })
    if (!citation) return chunk
    return {
      ...chunk,
      content: `[citation_metadata] ${JSON.stringify(citation)}\n${chunk.content}`,
    }
  })
}

/** Build tool-result metadata from the exact namespace + indexed commit. */
export function linearCitationMetadataForChunk(
  repoNamespace: string,
  chunk: RetrievedChunk,
): LinearMentionCitation | null {
  const parts = repoNamespace.split("/")
  const repo = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : repoNamespace
  return parseCitation({
    repo,
    path: chunk.path,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    ref: chunk.indexedHeadSha,
  })
}

function parseCitation(value: unknown): LinearMentionCitation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const repo = typeof record.repo === "string" ? record.repo : ""
  const path = typeof record.path === "string" ? record.path : ""
  const ref = typeof record.ref === "string" ? record.ref : ""
  const lineStart = record.lineStart
  const lineEnd = record.lineEnd
  if (!isSafeRepo(repo) || !isSafePath(path) || !FULL_SHA.test(ref)) return null
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) return null
  if ((lineStart as number) < 1 || (lineEnd as number) < 1 || (lineStart as number) > 1_000_000) return null
  if ((lineEnd as number) > 1_000_000 || (lineEnd as number) < (lineStart as number)) return null
  return { repo, path, lineStart: lineStart as number, lineEnd: lineEnd as number, ref }
}

function isSafeRepo(repo: string): boolean {
  if (repo.length > 256) return false
  const parts = repo.split("/")
  return parts.length === 2 && parts.every((part) => part !== "." && part !== ".." && REPO_SEGMENT.test(part))
}

function isSafePath(path: string): boolean {
  if (!path || path.length > 512 || path.startsWith("/")) return false
  const parts = path.split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && PATH_SEGMENT.test(part))
}

function renderResult(index: number, result: CitationResult): string {
  const prefix = `citation=${index} status=${result.status}`
  if (!result.citation) return `${prefix} reason=${result.reason}`
  const citation = result.citation
  const values = `repo=${citation.repo} path=${citation.path} lines=${citation.lineStart}-${citation.lineEnd} ref=${citation.ref}`
  return result.reason ? `${prefix} reason=${result.reason} ${values}` : `${prefix} ${values}`
}
