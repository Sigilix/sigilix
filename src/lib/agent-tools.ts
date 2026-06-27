// Per-run tool factory for the Phase 3 agent loop. NOT a global
// registry — `createAgentTools(ctx)` builds the tool set with the
// surface's available context.
//
// Linear handlers don't have GitHub auth/repo identity, so exposing
// `fetch_pr` / `read_file_lines` to a Linear-originated loop would
// fail at execution time. The factory only includes tools the surface
// CAN actually serve (Linear: retrieve_codebase only; GitHub: all 3).
//
// Tool result semantics (Codex round-2 + Kimi round-2):
//
//   - `execute()` RETURNS structured failures (`{ok:false, error, ...}`)
//     for things the model can course-correct on (e.g. allowedRepo
//     mismatches). Loop appends as a tool message; model retries with
//     valid input.
//   - `execute()` THROWS only on genuine I/O / auth / runtime failures
//     (network down, install token expired, adapter bug). Loop catches
//     and fails with `tool_execution_failed` → caller falls back to
//     single-shot.
//   - AbortError from the loop's wall-clock signal is re-thrown so the
//     loop's catch can map it to `wall_clock_exceeded`.

import { fetchPullRequestContext } from "./github-pr-context"
import { encodeBranchName, parseBranchNamespace } from "./index-branch"
import { indexNamespace } from "./repo-index-manifest"
import { retrieveChunks, type RetrievedChunk } from "./retrieval"
import { expandHitsToSymbols } from "./symbol-expansion"
import { mentionSymbolExpansionMode } from "./graph-flags"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { withTimeout } from "@/src/shared/util/with-timeout"
import type { Env } from "@/src/shared/types/env"

const READ_FILE_MAX_LINES = 200
const READ_FILE_LOOP_BUDGET_BYTES = 50_000
const READ_FILE_LOOP_BUDGET_KEY = "read_file_lines:bytes_used"

export interface AgentToolsContext {
  env: Env
  surface: "linear-mention" | "github-mention" | "slack-mention"
  /** GitHub-only: present when surface = "github-mention", or when the
   *  Linear team-repo mapping resolves a repo for the asker's team.
   *  Drives `allowedRepo` enforcement on `fetch_pr` / `read_file_lines`. */
  github?: {
    githubClient: GitHubClient
    allowedRepos: Array<{ owner: string; repo: string }>
    /** Default ref for `read_file_lines` when caller doesn't specify. */
    defaultRef: string
    installationId: number
  }
  /** Optional allow-list of lowercased Vectorize namespaces the
   *  `retrieve_codebase` tool will accept. Three states:
   *   - `undefined`: no restriction (back-compat for callers that
   *     don't pass it, e.g. github-mention surface).
   *   - `[]`: explicit lock to none — every call gets the recoverable
   *     rejection. ARC-239 (2026-05-16): empty signals "no repos
   *     indexed yet" because `listIndexedRepos` is KV-backed and an
   *     empty `repo-index-manifest:*` prefix returns `[]`. The agent
   *     correctly degrades to "no retrieval available" rather than
   *     soft-failing to zero results from an unindexed namespace.
   *   - non-empty: repo must be in the set (case-insensitive match). */
  allowedRepos?: string[]
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema for ChatToolDef
  /**
   * Execute the tool. Returns ANY value the loop will JSON.stringify
   * into the `role:"tool"` message content. Returning a structured
   * `{ok:false, error, ...}` is the recoverable path — model retries.
   * Throwing is for genuine runtime failures only (loop fails fast).
   */
  execute(args: Record<string, unknown>, signal: AbortSignal, perLoopContext: Map<string, unknown>): Promise<unknown>
}

export function createAgentTools(ctx: AgentToolsContext): AgentTool[] {
  const tools: AgentTool[] = [makeRetrieveCodebase(ctx)]
  if (ctx.github) {
    tools.push(makeFetchPr(ctx, ctx.github))
    tools.push(makeReadFileLines(ctx, ctx.github))
  }
  return tools
}

// ───────────────────────────────────────────────────────────── retrieve_codebase

function makeRetrieveCodebase(ctx: AgentToolsContext): AgentTool {
  return {
    name: "retrieve_codebase",
    description:
      "Semantic retrieval over the indexed codebase. Returns top-K relevant chunks with file path, line range, content, and indexed ref/freshness when available. Prefer current default-branch chunks for citations, and refine your query if the first call returns irrelevant chunks.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of what you're looking for.",
        },
        repo: {
          type: "string",
          description:
            "Repository namespace (lowercased), `<owner>/<repo>` for the default branch. A bare repo name is also accepted and resolves when it uniquely matches an allowed namespace.",
        },
        branch: {
          type: "string",
          description:
            "Optional human Git branch name, such as `dev` or `feature/foo`. Use this with `repo: '<owner>/<repo>'` when the indexed namespace list includes that branch.",
        },
      },
      required: ["query", "repo"],
    },
    async execute(args, signal): Promise<unknown> {
      const query = typeof args.query === "string" ? args.query : ""
      const repo = typeof args.repo === "string" ? args.repo : ""
      const branch = typeof args.branch === "string" ? args.branch.trim() : ""
      if (!query || !repo) {
        return {
          ok: false,
          error: "retrieve_codebase requires non-empty `query` and `repo` strings",
        }
      }
      // SIG-132 / SIG-35: the Vectorize namespace is `<owner>/<repo>`
      // lowercased for default branch and `<owner>/<repo>/__branch__/<hexEncodedBranch>`
      // for branch-scoped indexes.
      // The allowed namespace universe comes from:
      //   - `ctx.allowedRepos` (Linear surface) — `listIndexedRepos`
      //     returns `<owner>/<repo>` namespaces (the KV key suffix).
      //   - `ctx.github.allowedRepos` (GitHub surface) — `{owner, repo}`
      //     tuples mapped through `indexNamespace`.
      // Resolve the model's `repo` arg (which may be a bare repo or a
      // full namespace) against that universe.
      const namespaceUniverse: string[] | undefined =
        ctx.allowedRepos !== undefined
          ? ctx.allowedRepos.map((r) => r.toLowerCase())
          : ctx.github
            ? ctx.github.allowedRepos.map((r) => indexNamespace(r.owner, r.repo))
            : undefined

      let namespace = repo.trim().toLowerCase()

      // CR PR #30 catch: enforce the namespace universe at execution
      // time, not just in prompt text. Otherwise the model could query
      // an unindexed namespace, retrieveChunks would soft-fail to [],
      // and the model gets no hint that its choice was invalid.
      //
      // `[]` means "lock to none." ARC-239 (2026-05-16):
      // `listIndexedRepos` is KV-backed and returns `[]` when no
      // `repo-index-manifest:*` records exist; this gate cleanly rejects
      // retrieval against unindexed namespaces.
      if (namespaceUniverse !== undefined) {
        if (namespaceUniverse.length === 0) {
          return {
            ok: false,
            error: "No indexed repositories are available in the current retrieval scope.",
            allowedRepos: namespaceUniverse,
          }
        }
        const allowed = new Set(namespaceUniverse)
        if (branch.length > 0) {
          const resolvedBranch = await resolveBranchNamespace(namespaceUniverse, namespace, branch)
          if (resolvedBranch.ok) {
            namespace = resolvedBranch.namespace
          } else {
            return {
              ok: false,
              error: resolvedBranch.error,
              allowedRepos: namespaceUniverse,
              availableBranches: resolvedBranch.availableBranches,
            }
          }
        } else if (!allowed.has(namespace)) {
          // SIG-132 back-compat: the model may pass a bare repo (no
          // owner). Resolve it to a namespace IFF it uniquely matches
          // the `<repo>` segment of exactly one default-branch namespace. Branch
          // namespaces require an exact namespace because branch names are
          // not unique or reliably encoded from natural language unless
          // the caller supplies the explicit `branch` argument above.
          const matches = namespaceUniverse.filter((ns) => {
            const parts = ns.split("/")
            return parts.length === 2 && parts[1] === namespace
          })
          if (matches.length === 1) {
            namespace = matches[0] as string
          } else {
            return {
              ok: false,
              error: `repo '${repo}' is not in the indexed namespace set`,
              allowedRepos: namespaceUniverse,
            }
          }
        }
      }
      // The signal here is the loop's wall-clock signal; if it fires
      // mid-retrieval, the underlying embed/query calls will see it
      // through their own AbortSignal plumbing. retrieveChunks itself
      // is soft-fail (returns []) on internal errors, so we don't need
      // a try/catch here for runtime errors — only AbortError needs
      // re-throwing for the loop's wall_clock_exceeded mapping.
      if (signal.aborted) {
        const err = new Error("aborted") as Error & { name: string }
        err.name = "AbortError"
        throw err
      }
      const chunks: RetrievedChunk[] = await retrieveChunks({
        text: query,
        teamKey: namespace,
        env: ctx.env,
      })
      const noChunksMessage =
        chunks.length === 0
          ? `Retrieval returned no chunks for repo '${namespace}'. Refine the query; if this persists, retrieval may be temporarily unavailable.`
          : undefined
      // SIG-407: the agentic seam. The single-shot mention path expands hits to
      // enclosing symbols; this tool returns RAW chunks to the agent loop, so
      // without this a future OPENCLAW_AGENTIC_GITHUB_MODE=on would silently
      // BYPASS symbol expansion (the chatEnabled kill-switch lesson — a flag that
      // covers one path is a latent P0). Attach the same expanded block as a NEW
      // optional field; the `chunks` array is unchanged (additive). Only fires for
      // the GitHub surface (it needs a file fetcher + owner/repo) with the flag
      // `on`; `off`/`shadow`/Linear omit it → tool output byte-identical.
      const symbolContext = await maybeExpandSymbolsForTool(ctx, namespace, chunks)
      return {
        ok: true,
        repo: namespace,
        chunks: chunks.map((c) => ({
          path: c.path,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          score: c.score,
          content: c.content,
          ...(c.indexedRef ? { indexedRef: c.indexedRef } : {}),
          ...(c.indexedHeadSha ? { indexedHeadSha: c.indexedHeadSha } : {}),
          ...(c.indexRunId ? { indexRunId: c.indexRunId } : {}),
          ...(c.indexFreshness ? { indexFreshness: c.indexFreshness } : {}),
        })),
        count: chunks.length,
        ...(noChunksMessage ? { message: noChunksMessage } : {}),
        ...(symbolContext ? { symbolContext } : {}),
      }
    },
  }
}

/**
 * SIG-407: build the symbol-expansion block for the agentic `retrieve_codebase`
 * tool, or return null when it should not / cannot fire. Returns null unless:
 *   - the flag mode is `on` (`off`/`shadow` never inject — `shadow` measures
 *     cost in the SINGLE-SHOT path; the tool stays byte-identical), AND
 *   - the surface has a GitHub client + repo identity (the expander needs a file
 *     fetcher and owner/repo; the Linear surface has neither), AND
 *   - the resolved Vectorize `namespace` maps back to EXACTLY ONE allowed
 *     `{owner,repo}` (so the body fetcher targets the right repo; a branch
 *     namespace or an ambiguous match falls through to no expansion).
 * Never throws: `expandHitsToSymbols` already soft-fails to `{block:null}`.
 */
async function maybeExpandSymbolsForTool(
  ctx: AgentToolsContext,
  namespace: string,
  chunks: RetrievedChunk[],
): Promise<string | null> {
  if (chunks.length === 0) return null
  if (mentionSymbolExpansionMode(ctx.env) !== "on") return null
  const gh = ctx.github
  if (!gh) return null
  const matches = gh.allowedRepos.filter((r) => indexNamespace(r.owner, r.repo) === namespace)
  if (matches.length !== 1) return null
  const { owner, repo } = matches[0] as { owner: string; repo: string }
  const expansion = await expandHitsToSymbols({
    env: ctx.env,
    owner,
    repo,
    hits: chunks,
    fetchFileContent: (path) => gh.githubClient.getFileContent(owner, repo, path, gh.defaultRef),
  })
  return expansion.block
}

interface BranchChoice {
  repo: string
  /**
   * SIG-218: encoded (hashed) branch segment, not the human branch name.
   * The hash is irreversible — surfaces that need to display branch names
   * must source them from a separate channel (e.g. the KV manifest).
   */
  encodedBranch: string
  namespace: string
}

type BranchResolution =
  | { ok: true; namespace: string }
  | { ok: false; error: string; availableBranches: BranchChoice[] }

async function resolveBranchNamespace(
  namespaceUniverse: string[],
  requestedRepo: string,
  requestedBranch: string,
): Promise<BranchResolution> {
  const branchChoices = namespaceUniverse
    .map((ns) => parseBranchNamespace(ns))
    .filter((ns): ns is NonNullable<ReturnType<typeof parseBranchNamespace>> => ns !== null)
    .map(
      (ns): BranchChoice => ({
        repo: `${ns.owner}/${ns.repo}`,
        encodedBranch: ns.encodedBranch,
        namespace: ns.namespace,
      }),
    )

  const repoMatches = branchChoices.filter(
    (choice) =>
      requestedRepo === choice.repo ||
      requestedRepo === choice.repo.slice(choice.repo.indexOf("/") + 1) ||
      requestedRepo === choice.namespace,
  )

  // SIG-218: match on the bounded-length hash of the requested branch.
  // The encoded form is `encodeBranchName(branch.trim())` — same trim +
  // hash that the indexer applies when constructing the namespace. Case-
  // folding mirrors the prior behaviour (encode lowercased fallback).
  const trimmed = requestedBranch.trim()
  const exactEncoded = await encodeBranchName(trimmed)
  const exactBranch = repoMatches.filter((choice) => choice.encodedBranch === exactEncoded)
  if (exactBranch.length === 1) return { ok: true, namespace: exactBranch[0]!.namespace }

  const foldedEncoded = trimmed === trimmed.toLowerCase() ? exactEncoded : await encodeBranchName(trimmed.toLowerCase())
  const foldedBranch = repoMatches.filter((choice) => choice.encodedBranch === foldedEncoded)
  if (foldedBranch.length === 1) return { ok: true, namespace: foldedBranch[0]!.namespace }

  const availableBranches = repoMatches.length > 0 ? repoMatches : branchChoices
  return {
    ok: false,
    error: `branch '${requestedBranch}' is not indexed for repo '${requestedRepo}'`,
    availableBranches,
  }
}

// ───────────────────────────────────────────────────────────── fetch_pr

function makeFetchPr(ctx: AgentToolsContext, gh: NonNullable<AgentToolsContext["github"]>): AgentTool {
  return {
    name: "fetch_pr",
    description:
      "Fetch a GitHub PR's title, body, file list, and unified diff. Use when the asker references a PR by URL or number AND you need to see what changed in it. Returns truncated diff (<=250 lines, <=20k chars) + first 50 changed filenames.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "integer", minimum: 1 },
      },
      required: ["owner", "repo", "number"],
    },
    async execute(args): Promise<unknown> {
      const owner = typeof args.owner === "string" ? args.owner : ""
      const repo = typeof args.repo === "string" ? args.repo : ""
      const numberRaw = typeof args.number === "number" ? args.number : Number.NaN
      const number = Number.isInteger(numberRaw) && numberRaw > 0 ? numberRaw : 0
      if (!owner || !repo || !number) {
        return {
          ok: false,
          error: "fetch_pr requires non-empty `owner` (string), `repo` (string), `number` (positive integer)",
        }
      }

      // allowedRepo enforcement (joint Codex+Kimi round 2): RECOVERABLE
      // tool result, NOT a throw. Model can course-correct.
      if (!gh.allowedRepos.some((r) => r.owner === owner && r.repo === repo)) {
        return {
          ok: false,
          error: `Repo ${owner}/${repo} is outside the allowed set for this mention.`,
          allowedRepos: gh.allowedRepos,
        }
      }

      // Phase 1's fetchPullRequestContext returns its own structured
      // PrFetchResult ({ok, context} | {ok:false, reason}). Pass it
      // through verbatim — both shapes are recoverable from the
      // model's perspective.
      const result = await fetchPullRequestContext({
        owner,
        repo,
        number,
        env: ctx.env,
      })
      if (!result.ok) {
        return { ok: false, error: `fetch_pr failed: ${result.reason}` }
      }
      return { ok: true, pr: result.context }
    },
  }
}

// ───────────────────────────────────────────────────────────── read_file_lines

function makeReadFileLines(ctx: AgentToolsContext, gh: NonNullable<AgentToolsContext["github"]>): AgentTool {
  return {
    name: "read_file_lines",
    description:
      "Read a specific line range of a file in the indexed repo. Use ONLY after retrieve_codebase points you at a file and you need lines beyond the chunk's window.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: {
          type: "string",
          description: "Branch name or commit SHA. Defaults to the repo's main branch.",
        },
        path: { type: "string" },
        lineStart: { type: "integer", minimum: 1 },
        lineEnd: { type: "integer", minimum: 1, maximum: 100_000 },
      },
      required: ["owner", "repo", "path", "lineStart", "lineEnd"],
    },
    async execute(args, signal, perLoopContext): Promise<unknown> {
      const owner = typeof args.owner === "string" ? args.owner : ""
      const repo = typeof args.repo === "string" ? args.repo : ""
      const path = typeof args.path === "string" ? args.path : ""
      const ref = typeof args.ref === "string" && args.ref.length > 0 ? args.ref : gh.defaultRef
      const lineStartRaw = typeof args.lineStart === "number" ? args.lineStart : Number.NaN
      const lineEndRaw = typeof args.lineEnd === "number" ? args.lineEnd : Number.NaN
      const lineStart = Number.isInteger(lineStartRaw) && lineStartRaw > 0 ? lineStartRaw : 0
      const lineEnd = Number.isInteger(lineEndRaw) && lineEndRaw > 0 ? lineEndRaw : 0
      if (!owner || !repo || !path || !lineStart || !lineEnd) {
        return {
          ok: false,
          error:
            "read_file_lines requires `owner`, `repo`, `path` (strings), `lineStart`, `lineEnd` (positive integers)",
        }
      }

      // Codex round-3 catch: lineEnd must be >= lineStart. JSON Schema
      // doesn't enforce ordering between two integers.
      if (lineEnd < lineStart) {
        return {
          ok: false,
          error: `lineEnd (${lineEnd}) must be >= lineStart (${lineStart})`,
        }
      }

      // Per-call line budget (200) — defends against the model asking
      // for "lines 1-100000."
      if (lineEnd - lineStart + 1 > READ_FILE_MAX_LINES) {
        return {
          ok: false,
          error: `read_file_lines per-call cap is ${READ_FILE_MAX_LINES} lines; requested ${lineEnd - lineStart + 1}. Make smaller, targeted reads.`,
        }
      }

      // allowedRepo (recoverable, see fetch_pr).
      if (!gh.allowedRepos.some((r) => r.owner === owner && r.repo === repo)) {
        return {
          ok: false,
          error: `Repo ${owner}/${repo} is outside the allowed set for this mention.`,
          allowedRepos: gh.allowedRepos,
        }
      }

      // Per-loop bytes budget (50KB across all read_file_lines calls).
      // Tracked in the perLoopContext Map (Kimi round-2).
      const bytesUsed = (perLoopContext.get(READ_FILE_LOOP_BUDGET_KEY) as number | undefined) ?? 0
      if (bytesUsed >= READ_FILE_LOOP_BUDGET_BYTES) {
        return {
          ok: false,
          error: `read_file_lines per-loop budget exhausted (${bytesUsed}/${READ_FILE_LOOP_BUDGET_BYTES} bytes). No more reads this loop.`,
        }
      }

      // Authenticated GitHub client per-call (token may have rotated).
      // Throws on auth failure — that's a real runtime error the loop
      // should fail on (not something the model can fix).
      let token: string
      try {
        token = await getInstallationToken({
          kv: ctx.env.OPENCLAW_STATE,
          appId: ctx.env.GITHUB_APP_ID ?? "",
          privateKey: ctx.env.GITHUB_PRIVATE_KEY ?? "",
          installationId: gh.installationId,
        })
      } catch (e) {
        // Re-throw as runtime failure — installation token is auth
        // infrastructure, not something the model can course-correct.
        throw new Error(`read_file_lines: install token failed: ${String(e)}`)
      }
      const client = new GitHubClient({ token })

      const content = await withTimeout(() => client.getFileContent(owner, repo, path, ref), 5_000).catch(
        (e: unknown) => {
          if (isAbortError(e)) throw e // re-throw for wall_clock_exceeded mapping
          return null // file fetch failed (404, 5xx, etc.) — recoverable
        },
      )
      if (signal.aborted) {
        const err = new Error("aborted") as Error & { name: string }
        err.name = "AbortError"
        throw err
      }
      if (content === null) {
        return {
          ok: false,
          error: `Could not read ${owner}/${repo}/${path}@${ref}. File missing, too large (>1MB), or not a regular file.`,
        }
      }

      // Slice the requested line range. 1-based, inclusive on both ends.
      const lines = content.split("\n")
      if (lineStart > lines.length) {
        return {
          ok: false,
          error: `lineStart ${lineStart} exceeds file length (${lines.length} lines).`,
        }
      }
      const sliced = lines.slice(lineStart - 1, Math.min(lineEnd, lines.length))
      const sliceText = sliced.join("\n")
      const sliceBytes = new TextEncoder().encode(sliceText).length

      // Update the per-loop budget. Allow this call to land even if it
      // pushes the budget slightly over — counter applies to NEXT call.
      perLoopContext.set(READ_FILE_LOOP_BUDGET_KEY, bytesUsed + sliceBytes)

      return {
        ok: true,
        path,
        ref,
        lineStart,
        lineEnd: Math.min(lineEnd, lines.length),
        totalLinesInFile: lines.length,
        content: sliceText,
        bytesReturned: sliceBytes,
        bytesBudgetRemaining: Math.max(0, READ_FILE_LOOP_BUDGET_BYTES - bytesUsed - sliceBytes),
      }
    },
  }
}

// ───────────────────────────────────────────────────────────── helpers

function isAbortError(error: unknown): boolean {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name
    return typeof name === "string" && name === "AbortError"
  }
  return false
}
