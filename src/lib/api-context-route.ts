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

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { gatherAgentContext } from "./agent-context"

// Queries are short (a turn's intent), so the body is tiny — cap well below the diff routes.
const MAX_BODY_BYTES = 64 * 1024

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

/**
 * Resolve a best-effort file fetcher (for graph symbol-body expansion) via the GitHub App,
 * pinned to the repo's default-branch HEAD. Returns a null-fetcher (index-only grounding)
 * when the App is unconfigured / not installed / unavailable — never throws.
 */
async function resolveFileFetcher(
  env: Env,
  owner: string,
  repo: string,
): Promise<(path: string) => Promise<string | null>> {
  const nullFetcher = async (): Promise<string | null> => null
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return nullFetcher
  const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  if (!lookup.ok) return nullFetcher
  try {
    const client = await buildClient(env, lookup.installationId)
    const repoMeta = await client.getRepository(owner, repo)
    const defaultBranch = repoMeta?.default_branch ?? "main"
    const branch = await client.getBranch(owner, repo, defaultBranch).catch(() => null)
    const ref = branch?.headSha ?? defaultBranch
    return (path: string) => client.getFileContent(owner, repo, path, ref)
  } catch {
    return nullFetcher
  }
}

/**
 * POST /v1/context — see file header. Returns { context, telemetry }; `context` is null when
 * nothing could be grounded (the agent then proceeds blind). 503 until keyed; 401 on bad
 * bearer; 400/413 on a bad/oversized body; 500 only on an unexpected engine throw.
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

  const fetchFileContent = await resolveFileFetcher(env, parsed.owner, parsed.repo)

  try {
    const result = await gatherAgentContext({
      owner: parsed.owner,
      repo: parsed.repo,
      query: parsed.query,
      env,
      fetchFileContent,
      ...(parsed.maxBytes !== undefined ? { maxBytes: parsed.maxBytes } : {}),
      ...(parsed.maxContextChars !== undefined ? { maxContextChars: parsed.maxContextChars } : {}),
    })
    return json({ context: result.context, telemetry: result.telemetry }, 200)
  } catch (err) {
    return json({ error: "context_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }
}
