import { GITHUB_MENTION_SCHEMA } from "@/src/shared/domain/schemas"
import { chunkId } from "@/src/lib/indexer-internals"
import {
  indexNamespace,
  parseRepoIndexManifest,
  repoTenantKey,
  type RepoIndexManifestV1,
} from "@/src/lib/repo-index-manifest"
import { mapWithConcurrency } from "@/src/shared/util/bounded-concurrency"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { SlackScope, SlackScopedRepo } from "@/src/lib/slack/slack-scope"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

export type SlackCodeCitationMode = "off" | "shadow" | "on"

export interface SlackCodeCitation {
  githubRepoId: number
  repo: string
  path: string
  lineStart: number
  lineEnd: number
  ref: string
  runId: string
  chunkId: string
}

export interface IssuedSlackCodeChunk {
  chunk: RetrievedChunk
  citation: SlackCodeCitation
}

export type SlackCitationPreflight = { ok: true } | { ok: false; error: string }

export interface SlackCodeCitationSession {
  readonly mode: Exclude<SlackCodeCitationMode, "off">
  preflight(namespace: string, branch: string, signal?: AbortSignal): Promise<SlackCitationPreflight>
  filterAndIssue(namespace: string, chunks: RetrievedChunk[]): Promise<IssuedSlackCodeChunk[]>
  verifyAndRender(answer: string, selected: unknown[]): Promise<string>
  emitTelemetry(): void
}

const MAX_CITATIONS = 24
const VERIFY_CONCURRENCY = 4
const GITHUB_TIMEOUT_MS = 5_000
const VERIFY_TIMEOUT_MS = 10_000
const FULL_SHA = /^[0-9a-f]{40}$/u
const RUN_ID = /^[0-9a-f]{16}$/u

export const SLACK_CODE_CITATION_REVALIDATION_FAILED =
  "I couldn't re-verify the current code references, so I won't present that answer as current. Please try again."

export const SLACK_CODE_CITATION_SCHEMA = {
  ...GITHUB_MENTION_SCHEMA,
  properties: {
    ...GITHUB_MENTION_SCHEMA.properties,
    citations: {
      type: "array",
      maxItems: MAX_CITATIONS,
      items: {
        type: "object",
        properties: {
          githubRepoId: { type: "integer", minimum: 1 },
          repo: { type: "string" },
          path: { type: "string" },
          lineStart: { type: "integer", minimum: 1 },
          lineEnd: { type: "integer", minimum: 1 },
          ref: { type: "string" },
          runId: { type: "string" },
          chunkId: { type: "string" },
        },
        required: ["githubRepoId", "repo", "path", "lineStart", "lineEnd", "ref", "runId", "chunkId"],
      },
    },
  },
  required: [...GITHUB_MENTION_SCHEMA.required],
} as const

export const SLACK_CODE_CITATION_PROMPT = `## Verified Slack citations

When retrieve_codebase returns a citation object, copy that exact object into the top-level citations array for every current-code claim it supports. Use citations: [] when none apply. Never invent or alter a citation, and do not write path:line references in prose; the server re-verifies and renders exact-commit links.`

interface ExactRepoProof {
  scopedRepo: SlackScopedRepo
  namespace: string
  headSha: string
  runId: string
  defaultBranch: string
  byPath: Record<string, string[]>
}

interface ProofFailure {
  reason:
    | "branch"
    | "repository-not-scoped"
    | "manifest-missing"
    | "manifest-invalid"
    | "manifest-mismatch"
    | "active-index-unavailable"
    | "github-unavailable"
    | "github-mismatch"
}

type ProofResult = { ok: true; proof: ExactRepoProof } | { ok: false; failure: ProofFailure }

interface IssuedCitationProof {
  citation: SlackCodeCitation
  githubRepoId: number
  owner: string
  repo: string
  namespace: string
  runId: string
  chunkId: string
  content: string
}

interface SessionCounters {
  proofEligible: number
  proofRejected: number
  chunksConsidered: number
  chunksIssued: number
  selected: number
  verified: number
}

export function parseSlackCodeCitationMode(value: unknown): SlackCodeCitationMode {
  return value === "shadow" || value === "on" ? value : "off"
}

export function extractSlackCodeCitationSelections(answer: unknown): unknown[] {
  if (!isRecord(answer) || !Array.isArray(answer.citations)) return []
  return answer.citations.slice(0, MAX_CITATIONS)
}

export function createSlackCodeCitationSession(args: {
  mode: Exclude<SlackCodeCitationMode, "off">
  env: Pick<Env, "OPENCLAW_STATE">
  scope: SlackScope
  githubClient: GitHubClient
  resolveCurrentScope(signal: AbortSignal): Promise<SlackScope | null>
}): SlackCodeCitationSession {
  const scopedByNamespace = new Map<string, SlackScopedRepo>()
  for (const repo of args.scope.repos) {
    const namespace = indexNamespace(repo.owner, repo.repo)
    const prior = scopedByNamespace.get(namespace)
    if (prior && prior.githubRepoId !== repo.githubRepoId) continue
    scopedByNamespace.set(namespace, repo)
  }

  const proofPromises = new Map<string, Promise<ProofResult>>()
  const issued = new Map<string, IssuedCitationProof>()
  let retrievalAttempted = false
  const counters: SessionCounters = {
    proofEligible: 0,
    proofRejected: 0,
    chunksConsidered: 0,
    chunksIssued: 0,
    selected: 0,
    verified: 0,
  }

  const readProof = async (namespace: string, requireOn: boolean, signal?: AbortSignal): Promise<ProofResult> => {
    const scopedRepo = scopedByNamespace.get(namespace)
    if (!scopedRepo) return failure("repository-not-scoped")
    let raw: string | null
    try {
      raw = await args.env.OPENCLAW_STATE.get(repoTenantKey(scopedRepo.githubRepoId))
    } catch {
      return failure("manifest-missing")
    }
    if (raw === null) return failure("manifest-missing")
    const parsed = parseRepoIndexManifest(raw)
    if (parsed.kind !== "ok") return failure("manifest-invalid")
    const manifest = parsed.manifest
    if (!manifestMatchesScope(manifest, scopedRepo, namespace)) return failure("manifest-mismatch")
    const activeIndex = manifest.activeIndex
    if (!activeIndex || (requireOn && activeIndex.builtMode !== "on")) {
      return failure("active-index-unavailable")
    }

    let live: Awaited<ReturnType<GitHubClient["getRepository"]>>
    try {
      live = await withAbortDeadline(
        (requestSignal) =>
          args.githubClient.getRepository(scopedRepo.owner, scopedRepo.repo, { signal: requestSignal }),
        GITHUB_TIMEOUT_MS,
        signal,
      )
    } catch {
      return failure("github-unavailable")
    }
    if (!live || live.id !== scopedRepo.githubRepoId || live.default_branch !== manifest.defaultBranch) {
      return failure("github-mismatch")
    }
    return {
      ok: true,
      proof: {
        scopedRepo,
        namespace,
        headSha: manifest.headSha,
        runId: manifest.runId,
        defaultBranch: manifest.defaultBranch,
        byPath: activeIndex.byPath,
      },
    }
  }

  const cachedProof = (namespace: string, signal?: AbortSignal): Promise<ProofResult> => {
    const normalized = namespace.trim().toLowerCase()
    let promise = proofPromises.get(normalized)
    if (!promise) {
      promise = readProof(normalized, args.mode === "on", signal)
      proofPromises.set(normalized, promise)
      void promise.then((result) => {
        if (result.ok) counters.proofEligible += 1
        else counters.proofRejected += 1
      })
    }
    return promise
  }

  return {
    mode: args.mode,

    async preflight(namespace, branch, signal) {
      if (branch.trim().length > 0 || namespace.includes("/__branch__/")) {
        return { ok: false, error: citationUnavailable(namespace, "branch") }
      }
      const result = await cachedProof(namespace, signal)
      return result.ok ? { ok: true } : { ok: false, error: citationUnavailable(namespace, result.failure.reason) }
    },

    async filterAndIssue(namespace, chunks) {
      retrievalAttempted = true
      const normalized = namespace.trim().toLowerCase()
      const result = await cachedProof(normalized)
      counters.chunksConsidered += chunks.length
      if (!result.ok) return []

      let candidates: Array<IssuedSlackCodeChunk | null>
      try {
        candidates = await Promise.all(
          chunks.map(async (chunk): Promise<IssuedSlackCodeChunk | null> => {
            const proof = result.proof
            if (!chunkEligibleForProof(chunk, proof)) return null
            const computedId = await chunkId(normalized, {
              path: chunk.path,
              lineStart: chunk.lineStart,
              lineEnd: chunk.lineEnd,
              content: chunk.content,
            })
            if (computedId !== chunk.id) return null
            const citation: SlackCodeCitation = {
              githubRepoId: proof.scopedRepo.githubRepoId,
              repo: `${proof.scopedRepo.owner}/${proof.scopedRepo.repo}`,
              path: chunk.path,
              lineStart: chunk.lineStart,
              lineEnd: chunk.lineEnd,
              ref: proof.headSha,
              runId: proof.runId,
              chunkId: chunk.id,
            }
            issued.set(citationKey(citation), {
              citation,
              githubRepoId: proof.scopedRepo.githubRepoId,
              owner: proof.scopedRepo.owner,
              repo: proof.scopedRepo.repo,
              namespace: normalized,
              runId: proof.runId,
              chunkId: chunk.id,
              content: chunk.content,
            })
            return { chunk, citation }
          }),
        )
      } catch {
        return []
      }
      const accepted = candidates.filter((value): value is IssuedSlackCodeChunk => value !== null)
      counters.chunksIssued += accepted.length
      return accepted
    },

    async verifyAndRender(answer, selected) {
      if (selected.length === 0) return retrievalAttempted ? SLACK_CODE_CITATION_REVALIDATION_FAILED : answer
      if (selected.length > MAX_CITATIONS) return SLACK_CODE_CITATION_REVALIDATION_FAILED
      counters.selected += Math.min(selected.length, MAX_CITATIONS)
      const selectedIssued: IssuedCitationProof[] = []
      const seen = new Set<string>()
      for (const raw of selected.slice(0, MAX_CITATIONS)) {
        const citation = parseCitation(raw)
        if (!citation) return SLACK_CODE_CITATION_REVALIDATION_FAILED
        const key = citationKey(citation)
        if (seen.has(key)) continue
        const exact = issued.get(key)
        if (!exact) return SLACK_CODE_CITATION_REVALIDATION_FAILED
        seen.add(key)
        selectedIssued.push(exact)
      }
      if (selectedIssued.length === 0) return SLACK_CODE_CITATION_REVALIDATION_FAILED

      const freshProofs = new Map<number, Promise<ProofResult>>()
      const fileReads = new Map<string, Promise<string | null>>()
      const settled = await withAbortDeadline(async (verifySignal) => {
        const currentScope = await args.resolveCurrentScope(verifySignal)
        if (!scopeAuthorizesIssued(currentScope, args.scope, selectedIssued)) return []
        const results = await mapWithConcurrency(selectedIssued, VERIFY_CONCURRENCY, async (entry) => {
          let proofPromise = freshProofs.get(entry.githubRepoId)
          if (!proofPromise) {
            proofPromise = readProof(entry.namespace, true, verifySignal)
            freshProofs.set(entry.githubRepoId, proofPromise)
          }
          const fresh = await proofPromise
          if (!fresh.ok || !sameIssuedProof(entry, fresh.proof)) return null
          if (!(fresh.proof.byPath[entry.citation.path] ?? []).includes(entry.chunkId)) return null

          const cacheKey = `${entry.githubRepoId}\0${entry.citation.path}\0${entry.citation.ref}`
          let filePromise = fileReads.get(cacheKey)
          if (!filePromise) {
            filePromise = withAbortDeadline(
              (requestSignal) =>
                args.githubClient.getFileContent(entry.owner, entry.repo, entry.citation.path, entry.citation.ref, {
                  signal: requestSignal,
                }),
              GITHUB_TIMEOUT_MS,
              verifySignal,
            ).catch(() => null)
            fileReads.set(cacheKey, filePromise)
          }
          const content = await filePromise
          if (content === null || !rangeMatchesIssuedContent(content, entry)) return null
          return entry.citation
        })
        const finalScope = await args.resolveCurrentScope(verifySignal)
        return scopeAuthorizesIssued(finalScope, args.scope, selectedIssued) ? results : []
      }, VERIFY_TIMEOUT_MS).catch(() => [])
      const verified = settled.flatMap((result) =>
        result.status === "fulfilled" && result.value !== null ? [result.value] : [],
      )
      counters.verified += verified.length
      return verified.length !== selectedIssued.length
        ? SLACK_CODE_CITATION_REVALIDATION_FAILED
        : renderCitationLinks(answer, verified)
    },

    emitTelemetry() {
      console.log(
        JSON.stringify({
          event: "slack-code-citations",
          mode: args.mode,
          installationId: args.scope.installationId,
          teamId: args.scope.teamId,
          channelId: args.scope.channelId,
          ...counters,
        }),
      )
    },
  }
}

function manifestMatchesScope(manifest: RepoIndexManifestV1, scopedRepo: SlackScopedRepo, namespace: string): boolean {
  const actualRepo = manifest.actualRepo ?? manifest.repo
  return (
    manifest.branch === undefined &&
    manifest.githubRepoId === scopedRepo.githubRepoId &&
    manifest.activeIndex?.githubRepoId === scopedRepo.githubRepoId &&
    manifest.owner.toLowerCase() === scopedRepo.owner.toLowerCase() &&
    manifest.repo.toLowerCase() === scopedRepo.repo.toLowerCase() &&
    actualRepo.toLowerCase() === scopedRepo.repo.toLowerCase() &&
    manifest.namespace?.toLowerCase() === namespace &&
    typeof manifest.defaultBranch === "string" &&
    manifest.defaultBranch.length > 0 &&
    FULL_SHA.test(manifest.headSha) &&
    RUN_ID.test(manifest.runId)
  )
}

function chunkEligibleForProof(chunk: RetrievedChunk, proof: ExactRepoProof): chunk is RetrievedChunk & { id: string } {
  return (
    typeof chunk.id === "string" &&
    (proof.byPath[chunk.path] ?? []).includes(chunk.id) &&
    chunk.indexedHeadSha === proof.headSha &&
    chunk.indexRunId === proof.runId &&
    safePath(chunk.path) &&
    Number.isSafeInteger(chunk.lineStart) &&
    Number.isSafeInteger(chunk.lineEnd) &&
    chunk.lineStart >= 1 &&
    chunk.lineEnd >= chunk.lineStart &&
    chunk.lineEnd <= 1_000_000
  )
}

function sameIssuedProof(entry: IssuedCitationProof, proof: ExactRepoProof): boolean {
  return (
    entry.citation.githubRepoId === entry.githubRepoId &&
    entry.citation.runId === entry.runId &&
    entry.citation.chunkId === entry.chunkId &&
    proof.scopedRepo.githubRepoId === entry.githubRepoId &&
    proof.scopedRepo.owner === entry.owner &&
    proof.scopedRepo.repo === entry.repo &&
    proof.namespace === entry.namespace &&
    proof.headSha === entry.citation.ref &&
    proof.runId === entry.runId
  )
}

function scopeAuthorizesIssued(
  current: SlackScope | null,
  initial: SlackScope,
  entries: readonly IssuedCitationProof[],
): boolean {
  if (
    current === null ||
    current.teamId !== initial.teamId ||
    current.channelId !== initial.channelId ||
    current.installationId !== initial.installationId
  ) {
    return false
  }
  const currentById = new Map(current.repos.map((repo) => [repo.githubRepoId, repo]))
  return entries.every((entry) => {
    const repo = currentById.get(entry.githubRepoId)
    return (
      repo !== undefined &&
      repo.owner.toLowerCase() === entry.owner.toLowerCase() &&
      repo.repo.toLowerCase() === entry.repo.toLowerCase()
    )
  })
}

function rangeMatchesIssuedContent(file: string, entry: IssuedCitationProof): boolean {
  const lines = file.split("\n")
  if (entry.citation.lineEnd > lines.length) return false
  return lines.slice(entry.citation.lineStart - 1, entry.citation.lineEnd).join("\n") === entry.content
}

function parseCitation(value: unknown): SlackCodeCitation | null {
  if (!isRecord(value)) return null
  const repo = typeof value.repo === "string" ? value.repo : ""
  const path = typeof value.path === "string" ? value.path : ""
  const ref = typeof value.ref === "string" ? value.ref : ""
  const runId = typeof value.runId === "string" ? value.runId : ""
  const chunkIdValue = typeof value.chunkId === "string" ? value.chunkId : ""
  const githubRepoId = value.githubRepoId
  const lineStart = value.lineStart
  const lineEnd = value.lineEnd
  if (
    !Number.isSafeInteger(githubRepoId) ||
    (githubRepoId as number) < 1 ||
    !safeRepo(repo) ||
    !safePath(path) ||
    !FULL_SHA.test(ref) ||
    !RUN_ID.test(runId) ||
    !/^[0-9a-f]{48}$/u.test(chunkIdValue)
  ) {
    return null
  }
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) return null
  if ((lineStart as number) < 1 || (lineEnd as number) < (lineStart as number) || (lineEnd as number) > 1_000_000) {
    return null
  }
  return {
    githubRepoId: githubRepoId as number,
    repo,
    path,
    lineStart: lineStart as number,
    lineEnd: lineEnd as number,
    ref,
    runId,
    chunkId: chunkIdValue,
  }
}

function safeRepo(repo: string): boolean {
  if (repo.length === 0 || repo.length > 512 || /[\u0000-\u001f\u007f]/u.test(repo)) return false
  const parts = repo.split("/")
  return parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
}

function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 1_024 || path.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(path)) {
    return false
  }
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function citationKey(citation: SlackCodeCitation): string {
  return JSON.stringify([
    citation.githubRepoId,
    citation.repo,
    citation.path,
    citation.lineStart,
    citation.lineEnd,
    citation.ref,
    citation.runId,
    citation.chunkId,
  ])
}

function renderCitationLinks(answer: string, citations: SlackCodeCitation[]): string {
  const links = citations.map((citation) => {
    const [owner, repo] = citation.repo.split("/") as [string, string]
    const path = citation.path.split("/").map(encodeURIComponent).join("/")
    const anchor =
      citation.lineStart === citation.lineEnd
        ? `#L${citation.lineStart}`
        : `#L${citation.lineStart}-L${citation.lineEnd}`
    const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${citation.ref}/${path}${anchor}`
    const labelRepo = citation.repo.replace(/[\[\]()<>|]/gu, "_")
    const labelPath = citation.path.replace(/[\[\]()<>|]/gu, "_")
    return `- [${labelRepo} · ${labelPath}:${citation.lineStart}-${citation.lineEnd}](${url})`
  })
  return `${answer}\n\nSources:\n${links.join("\n")}`
}

function citationUnavailable(namespace: string, reason: ProofFailure["reason"]): string {
  return `Verified default-branch citation proof is unavailable for '${namespace}' (${reason}).`
}

function failure(reason: ProofFailure["reason"]): ProofResult {
  return { ok: false, failure: { reason } }
}

async function withAbortDeadline<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) throw abortError()
  const controller = new AbortController()
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(abortError())
  }
  const timer = setTimeout(abort, timeoutMs)
  parentSignal?.addEventListener("abort", abort, { once: true })
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortError()), { once: true })
  })
  try {
    return await Promise.race([factory(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener("abort", abort)
  }
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
