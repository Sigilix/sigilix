// SIG-494 (Sigilix CLI Agent) — POST /v1/context: grounded-retrieval for one agent turn.
//
// The agent (running locally) POSTs {owner, repo, query}; the server returns a packed
// grounded-context slice (semantic index hits + graph symbol expansion) for the model to
// reason over — the moat that lets a cheap model skip exploring the repo blind. Auth is a
// static bearer ($OPENCLAW_SIGILIX_API_KEY), checked from the header BEFORE the body read.
//
// SOFT-FAIL BY DESIGN: this is retrieval, not a verdict — `context: null` (empty query, no
// index match, or no graph) is an honest "no grounding available" and the agent proceeds
// blind. Graph symbol-body expansion needs the GitHub App (a file fetcher); when the App
// is unconfigured / not installed / unavailable, we degrade to index-only rather than
// erroring. Only an UNEXPECTED throw → 500.
//
// #146: the response also carries a DISTINGUISHABLE `status` ("grounded" | "indexing" |
// "not-connected") alongside `context` (kept for older CLIs that ignore `status`) so the
// CLI knows WHY it got null grounding. When the App is installed but the repo has no usable
// index yet, the route ALSO self-heals — enqueuing one on-demand `index-repo` job, guarded
// by a short-TTL per-repo KV marker so polling can't spam the queue.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { gatherAgentContext } from "./agent-context"
import { loadLearnings, type LearningEntry } from "@/src/features/learnings"
import { enqueueIndexJobsForRepos, isIndexerEnabled } from "./index-producer"
import { indexNamespace, readRepoIndexManifest } from "./repo-index-manifest"

// Queries are short (a turn's intent), so the body is tiny — cap well below the diff routes.
const MAX_BODY_BYTES = 64 * 1024
// Max team-learning rules to surface as negative memory (most-recent first).
const MAX_LEARNINGS = 20

// #146: a DISTINGUISHABLE status for the CLI so it never runs blind:
//   grounded      — we returned grounding context (or the repo is already indexed).
//   indexing      — the App IS installed but no usable index exists yet (auto-heal fired).
//   not-connected — the GitHub App is not installed for this repo; nothing to index.
type ContextStatus = "grounded" | "indexing" | "not-connected"

// #146 storm guard: a short-TTL KV marker keyed per repo gates the on-demand re-index
// enqueue so a CLI polling /v1/context while indexing runs can't spam the queue. The
// consumer's freshness gate is the real de-dup; this just bounds the enqueue rate.
const INDEX_ENQUEUE_MARKER_PREFIX = "agent-context-index-enqueue:"
const INDEX_ENQUEUE_MARKER_TTL_SECONDS = 10 * 60 // 10 minutes

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface ContextApiBody {
  owner: string
  repo: string
  query: string
  /** Optional byte cap on the symbol-expansion body build (passed to the expander). */
  maxBytes?: number
  /** Optional char budget for the whole packed slice (bounds over-injection). */
  maxContextChars?: number
}

function parseBody(raw: unknown): ContextApiBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.owner !== "string" || b.owner === "") return "owner (string) is required"
  if (typeof b.repo !== "string" || b.repo === "") return "repo (string) is required"
  if (typeof b.query !== "string" || b.query.trim() === "") return "query (non-empty string) is required"
  if (
    b.maxBytes !== undefined &&
    (typeof b.maxBytes !== "number" || !Number.isInteger(b.maxBytes) || b.maxBytes <= 0)
  ) {
    return "maxBytes must be a positive integer"
  }
  if (
    b.maxContextChars !== undefined &&
    (typeof b.maxContextChars !== "number" || !Number.isInteger(b.maxContextChars) || b.maxContextChars <= 0)
  ) {
    return "maxContextChars must be a positive integer"
  }
  return {
    owner: b.owner,
    repo: b.repo,
    query: b.query,
    ...(typeof b.maxBytes === "number" ? { maxBytes: b.maxBytes } : {}),
    ...(typeof b.maxContextChars === "number" ? { maxContextChars: b.maxContextChars } : {}),
  }
}

interface Grounding {
  /** Best-effort file fetcher for graph symbol-body expansion (default-branch HEAD). */
  fetchFileContent: (path: string) => Promise<string | null>
  /** GitHub repo id (the learnings keyspace key), or null when the App is unavailable. */
  repoId: number | null
  /**
   * #146: the resolved installation id when the GitHub App IS installed for this owner/repo,
   * else null. This is the "connected vs not-connected" signal — it stays set even when the
   * client build below fails (a transient API blip doesn't mean the App is uninstalled), so
   * the route can still report `indexing` and self-heal.
   */
  installationId: number | null
}

/**
 * Resolve the GitHub-App grounding handles via ONE getRepository call: a best-effort file
 * fetcher (graph symbol-body expansion, pinned to default-branch HEAD) + the repo id (for
 * the learnings keyspace) + the installation id (the connected signal). Degrades to a null
 * fetcher + null repoId when the App is unconfigured / not installed / unavailable — never
 * throws. `installationId` is null only when the App is unconfigured or not installed.
 */
async function resolveGrounding(env: Env, owner: string, repo: string): Promise<Grounding> {
  const none: Grounding = { fetchFileContent: async () => null, repoId: null, installationId: null }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return none
  const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  if (!lookup.ok) return none
  // The App IS installed for this repo. Keep the installation id even if the client build
  // below throws — the repo is connected, only the live fetch degraded.
  const { installationId } = lookup
  try {
    const client = await buildClient(env, installationId)
    const repoMeta = await client.getRepository(owner, repo)
    const repoId = typeof repoMeta?.id === "number" ? repoMeta.id : null
    const defaultBranch = repoMeta?.default_branch ?? "main"
    const branch = await client.getBranch(owner, repo, defaultBranch).catch(() => null)
    const ref = branch?.headSha ?? defaultBranch
    return { fetchFileContent: (path: string) => client.getFileContent(owner, repo, path, ref), repoId, installationId }
  } catch {
    return { fetchFileContent: async () => null, repoId: null, installationId }
  }
}

/** One readable line per learning rule (Phase B negative memory). Polarity is surfaced so
 *  the agent tells a dismissal ("don't re-flag") from a required convention. */
function formatLearning(e: LearningEntry): string {
  const tag = e.polarity === "suppress" ? "[dismissed] " : e.polarity === "require" ? "[required] " : ""
  const cat = e.category ? ` (${e.category})` : ""
  return `${tag}${e.rule.trim()}${cat}`
}

/** Parse a learning's createdTs to epoch ms for chronological sort. `createdTs` is a bare
 *  string (no schema-enforced format), so don't rely on lexicographic order — a date-only
 *  value would sort before a full-ISO one. Unparseable → 0 (sorts last under desc). */
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

/**
 * #146: the App is installed but this turn grounded nothing. Read the index manifest to tell
 * "indexed, the query just didn't match" (→ grounded, no heal) from "no usable index yet"
 * (→ indexing, self-heal). Soft-fails to "indexing" — a manifest-read blip must never throw
 * into the route. A valid manifest means the index is built; missing/invalid means it isn't.
 */
async function resolveInstalledStatus(
  env: Env,
  owner: string,
  repo: string,
  installationId: number,
  repoId: number | null,
): Promise<ContextStatus> {
  if (!env.OPENCLAW_STATE) return "indexing"
  let manifestKind: "ok" | "absent"
  try {
    const manifest = await readRepoIndexManifest(env, owner, repo)
    manifestKind = manifest.kind === "ok" ? "ok" : "absent"
  } catch {
    return "indexing"
  }
  // Index already built — the repo is grounded, this query just matched nothing. Don't heal.
  if (manifestKind === "ok") return "grounded"
  // No usable index yet → indexing. Self-heal best-effort (guarded against enqueue storms).
  await maybeEnqueueOnDemandIndex(env, owner, repo, installationId, repoId)
  return "indexing"
}

/**
 * #146 self-heal: enqueue ONE `index-repo` job for an installed-but-unindexed repo, guarded
 * by a short-TTL per-repo KV marker so repeated /v1/context polls during indexing can't spam
 * the queue. No-ops when the indexer flag is off (no consumer to run the job). Never throws.
 */
async function maybeEnqueueOnDemandIndex(
  env: Env,
  owner: string,
  repo: string,
  installationId: number,
  repoId: number | null,
): Promise<void> {
  if (!isIndexerEnabled(env) || !env.OPENCLAW_STATE) return
  const markerKey = `${INDEX_ENQUEUE_MARKER_PREFIX}${indexNamespace(owner, repo)}`
  try {
    if ((await env.OPENCLAW_STATE.get(markerKey)) !== null) return // a recent enqueue exists — storm guard
  } catch {
    return // can't read the guard → don't risk a storm
  }
  let succeeded = 0
  try {
    const result = await enqueueIndexJobsForRepos({
      env,
      installationId,
      repositories: [{ full_name: `${owner}/${repo}`, ...(repoId !== null ? { id: repoId } : {}) }],
      reason: "on-demand-context-miss",
    })
    succeeded = result.succeeded
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "agent-context-self-heal-enqueue-failed",
        owner,
        repo,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return
  }
  // Only mark when the enqueue actually landed, so a failed attempt retries on the next call.
  if (succeeded > 0) {
    try {
      await env.OPENCLAW_STATE.put(markerKey, new Date().toISOString(), {
        expirationTtl: INDEX_ENQUEUE_MARKER_TTL_SECONDS,
      })
    } catch {
      // Marker is best-effort; the consumer's freshness gate is the real de-dup.
    }
  }
}

/**
 * POST /v1/context — see file header. Returns { status, context, telemetry }; `context` is
 * null when nothing could be grounded, and `status` distinguishes grounded / indexing /
 * not-connected so the CLI never runs blind. 503 until keyed; 401 on bad bearer; 400/413 on
 * a bad/oversized body; 500 only on an unexpected engine throw.
 */
export async function handleAgentContextRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_SIGILIX_API_KEY
  if (!token) return json({ error: "context_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  const { fetchFileContent, repoId, installationId } = await resolveGrounding(env, parsed.owner, parsed.repo)
  const learnings = repoId !== null ? await loadRepoLearnings(env, repoId) : []

  try {
    const result = await gatherAgentContext({
      owner: parsed.owner,
      repo: parsed.repo,
      query: parsed.query,
      env,
      fetchFileContent,
      ...(learnings.length > 0 ? { learnings } : {}),
      ...(parsed.maxBytes !== undefined ? { maxBytes: parsed.maxBytes } : {}),
      ...(parsed.maxContextChars !== undefined ? { maxContextChars: parsed.maxContextChars } : {}),
    })

    // #146: a distinguishable status alongside the (backward-compatible) context payload.
    //   context non-null            → grounded (we returned grounding).
    //   installed, but nothing yet  → indexing if no usable index (self-heals), else grounded.
    //   not installed               → not-connected (can't ground; nothing to index).
    let status: ContextStatus
    if (result.context !== null) {
      status = "grounded"
    } else if (installationId === null) {
      status = "not-connected"
    } else {
      status = await resolveInstalledStatus(env, parsed.owner, parsed.repo, installationId, repoId)
    }

    return json({ status, context: result.context, telemetry: result.telemetry }, 200)
  } catch (err) {
    return json({ error: "context_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }
}
