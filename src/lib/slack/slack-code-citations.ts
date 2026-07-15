import { GITHUB_MENTION_SCHEMA } from "@/src/shared/domain/schemas"
import { CITATION_CHUNK_VERSION, splitOversizedWindowV1 } from "@/src/lib/chunk-core"
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

export type SlackCitationKind = "code" | "file_lines" | "pull_request"

export interface SlackCitationRef {
  id: string
  kind: SlackCitationKind
}

/** Backward-compatible exported name for callers that imported the original
 * code-only model sidecar type. Citation-on now exposes only opaque refs; all
 * rich repository/range proof stays request-local on the server. */
export type SlackCodeCitation = SlackCitationRef

export interface IssuedSlackCodeChunk {
  chunk: RetrievedChunk
  citation: SlackCitationRef
}

export type SlackCitationPreflight = { ok: true } | { ok: false; error: string }

export interface SlackCodeCitationSession {
  readonly mode: Exclude<SlackCodeCitationMode, "off">
  preflight(namespace: string, branch: string, signal?: AbortSignal): Promise<SlackCitationPreflight>
  filterAndIssue(namespace: string, chunks: RetrievedChunk[]): Promise<IssuedSlackCodeChunk[]>
  prepareFileRead(namespace: string, requestedRef: string, signal?: AbortSignal): Promise<SlackPreparedFileRead>
  issueFileLines(args: SlackFileLinesProofInput): Promise<SlackCitationRef | null>
  issuePullRequest(args: SlackPullRequestProofInput): Promise<SlackCitationRef | null>
  verifyAndRender(answer: string, selected: unknown[]): Promise<string>
  emitTelemetry(): void
}

export type SlackPreparedFileRead = { ok: true; ref: string } | { ok: false; error: string }

export interface SlackFileLinesProofInput {
  namespace: string
  path: string
  lineStart: number
  lineEnd: number
  ref: string
  content: string
}

export interface SlackPullRequestProofInput {
  namespace: string
  number: number
  baseSha: string
  headSha: string
  source: "github_compare"
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
          id: {
            type: "string",
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          },
          kind: { type: "string", enum: ["code", "file_lines", "pull_request"] },
        },
        required: ["id", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: [...GITHUB_MENTION_SCHEMA.required],
} as const

export const SLACK_CODE_CITATION_PROMPT = `## Verified Slack citations

When an evidence tool returns a citation object, copy that exact {id, kind} object into the top-level citations array for every claim it supports. Use citations: [] when no returned evidence applies. Never invent or alter a citation, and do not write path:line references in prose; the server re-verifies and renders exact-snapshot links.`

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

interface IssuedProofBase {
  citation: SlackCitationRef
  githubRepoId: number
  owner: string
  repo: string
}

interface IssuedCodeProof extends IssuedProofBase {
  kind: "code"
  namespace: string
  runId: string
  chunkId: string
  path: string
  lineStart: number
  lineEnd: number
  ref: string
  content: string
  citationChunkVersion: number
  fragmentIndex: number
}

interface IssuedFileLinesProof extends IssuedProofBase {
  kind: "file_lines"
  namespace: string
  runId: string
  path: string
  lineStart: number
  lineEnd: number
  ref: string
  content: string
}

interface IssuedPullRequestProof extends IssuedProofBase {
  kind: "pull_request"
  number: number
  baseSha: string
  headSha: string
}

type IssuedCitationProof = IssuedCodeProof | IssuedFileLinesProof | IssuedPullRequestProof

interface SessionCounters {
  proofEligible: number
  proofRejected: number
  chunksConsidered: number
  chunksIssued: number
  fileLinesIssued: number
  pullRequestsIssued: number
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
  let requiresCitation = false
  const counters: SessionCounters = {
    proofEligible: 0,
    proofRejected: 0,
    chunksConsidered: 0,
    chunksIssued: 0,
    fileLinesIssued: 0,
    pullRequestsIssued: 0,
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

  const newCitationRef = (kind: SlackCitationKind): SlackCitationRef | null => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const citation = { id: crypto.randomUUID(), kind }
      if (!issued.has(citationKey(citation))) return citation
    }
    return null
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
              ...(chunk.fragmentIndex >= 0 ? { fragmentIndex: chunk.fragmentIndex } : {}),
            })
            if (computedId !== chunk.id) return null
            const citation = newCitationRef("code")
            if (!citation) return null
            issued.set(citationKey(citation), {
              kind: "code",
              citation,
              githubRepoId: proof.scopedRepo.githubRepoId,
              owner: proof.scopedRepo.owner,
              repo: proof.scopedRepo.repo,
              namespace: normalized,
              runId: proof.runId,
              chunkId: chunk.id,
              path: chunk.path,
              lineStart: chunk.lineStart,
              lineEnd: chunk.lineEnd,
              ref: proof.headSha,
              content: chunk.content,
              citationChunkVersion: chunk.citationChunkVersion,
              fragmentIndex: chunk.fragmentIndex,
            })
            return { chunk, citation }
          }),
        )
      } catch {
        return []
      }
      const accepted = candidates.filter((value): value is IssuedSlackCodeChunk => value !== null)
      counters.chunksIssued += accepted.length
      if (accepted.length > 0) requiresCitation = true
      return accepted
    },

    async prepareFileRead(namespace, requestedRef, signal) {
      const normalized = namespace.trim().toLowerCase()
      const result = await cachedProof(normalized, signal)
      if (!result.ok) return { ok: false, error: citationUnavailable(normalized, result.failure.reason) }
      const requested = requestedRef.trim()
      if (requested.length > 0 && requested !== result.proof.defaultBranch && requested !== result.proof.headSha) {
        return { ok: false, error: citationUnavailable(normalized, "branch") }
      }
      return { ok: true, ref: result.proof.headSha }
    },

    async issueFileLines(input) {
      const normalized = input.namespace.trim().toLowerCase()
      const result = await cachedProof(normalized)
      if (
        !result.ok ||
        input.ref !== result.proof.headSha ||
        input.content.length === 0 ||
        !safePath(input.path) ||
        !safeLineRange(input.lineStart, input.lineEnd) ||
        (result.proof.byPath[input.path] ?? []).length === 0
      ) {
        return null
      }
      const citation = newCitationRef("file_lines")
      if (!citation) return null
      issued.set(citationKey(citation), {
        kind: "file_lines",
        citation,
        githubRepoId: result.proof.scopedRepo.githubRepoId,
        owner: result.proof.scopedRepo.owner,
        repo: result.proof.scopedRepo.repo,
        namespace: normalized,
        runId: result.proof.runId,
        path: input.path,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
        ref: input.ref,
        content: input.content,
      })
      requiresCitation = true
      counters.fileLinesIssued += 1
      return citation
    },

    async issuePullRequest(input) {
      const normalized = input.namespace.trim().toLowerCase()
      const scopedRepo = scopedByNamespace.get(normalized)
      if (
        !scopedRepo ||
        input.source !== "github_compare" ||
        !Number.isSafeInteger(input.number) ||
        input.number < 1 ||
        !FULL_SHA.test(input.baseSha) ||
        !FULL_SHA.test(input.headSha)
      ) {
        return null
      }
      const citation = newCitationRef("pull_request")
      if (!citation) return null
      issued.set(citationKey(citation), {
        kind: "pull_request",
        citation,
        githubRepoId: scopedRepo.githubRepoId,
        owner: scopedRepo.owner,
        repo: scopedRepo.repo,
        number: input.number,
        baseSha: input.baseSha,
        headSha: input.headSha,
      })
      requiresCitation = true
      counters.pullRequestsIssued += 1
      return citation
    },

    async verifyAndRender(answer, selected) {
      if (selected.length === 0) return requiresCitation ? SLACK_CODE_CITATION_REVALIDATION_FAILED : answer
      if (selected.length > MAX_CITATIONS) return SLACK_CODE_CITATION_REVALIDATION_FAILED
      counters.selected += Math.min(selected.length, MAX_CITATIONS)
      const selectedIssued: IssuedCitationProof[] = []
      const seen = new Set<string>()
      for (const raw of selected.slice(0, MAX_CITATIONS)) {
        const citation = parseCitationRef(raw)
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
          if (entry.kind === "pull_request") return entry
          let proofPromise = freshProofs.get(entry.githubRepoId)
          if (!proofPromise) {
            proofPromise = readProof(entry.namespace, true, verifySignal)
            freshProofs.set(entry.githubRepoId, proofPromise)
          }
          const fresh = await proofPromise
          if (!fresh.ok || !sameIssuedRepoProof(entry, fresh.proof)) return null
          if (entry.kind === "code") {
            if (!(fresh.proof.byPath[entry.path] ?? []).includes(entry.chunkId)) return null
          } else if ((fresh.proof.byPath[entry.path] ?? []).length === 0) {
            return null
          }

          const cacheKey = `${entry.githubRepoId}\0${entry.path}\0${entry.ref}`
          let filePromise = fileReads.get(cacheKey)
          if (!filePromise) {
            filePromise = withAbortDeadline(
              (requestSignal) =>
                args.githubClient.getFileContent(entry.owner, entry.repo, entry.path, entry.ref, {
                  signal: requestSignal,
                }),
              GITHUB_TIMEOUT_MS,
              verifySignal,
            ).catch(() => null)
            fileReads.set(cacheKey, filePromise)
          }
          const content = await filePromise
          if (content === null || !rangeMatchesIssuedContent(content, entry)) return null
          return entry
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

function chunkEligibleForProof(
  chunk: RetrievedChunk,
  proof: ExactRepoProof,
): chunk is RetrievedChunk & { id: string; citationChunkVersion: number; fragmentIndex: number } {
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
    chunk.lineEnd <= 1_000_000 &&
    chunk.citationChunkVersion === CITATION_CHUNK_VERSION &&
    Number.isSafeInteger(chunk.fragmentIndex) &&
    typeof chunk.fragmentIndex === "number" &&
    chunk.fragmentIndex >= -1 &&
    chunk.fragmentIndex <= 1_000_000 &&
    (chunk.fragmentIndex === -1 || chunk.lineStart === chunk.lineEnd)
  )
}

function sameIssuedRepoProof(entry: IssuedCodeProof | IssuedFileLinesProof, proof: ExactRepoProof): boolean {
  return (
    proof.scopedRepo.githubRepoId === entry.githubRepoId &&
    proof.scopedRepo.owner === entry.owner &&
    proof.scopedRepo.repo === entry.repo &&
    proof.namespace === entry.namespace &&
    proof.headSha === entry.ref &&
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

function rangeMatchesIssuedContent(file: string, entry: IssuedCodeProof | IssuedFileLinesProof): boolean {
  const lines = file.split("\n")
  if (entry.lineEnd > lines.length) return false
  if (entry.kind === "code" && entry.fragmentIndex >= 0) {
    if (entry.citationChunkVersion !== CITATION_CHUNK_VERSION || entry.lineStart !== entry.lineEnd) return false
    const physicalLine = lines[entry.lineStart - 1]
    if (physicalLine === undefined) return false
    const fragment = splitOversizedWindowV1([physicalLine], entry.lineStart).find(
      (candidate) => candidate.fragmentIndex === entry.fragmentIndex,
    )
    return fragment?.content === entry.content
  }
  return lines.slice(entry.lineStart - 1, entry.lineEnd).join("\n") === entry.content
}

function parseCitationRef(value: unknown): SlackCitationRef | null {
  if (!isRecord(value)) return null
  if (Object.keys(value).some((key) => key !== "id" && key !== "kind")) return null
  const id = typeof value.id === "string" ? value.id : ""
  const kind = value.kind
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) return null
  if (kind !== "code" && kind !== "file_lines" && kind !== "pull_request") return null
  return { id, kind }
}

function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 1_024 || path.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(path)) {
    return false
  }
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function safeLineRange(lineStart: number, lineEnd: number): boolean {
  return (
    Number.isSafeInteger(lineStart) &&
    Number.isSafeInteger(lineEnd) &&
    lineStart >= 1 &&
    lineEnd >= lineStart &&
    lineEnd <= 1_000_000
  )
}

function citationKey(citation: SlackCitationRef): string {
  return `${citation.kind}:${citation.id}`
}

function renderCitationLinks(answer: string, citations: IssuedCitationProof[]): string {
  const links = citations.map((citation) => {
    const owner = encodeURIComponent(citation.owner)
    const repo = encodeURIComponent(citation.repo)
    const labelRepo = `${citation.owner}/${citation.repo}`.replace(/[\[\]()<>|]/gu, "_")
    if (citation.kind === "pull_request") {
      const url = `https://github.com/${owner}/${repo}/compare/${citation.baseSha}...${citation.headSha}`
      return `- [${labelRepo} · PR #${citation.number} snapshot @ ${citation.headSha.slice(0, 7)}](${url})`
    }
    const path = citation.path.split("/").map(encodeURIComponent).join("/")
    const anchor =
      citation.lineStart === citation.lineEnd
        ? `#L${citation.lineStart}`
        : `#L${citation.lineStart}-L${citation.lineEnd}`
    const url = `https://github.com/${owner}/${repo}/blob/${citation.ref}/${path}${anchor}`
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
