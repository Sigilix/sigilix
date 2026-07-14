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
import { requireApiTenant, callerOwnsRepo } from "@/src/lib/api-key-resolver"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { gatherAgentContext } from "./agent-context"
import { loadLearnings, resolveSurfaceMemoryApplyMode, type LearningEntry } from "@/src/features/learnings"
import { enqueueIndexJobsForRepos, isIndexerEnabled, type EnqueueIndexJobsResult } from "./index-producer"
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

/** Load a learnings store's entries, soft-failing to [] on any error. */
async function loadLearningEntriesSoft(env: Env, scope: "repo" | "org", subjectId: string): Promise<LearningEntry[]> {
  try {
    const store = await loadLearnings(env, scope, subjectId)
    return store?.entries ?? []
  } catch {
    return []
  }
}

/** Newest-first by createdTs (unparseable sorts last), matching loadRepoLearnings' original order. */
function sortNewestFirst(entries: readonly LearningEntry[]): LearningEntry[] {
  return [...entries].sort((a, b) => learningTs(b.createdTs) - learningTs(a.createdTs))
}

/**
 * One readable line for an ORG-scope guardrail, labeled HIGHER-precedence than a
 * repo fact. A durable team policy is a must-follow (`[org policy — must follow]`);
 * any other org rule is `[org guidance]`. Mirrors `surfacePromptTag`
 * (features/learnings/domain/render.ts) so an org rule reads the same everywhere.
 */
function formatOrgLearning(e: LearningEntry): string {
  const label = e.type === "durable_preference" ? "[org policy — must follow]" : "[org guidance]"
  const cat = e.category ? ` (${e.category})` : ""
  return `${label} ${e.rule.trim()}${cat}`
}

/** Load the repo's review learnings as readable rules (most-recent first, capped). Soft-fail. */
async function loadRepoLearnings(env: Env, repoId: number): Promise<string[]> {
  const entries = await loadLearningEntriesSoft(env, "repo", String(repoId))
  return sortNewestFirst(entries).slice(0, MAX_LEARNINGS).map(formatLearning)
}

/**
 * The learnings lines the CLI /v1/context grounding should surface for this turn.
 *
 * OFF (default / OPENCLAW_SURFACE_MEMORY_APPLY unset): repo-scope learnings ONLY,
 * byte-identical to before this slice — no org KV read, no installation use.
 *
 * ON: the installation's ORG guardrails ∪ the repo facts, with ORG guardrails
 * ordered FIRST and labeled higher-precedence (an org policy is inviolable team
 * guidance; a repo fact applies only where it does not conflict). A learning
 * mirrored repo→org (shared content-addressed id) surfaces ONCE as the org
 * guardrail (org wins the dedup). Total capped at MAX_LEARNINGS, org kept
 * preferentially. SEAT/personal memory is NEVER read here — /v1/context is a
 * shared grounding slice, so only org + repo scope apply (matching
 * renderSurfaceMemoryForPrompt). Fail-soft: each leg degrades to what it could
 * load; never throws.
 */
async function loadContextLearnings(
  env: Env,
  args: { repoId: number | null; installationId: number | null; orgApply: boolean },
): Promise<string[]> {
  const { repoId, installationId, orgApply } = args
  // OFF: repo-scope only, exactly as before — no org KV read.
  if (!orgApply) return repoId !== null ? await loadRepoLearnings(env, repoId) : []

  const [orgEntries, repoEntries] = await Promise.all([
    installationId !== null
      ? loadLearningEntriesSoft(env, "org", String(installationId))
      : Promise.resolve<LearningEntry[]>([]),
    repoId !== null ? loadLearningEntriesSoft(env, "repo", String(repoId)) : Promise.resolve<LearningEntry[]>([]),
  ])

  // Org guardrails win the dedup: drop a repo copy of a learning also present in
  // org, so it surfaces once as the higher-precedence org guardrail.
  const orgIds = new Set(orgEntries.map((e) => e.id))
  const orgLines = sortNewestFirst(orgEntries).map(formatOrgLearning)
  const repoLines = sortNewestFirst(repoEntries.filter((e) => !orgIds.has(e.id))).map(formatLearning)
  // Org first (inviolable), then repo facts; the cap keeps org guardrails first.
  return [...orgLines, ...repoLines].slice(0, MAX_LEARNINGS)
}

/**
 * #146: the App is installed but this turn grounded nothing. Read the index manifest to tell
 * "indexed, the query just didn't match" (→ grounded, no heal) from "no usable index yet"
 * (→ indexing, self-heal). Soft-fails to "indexing" — a manifest-read blip must never throw
 * into the route. A valid manifest with `chunkCount > 0` means the index is built AND usable;
 * missing / invalid / a zero-chunk manifest (an index run that completed without upserting
 * anything) all mean it isn't — those must fall through to self-heal too, or a repo whose only
 * index attempt produced zero chunks gets stuck reporting "grounded" forever.
 */
async function resolveInstalledStatus(
  env: Env,
  owner: string,
  repo: string,
  installationId: number,
  repoId: number | null,
): Promise<ContextStatus> {
  if (!env.OPENCLAW_STATE) return "indexing"
  try {
    const manifest = await readRepoIndexManifest(env, owner, repo)
    // Index already built with usable chunks — the repo is grounded, this query just matched
    // nothing. Don't heal.
    if (manifest.kind === "ok" && manifest.manifest.chunkCount > 0) return "grounded"
  } catch {
    return "indexing"
  }
  // No usable index yet (missing / invalid / zero-chunk manifest) → indexing. Self-heal
  // best-effort (guarded against enqueue storms).
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
  let result: EnqueueIndexJobsResult
  try {
    result = await enqueueIndexJobsForRepos({
      env,
      installationId,
      repositories: [{ full_name: `${owner}/${repo}`, ...(repoId !== null ? { id: repoId } : {}) }],
      reason: "on-demand-context-miss",
    })
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
  // Mark on a successful enqueue OR a correctly-skipped sensitive repo — both are terminal
  // outcomes for this repo. Without the sensitive case, a denylisted repo polling /v1/context
  // (which never gets an index, so the manifest check above never flips to "grounded") would
  // re-attempt — and re-skip — the enqueue on every single call forever, an unbounded
  // skip-sensitive log storm. A genuine per-repo enqueue FAILURE is the only case that should
  // retry on the next call.
  if (result.succeeded > 0 || result.sensitiveSkipped > 0) {
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
 * a bad/oversized body; 403 when a per-tenant key's repo doesn't match its own installation
 * (SIG-494); 500 only on an unexpected engine throw.
 */
export async function handleAgentContextRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication).
  //
  // SIG-494: the caller's installationId IS threaded further now — callerOwnsRepo
  // (below, once the body is parsed) reconciles it against the CLAIMED owner/repo's
  // OWN resolved installation before resolveGrounding ever touches retrieval. Before
  // this fix, the two were resolved independently and never compared: any valid
  // per-tenant key could request grounded retrieval for ANY indexed repo on the
  // platform (cross-tenant leak). The legacy global key is exempt by design (see
  // callerOwnsRepo's header) — it stays broad.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "context_endpoint_not_configured" }, 503)
  }
  const auth = await requireApiTenant(request, env)
  if ("response" in auth) return auth.response
  const caller = auth.caller

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

  // SIG-494: fail-closed tenant-scope gate — a real per-tenant key may only ground
  // against the repo(s) its OWN installation owns. Must run BEFORE resolveGrounding
  // so a mismatched/unresolvable repo never reaches retrieval.
  if (!callerOwnsRepo(caller.installationId, parsed.owner, parsed.repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)) {
    return json({ error: "forbidden", detail: "api key is not scoped to this repo" }, 403)
  }

  const { fetchFileContent, repoId, installationId } = await resolveGrounding(env, parsed.owner, parsed.repo)
  // OFF (flag unset/off): repo-scope learnings only — byte-identical to before.
  // ON: also fold in the installation's ORG guardrails, ordered/labeled above repo facts.
  const learnings = await loadContextLearnings(env, {
    repoId,
    installationId,
    orgApply: resolveSurfaceMemoryApplyMode(env) === "on",
  })

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
    //   chunkCount > 0               → grounded (actual code retrieval landed this turn).
    //   installed, but no chunks yet → indexing if no usable index (self-heals), else grounded.
    //   not installed                → not-connected (can't ground; nothing to index).
    //
    // Deliberately NOT `result.context !== null`: `gatherAgentContext` returns a non-null
    // context when the repo has review learnings even with ZERO code chunks (learnings are
    // keyed by repoId, independent of code indexing) — classifying THAT as "grounded" would
    // permanently mask a never-code-indexed repo and self-heal would never fire. `chunkCount`
    // is the actual-code-retrieval signal; mirror the same chunkCount > 0 contract the admin
    // retrieval probe route (`admin-linear-retrieval-probe-route.ts`) already uses.
    let status: ContextStatus
    if (result.telemetry.chunkCount > 0) {
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
