// SIG-304 Phase 2.1 — POST /v1/review (hosted thin-client endpoint, Mode A:
// diff-only / ungrounded). Authenticates a static bearer ($OPENCLAW_SIGILIX_API_KEY),
// runs the review engine SERVER-SIDE (dryRun → nothing posted; OpenRouter key stays
// on the Worker), and returns the DryRunReview JSON verbatim — the same shape the
// CLI renderers already consume, so the hosted client is render-identical to local.
//
// TENANCY (Mode A is UNGROUNDED): the bearer is a single shared secret and the
// caller asserts owner/repo, so index-backed retrieval is DISABLED here (the code
// index + graph bindings are stubbed inert) — a key holder can NOT read another
// repo's indexed private code, and "ungrounded" is literally true (review is
// diff-only). Grounded Mode B (per-tenant GitHub App) lands in SIG-304 Phase 2.4.
//
// RECALL-SAFETY: an engine FAILURE (errored, or a no-verdict bail like a total model
// outage) → HTTP 500, NEVER a 200/empty body — a failed review must never read as a
// clean pass. Only a genuinely-empty review returns 200 null.

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { requireBearerToken } from "./auth-bearer"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { isDryRunEngineFailure } from "@/src/lib/ensemble/app/session"
import { diffReviewClient } from "./api-review-diff-client"

const MAX_DIFF_BYTES = 1_500_000 // reject oversized diffs (cost/abuse guard) → 413

/** Inert read bindings so Mode A can't touch any tenant's indexed code (retrieval +
 *  graph return nothing → genuinely diff-only). Mirrors the CLI's createLocalEnv stub. */
function ungroundedEnv(env: Env): Env {
  const emptyIndex = {
    query: async () => ({ matches: [] }),
    insert: async () => undefined,
    upsert: async () => undefined,
  } as unknown as Env["OPENCLAW_CODE_INDEX"]
  const noopDo = {
    idFromName: (n: string) => ({ toString: () => n, equals: () => false }),
    idFromString: (s: string) => ({ toString: () => s, equals: () => false }),
    newUniqueId: () => ({ toString: () => "local", equals: () => false }),
    get: () =>
      new Proxy(
        {},
        {
          get: (_t, p) => (p === "fetch" ? async () => new Response(null, { status: 200 }) : async () => undefined),
        },
      ),
  } as unknown as Env["REPO_GRAPH_DO"]
  return { ...env, OPENCLAW_CODE_INDEX: emptyIndex, REPO_GRAPH_DO: noopDo }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface ReviewApiBody {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha?: string
  diff: string
}

/** Validate the request body shape; return the typed body or an error string. */
function parseBody(raw: unknown): ReviewApiBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.owner !== "string" || b.owner === "") return "owner (string) is required"
  if (typeof b.repo !== "string" || b.repo === "") return "repo (string) is required"
  if (typeof b.prNumber !== "number" || !Number.isInteger(b.prNumber)) return "prNumber (integer) is required"
  if (typeof b.headSha !== "string" || b.headSha === "") return "headSha (string) is required"
  if (typeof b.diff !== "string" || b.diff === "") return "diff (non-empty string) is required for Mode A"
  if (b.baseSha !== undefined && typeof b.baseSha !== "string") return "baseSha must be a string"
  return {
    owner: b.owner,
    repo: b.repo,
    prNumber: b.prNumber,
    headSha: b.headSha,
    diff: b.diff,
    ...(typeof b.baseSha === "string" ? { baseSha: b.baseSha } : {}),
  }
}

/**
 * POST /v1/review (Mode A). Auth is checked from the header BEFORE the body is read
 * so an unauthenticated caller can't force a large body buffer.
 */
export async function handleReviewApiRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_SIGILIX_API_KEY
  if (!token) return json({ error: "review_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)
  if (parsed.diff.length > MAX_DIFF_BYTES) {
    return json({ error: "diff_too_large", detail: `diff exceeds ${MAX_DIFF_BYTES} bytes` }, 413)
  }

  const client = diffReviewClient(parsed) as unknown as GitHubClient
  let result
  try {
    result = await handlePrReviewEnsemble({
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
      installationId: 0, // unused: the injected client bypasses buildClient
      env: ungroundedEnv(env), // Mode A: no index/graph retrieval (tenant-safe + ungrounded)
      githubClient: client,
      dryRun: true,
      forceFullCoverage: true, // single-shot: avoid the SIG-459 empty-delta skip
    })
  } catch (err) {
    // The orchestrator normally catches internally and returns status "errored";
    // a thrown error is still an engine failure → 500, never a clean pass.
    return json({ error: "review_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }

  // RECALL-SAFETY: an engine failure (errored OR a no-verdict bail like a total model
  // outage) → 500, never a 200/empty clean pass.
  if (isDryRunEngineFailure(result)) {
    const tel = result.telemetry as { internalError?: string; fellBackReason?: string }
    return json({ error: "review_failed", detail: tel.internalError ?? tel.fellBackReason ?? "engine error" }, 500)
  }
  // 200 with the DryRunReview verbatim; `null` body = nothing to review (skipped).
  return json(result.dryRunReview ?? null, 200)
}
