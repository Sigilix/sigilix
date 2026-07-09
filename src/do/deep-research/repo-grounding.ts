// sig-deep-research-repo-grounding — the codebase-grounding seam for the
// deep-research chat. The chat was web-only: a "where does memory indexing live
// in our repo?" question ran web search and cited web pages, never the user's
// actual code — the core moat was broken. This module wires the SAME retrieval
// the PR-review path uses (`gatherAgentContext`, SIG-494) into the research run
// so a codebase question is answered from real repo files with real file-path
// citations.
//
// Two concerns, kept apart:
//   resolveRepoTarget — authorized repo scope → indexed-repo resolution. Run in
//     the ROUTE where the caller's session/tenant identity is known.
//   gatherRepoGrounding — the heavier retrieval (embed + Vectorize + graph +
//     learnings + a GitHub file fetch for symbol bodies). Run in the DO where
//     the run has a time budget.
//
// Everything soft-fails: any failure resolves to "no grounding" and the run
// falls back to web research rather than erroring — grounding must never break a
// run, only enrich it.

import type { Env } from "@/src/shared/types/env"
import type { RepoGrounding, ResearchSource } from "./types"
import { listIndexedRepos, resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { gatherAgentContext, indexNamespaceFor } from "@/src/lib/agent-context"
import { retrieveChunks, type RetrievedChunk } from "@/src/lib/retrieval"
import { loadLearnings, type LearningEntry } from "@/src/features/learnings"
import { listRepoFullNamesForInstallation } from "@/src/features/tenancy"

/** Max repo files to surface as citations (keep the source list tight). */
const MAX_REPO_SOURCES = 12
/** Max learning rules to surface as negative memory (mirrors api-context-route). */
const MAX_LEARNINGS = 20
/**
 * Char budget for the packed repo-grounding slice fed to the research/chat model.
 * `gatherAgentContext` defaults to a tight 6,000-char slice (PR-review do-no-harm
 * bound), which silently clipped the chat's repo context to ~1.5k tokens. The chat
 * should fill the model's real window, so we lift this to ~48k tokens of repo
 * context — well within the smallest chat tier's window (glm-5.1 ≈ 200K).
 */
const RESEARCH_GROUNDING_CONTEXT_CHARS = 192_000

// ── identity → repo target ────────────────────────────────────────────────

export interface ResolveRepoTargetOptions {
  /** An explicit repo the caller (portal) named for this run, if any. */
  explicitOwner?: string | undefined
  explicitRepo?: string | undefined
  /** Exact repos visible through the session user's GitHub App installations. */
  sessionRepos?: GithubUserInstallationRepoScope[] | undefined
  /** An API-key caller's installation id (0/undefined ⇒ none). */
  installationId?: number | undefined
}

export interface GithubUserInstallationRepoScope {
  installationId: number
  owner: string
  repo: string
}

export interface RepoTargetResolution {
  /** The repo to ground against this run, or null when none could be resolved. */
  target: { owner: string; repo: string } | null
  /** Whether the caller has ANY indexed repo — distinguishes "no repo connected"
   *  (→ tell them to connect one) from "connected but this query matched nothing". */
  hasIndexedRepo: boolean
}

/** Split a `<owner>/<repo>` namespace into parts; null when malformed. */
function splitNamespace(ns: string): { owner: string; repo: string } | null {
  const slash = ns.indexOf("/")
  if (slash <= 0 || slash === ns.length - 1) return null
  const owner = ns.slice(0, slash)
  const repo = ns.slice(slash + 1)
  // Reject branch-suffixed / multi-segment namespaces — ground against the base repo only.
  if (repo.includes("/")) return null
  return { owner, repo }
}

const DEFAULT_REPO_KEY_PREFIX = "deep-research-default-repo:"

function normalizedNamespace(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase()
}

async function readDefaultRepo(
  state: KVNamespace,
  installationId: number,
): Promise<{ owner: string; repo: string } | null> {
  try {
    const raw = await state.get(`${DEFAULT_REPO_KEY_PREFIX}${installationId}`)
    return raw === null ? null : splitNamespace(raw.trim())
  } catch {
    return null
  }
}

/**
 * Resolve which authorized, indexed repo to ground this run against.
 *
 * Precedence:
 *  1. An explicit `owner`/`repo`, only when exact auth scope AND a current index
 *     manifest both contain it.
 *  2. A per-installation default from KV, under the same two checks.
 *  3. The only authorized indexed repo, when the choice is unambiguous.
 * Multiple eligible repos without one declared default deliberately yield no
 * target — lexical/KV order is not a product selection rule.
 *
 * `hasIndexedRepo` reflects whether ANY candidate owner has an indexed repo, so
 * the engine can tell a never-connected caller to connect one instead of
 * answering a codebase question from generic knowledge.
 */
export async function resolveRepoTarget(env: Env, opts: ResolveRepoTargetOptions): Promise<RepoTargetResolution> {
  if (!env.OPENCLAW_STATE) return { target: null, hasIndexedRepo: false }

  let indexed: string[]
  try {
    indexed = await listIndexedRepos({ OPENCLAW_STATE: env.OPENCLAW_STATE })
  } catch {
    return { target: null, hasIndexedRepo: false }
  }
  const indexedNamespaces = new Set(indexed.map((namespace) => namespace.toLowerCase()))

  const authorized = new Map<string, { target: { owner: string; repo: string }; installationId: number | null }>()
  const addAuthorized = (owner: string, repo: string, installationId: number | null): void => {
    const namespace = normalizedNamespace(owner, repo)
    if (!indexedNamespaces.has(namespace)) return
    authorized.set(namespace, { target: { owner, repo }, installationId })
  }

  // A completed live session scope is exact (including selected-repository
  // installations). Undefined or failed scope grants nothing: matching a GitHub
  // login to an indexed owner is not authorization and would ignore revocation.
  if (opts.sessionRepos !== undefined) {
    for (const repo of opts.sessionRepos) {
      if (!Number.isInteger(repo.installationId) || repo.installationId <= 0) continue
      if (!repo.owner.trim() || !repo.repo.trim()) continue
      addAuthorized(repo.owner.trim(), repo.repo.trim(), repo.installationId)
    }
  }

  // Installation-bound API keys use D1's exact repo→installation registry. The
  // legacy global sentinel intentionally gets ZERO grounding scope here.
  if (
    opts.installationId !== undefined &&
    Number.isInteger(opts.installationId) &&
    opts.installationId > 0 &&
    opts.installationId !== LEGACY_TENANT_INSTALLATION_ID
  ) {
    const fullNames = await listRepoFullNamesForInstallation(env, opts.installationId)
    for (const fullName of fullNames) {
      const parsed = splitNamespace(fullName)
      if (parsed) addAuthorized(parsed.owner, parsed.repo, opts.installationId)
    }
  }

  const hasIndexedRepo = authorized.size > 0

  // (1) An exact, authorized, indexed explicit repo wins.
  const explicitOwner = opts.explicitOwner?.trim()
  const explicitRepo = opts.explicitRepo?.trim()
  if (explicitOwner && explicitRepo) {
    if (authorized.has(normalizedNamespace(explicitOwner, explicitRepo))) {
      return { target: { owner: explicitOwner, repo: explicitRepo }, hasIndexedRepo: true }
    }
  }

  if (!hasIndexedRepo) return { target: null, hasIndexedRepo: false }

  // (2) A declared default is valid only within the exact authorized/indexed set.
  const installationIds = [
    ...new Set([...authorized.values()].map((entry) => entry.installationId).filter((id): id is number => id !== null)),
  ].sort((a, b) => a - b)
  const defaults = new Map<string, { owner: string; repo: string }>()
  for (const installationId of installationIds) {
    const target = await readDefaultRepo(env.OPENCLAW_STATE, installationId)
    if (!target) continue
    const namespace = normalizedNamespace(target.owner, target.repo)
    const authorizedTarget = authorized.get(namespace)
    if (authorizedTarget?.installationId === installationId) defaults.set(namespace, target)
  }
  if (defaults.size === 1) return { target: [...defaults.values()][0]!, hasIndexedRepo: true }
  if (defaults.size > 1) return { target: null, hasIndexedRepo: true }

  // (3) No guessing across multiple repos.
  if (authorized.size === 1) return { target: [...authorized.values()][0]!.target, hasIndexedRepo: true }
  return { target: null, hasIndexedRepo: true }
}

// ── repo target → grounded context ────────────────────────────────────────

/** One readable line per learning rule (polarity surfaced), mirrors api-context-route. */
function formatLearning(e: LearningEntry): string {
  const tag = e.polarity === "suppress" ? "[dismissed] " : e.polarity === "require" ? "[required] " : ""
  const cat = e.category ? ` (${e.category})` : ""
  return `${tag}${e.rule.trim()}${cat}`
}

function learningTs(s: string): number {
  const n = Date.parse(s)
  return Number.isNaN(n) ? 0 : n
}

/** Load the repo's review learnings as readable rules (most-recent first, capped). Soft-fail. */
async function loadRepoLearnings(env: Env, repoId: number): Promise<string[]> {
  try {
    const store = await loadLearnings(env, "repo", String(repoId))
    if (!store || store.entries.length === 0) return []
    return [...store.entries]
      .sort((a, b) => learningTs(b.createdTs) - learningTs(a.createdTs))
      .slice(0, MAX_LEARNINGS)
      .map(formatLearning)
  } catch {
    return []
  }
}

interface GroundingHandles {
  fetchFileContent: (path: string) => Promise<string | null>
  repoId: number | null
}

/**
 * Resolve the GitHub-App file fetcher (for graph symbol-body expansion, pinned
 * to default-branch HEAD) + repo id (learnings keyspace) via ONE getRepository
 * call. Degrades to a null fetcher + null repoId when the App is unconfigured /
 * not installed / unavailable — never throws. Mirrors `resolveGrounding` in
 * api-context-route.ts so retrieval stays review-identical.
 */
async function resolveGroundingHandles(env: Env, owner: string, repo: string): Promise<GroundingHandles> {
  const none: GroundingHandles = { fetchFileContent: async () => null, repoId: null }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return none
  const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  if (!lookup.ok) return none
  try {
    const client = await buildClient(env, lookup.installationId)
    const repoMeta = await client.getRepository(owner, repo)
    const repoId = typeof repoMeta?.id === "number" ? repoMeta.id : null
    const defaultBranch = repoMeta?.default_branch ?? "main"
    const branch = await client.getBranch(owner, repo, defaultBranch).catch(() => null)
    const ref = branch?.headSha ?? defaultBranch
    return { fetchFileContent: (path: string) => client.getFileContent(owner, repo, path, ref), repoId }
  } catch {
    return none
  }
}

/** Build a GitHub blob URL for a retrieved chunk (best-effort HEAD ref). */
function blobUrl(owner: string, repo: string, path: string, lineStart: number, lineEnd: number): string {
  const anchor = lineStart > 0 ? `#L${lineStart}${lineEnd > lineStart ? `-L${lineEnd}` : ""}` : ""
  return `https://github.com/${owner}/${repo}/blob/HEAD/${path}${anchor}`
}

/**
 * Turn retrieved chunks into repo-file citation sources — one per distinct file
 * path (the best-ranked chunk wins), most-relevant first, capped. `retrieveChunks`
 * returns chunks ranked best-first, so first-seen-per-path preserves ranking.
 */
function chunksToSources(owner: string, repo: string, chunks: RetrievedChunk[]): ResearchSource[] {
  const seen = new Set<string>()
  const out: ResearchSource[] = []
  for (const c of chunks) {
    if (!c.path || seen.has(c.path)) continue
    seen.add(c.path)
    const lineRange = c.lineStart > 0 ? `:${c.lineStart}${c.lineEnd > c.lineStart ? `-${c.lineEnd}` : ""}` : ""
    out.push({
      url: blobUrl(owner, repo, c.path, c.lineStart, c.lineEnd),
      title: `${c.path}${lineRange}`,
      domain: `${owner}/${repo}`,
      kind: "repo",
    })
    if (out.length >= MAX_REPO_SOURCES) break
  }
  return out
}

export interface GatherRepoGroundingArgs {
  env: Env
  owner: string
  repo: string
  query: string
  signal?: AbortSignal
}

/**
 * Gather codebase grounding for one research question. Reuses `gatherAgentContext`
 * (the PR-review retrieval seam) for the packed prompt context, and a direct
 * `retrieveChunks` pass for the citation file list. Returns null when nothing was
 * grounded (empty query, unindexed namespace, or no match) — the caller then
 * falls back to web research.
 *
 * NOTE: the two retrieval calls each embed the query once (~one Workers-AI embed
 * apiece). Acceptable for a single chat turn; a future optimization could thread
 * the chunk list out of `gatherAgentContext` to embed once.
 */
export async function gatherRepoGrounding(args: GatherRepoGroundingArgs): Promise<RepoGrounding | null> {
  const query = args.query.trim()
  if (!query) return null
  const namespace = indexNamespaceFor(args.owner, args.repo)

  let handles: GroundingHandles
  try {
    handles = await resolveGroundingHandles(args.env, args.owner, args.repo)
  } catch {
    handles = { fetchFileContent: async () => null, repoId: null }
  }

  const learnings = handles.repoId !== null ? await loadRepoLearnings(args.env, handles.repoId) : []

  let chunks: RetrievedChunk[]
  try {
    chunks = await retrieveChunks({ text: query, teamKey: namespace, env: args.env })
  } catch {
    chunks = []
  }

  let context: string | null = null
  try {
    const result = await gatherAgentContext({
      owner: args.owner,
      repo: args.repo,
      query,
      env: args.env,
      fetchFileContent: handles.fetchFileContent,
      maxContextChars: RESEARCH_GROUNDING_CONTEXT_CHARS,
      ...(learnings.length > 0 ? { learnings } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    })
    context = result.context
  } catch {
    context = null
  }

  const sources = chunksToSources(args.owner, args.repo, chunks)

  // Nothing grounded: no packed context AND no code sources → let the run fall
  // back to web research (never fabricate repo grounding).
  if (!context && sources.length === 0) return null

  return {
    namespace,
    context: context ?? "",
    sources,
    chunkCount: chunks.length,
  }
}

// The codebase-question heuristic lives in the pure text-utils leaf so the engine
// can import it without pulling in this module's heavy retrieval deps. Re-exported
// here for callers that already depend on repo-grounding.
export { isCodebaseQuestion } from "./text-utils"
