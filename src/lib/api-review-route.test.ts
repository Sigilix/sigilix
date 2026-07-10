// SIG-304 Phase 2.1 — POST /v1/review (Mode A) route: auth gating, request
// validation, recall-safe status mapping, and the unified-diff parser. The engine
// is mocked (the real engine path is covered by the live CLI + e2e suites).

import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))
// Mode B builds the real GitHub client in-route (to resolve headSha) — mock it so the
// grounded tests don't need real GitHub App creds. getPullRequest returns a fixed head.
vi.mock("@/src/lib/ensemble/adapters/review-sink", () => ({
  buildClient: vi.fn(async () => ({
    getPullRequest: vi.fn(async () => ({ head: { sha: "server-resolved-sha" }, base: { sha: "base" } })),
  })),
}))

import { handleReviewApiRoute } from "./api-review-route"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import type { Env } from "@/src/shared/types/env"

const mockEngine = vi.mocked(handlePrReviewEnsemble)
const mockBuildClient = vi.mocked(buildClient)
const TOKEN = "test-secret-key"
const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(12))
const env = (key?: string, extra: Partial<Env> = {}): Env =>
  ({ OPENCLAW_SIGILIX_API_KEY: key, ...extra }) as unknown as Env
const MIGRATION_SQL_API_KEY = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
/** Throws on any operation — simulates a genuine D1 outage/fault. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}
/** A grounded-ready env: GitHub App configured + an installation map for o/r → 42. */
const groundedEnv = (extra: Partial<Env> = {}): Env =>
  env(TOKEN, {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "pk",
    OPENCLAW_GITHUB_INSTALLATION_MAP: '{"o/r":"42"}',
    ...extra,
  })
/** Minimal KVNamespace mock for the daily-ceiling counter. */
function kvMock(getVal: string | null = null): Env["OPENCLAW_STATE"] {
  return {
    get: vi.fn(async () => getVal),
    put: vi.fn(async () => undefined),
  } as unknown as Env["OPENCLAW_STATE"]
}

function sessionKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  } as unknown as KVNamespace
}

async function portalReviewEnv(
  options: {
    provider?: "github" | "google"
    accessToken?: string
    map?: string
  } = {},
): Promise<{ env: Env; sessionId: string }> {
  const kv = sessionKv()
  const sessionId = "portal-review-session"
  const provider = options.provider ?? "github"
  await createSession({
    kv,
    sessionId,
    login: "octocat",
    ...(provider === "github" ? { githubUserId: 123 } : {}),
    provider,
    accessToken: options.accessToken ?? (provider === "github" ? "ghu_portal" : ""),
    encryptionKeyB64url: ENC_KEY,
  })
  return {
    sessionId,
    env: env(undefined, {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pk",
      OPENCLAW_GITHUB_INSTALLATION_MAP: options.map ?? '{"o/r":"42"}',
    }),
  }
}

function portalReq(
  body: unknown,
  sessionId: string,
  options: { contentType?: string; authorization?: string } = {},
): Request {
  const headers = new Headers({
    cookie: `${SESSION_COOKIE}=${sessionId}`,
    "content-type": options.contentType ?? "application/json",
  })
  if (options.authorization !== undefined) headers.set("authorization", options.authorization)
  return new Request("https://api.sigilix.ai/v1/review", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function stubGithubRepoScope(
  repos: Array<{ installationId: number; fullName: string }> = [{ installationId: 42, fullName: "o/r" }],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        const ids = [...new Set(repos.map((repo) => repo.installationId))]
        return new Response(JSON.stringify({ installations: ids.map((id) => ({ id })) }), { status: 200 })
      }
      const match = url.match(/\/user\/installations\/(\d+)\/repositories\?/)
      if (match) {
        const installationId = Number(match[1])
        return new Response(
          JSON.stringify({
            repositories: repos
              .filter((repo) => repo.installationId === installationId)
              .map((repo) => ({ full_name: repo.fullName })),
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const x=1\n+const x=2\n"
const okReview = { verdict: { summary: "s", confidence: 4, findings: [] }, unanchoredFindings: [] }
const okResult = { status: "skipped", dryRunReview: okReview, telemetry: {} } as never

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
const validBody = { owner: "o", repo: "r", prNumber: 1, headSha: "abc123", diff: DIFF }
/** Noop ExecutionContext stub — ctx.waitUntil is a no-op spy for these tests. */
const noopCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext

beforeEach(() => {
  mockEngine.mockReset()
  mockBuildClient.mockReset()
  mockBuildClient.mockResolvedValue({
    getPullRequest: vi.fn(async () => ({ head: { sha: "server-resolved-sha" }, base: { sha: "base" } })),
  } as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleReviewApiRoute — auth + validation", () => {
  it("503 when the API key is unset (endpoint inert)", async () => {
    const res = await handleReviewApiRoute(req(validBody), env(undefined), noopCtx)
    expect(res.status).toBe(503)
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("401 when the bearer is missing", async () => {
    expect((await handleReviewApiRoute(req(validBody, null), env(TOKEN), noopCtx)).status).toBe(401)
  })
  it("401 when the bearer is wrong", async () => {
    expect((await handleReviewApiRoute(req(validBody, "nope"), env(TOKEN), noopCtx)).status).toBe(401)
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("400 on invalid JSON", async () => {
    expect((await handleReviewApiRoute(req("{not json", TOKEN), env(TOKEN), noopCtx)).status).toBe(400)
  })
  it("400 on a missing required field", async () => {
    const { diff: _omit, ...noDiff } = validBody
    expect((await handleReviewApiRoute(req(noDiff), env(TOKEN), noopCtx)).status).toBe(400)
  })
  it("413 on an oversized diff", async () => {
    const huge = { ...validBody, diff: "x".repeat(1_500_001) }
    expect((await handleReviewApiRoute(req(huge), env(TOKEN), noopCtx)).status).toBe(413)
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("413 payload_too_large when the whole BODY exceeds the cap (before parse, no engine)", async () => {
    // The body cap is enforced as the stream is read, BEFORE JSON.parse — so an
    // oversized envelope is rejected with payload_too_large (not diff_too_large).
    const huge = { ...validBody, diff: "x".repeat(3_100_000) }
    const res = await handleReviewApiRoute(req(huge), env(TOKEN), noopCtx)
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error?: string }).error).toBe("payload_too_large")
    expect(mockEngine).not.toHaveBeenCalled()
  })

  // #155 slice 2: the route now authenticates via resolveApiKey (D1 api_key lookup,
  // falling back to the legacy global key). These pin the new invariants at the
  // route level (resolveApiKey's own unit suite covers the resolver exhaustively).
  it("200 with a valid per-tenant api_key — NO global key configured at all", async () => {
    mockEngine.mockResolvedValue(okResult)
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = "sigilix_live_review_test"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const res = await handleReviewApiRoute(
      req(validBody, plaintext),
      env(undefined, { SIGILIX_PLATFORM_DB: db }),
      noopCtx,
    )
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })
  it("401 on a genuine D1 fault — fails CLOSED even though the presented bearer is the valid global key", async () => {
    const res = await handleReviewApiRoute(
      req(validBody, TOKEN),
      env(TOKEN, { SIGILIX_PLATFORM_DB: makeBrokenDb() }),
      noopCtx,
    )
    expect(res.status).toBe(401)
    expect(mockEngine).not.toHaveBeenCalled()
  })
})

describe("handleReviewApiRoute — portal session auth", () => {
  const groundedBody = {
    mode: "grounded",
    installationId: 42,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "abc123",
  }

  it("runs a grounded review for the exact repo in the signed-in GitHub user's live scope", async () => {
    mockEngine.mockResolvedValue(okResult)
    const portal = await portalReviewEnv()
    stubGithubRepoScope()

    const res = await handleReviewApiRoute(portalReq(groundedBody, portal.sessionId), portal.env, noopCtx)

    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", installationId: 42, dryRun: true }),
    )
  })

  it("requires application/json before reading a cookie-authenticated body", async () => {
    const portal = await portalReviewEnv()
    const res = await handleReviewApiRoute(
      portalReq(groundedBody, portal.sessionId, { contentType: "text/plain" }),
      portal.env,
      noopCtx,
    )

    expect(res.status).toBe(415)
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("rejects diff mode for cookie auth", async () => {
    const portal = await portalReviewEnv()
    const res = await handleReviewApiRoute(
      portalReq({ ...validBody, installationId: 42 }, portal.sessionId),
      portal.env,
      noopCtx,
    )

    expect(res.status).toBe(400)
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a missing or invalid installationId (%s)",
    async (installationId) => {
      const portal = await portalReviewEnv()
      const body = { ...groundedBody, installationId }
      const res = await handleReviewApiRoute(portalReq(body, portal.sessionId), portal.env, noopCtx)

      expect(res.status).toBe(400)
      expect(mockBuildClient).not.toHaveBeenCalled()
      expect(mockEngine).not.toHaveBeenCalled()
    },
  )

  it("fails closed when the trusted repo map resolves to a different installation", async () => {
    const portal = await portalReviewEnv({ map: '{"o/r":"99"}' })
    stubGithubRepoScope()
    const res = await handleReviewApiRoute(portalReq(groundedBody, portal.sessionId), portal.env, noopCtx)

    expect(res.status).toBe(403)
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("denies another selected repo inside an otherwise visible installation", async () => {
    const portal = await portalReviewEnv({ map: '{"o/r":"42","o/secret":"42"}' })
    stubGithubRepoScope([{ installationId: 42, fullName: "o/r" }])
    const res = await handleReviewApiRoute(
      portalReq({ ...groundedBody, repo: "secret" }, portal.sessionId),
      portal.env,
      noopCtx,
    )

    expect(res.status).toBe(403)
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("denies an exact repo tuple under a different installation", async () => {
    const portal = await portalReviewEnv({ map: '{"o/r":"43"}' })
    stubGithubRepoScope([{ installationId: 42, fullName: "o/r" }])
    const res = await handleReviewApiRoute(
      portalReq({ ...groundedBody, installationId: 43 }, portal.sessionId),
      portal.env,
      noopCtx,
    )

    expect(res.status).toBe(403)
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("returns 502 when the live GitHub repo-scope lookup fails", async () => {
    const portal = await portalReviewEnv()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("github down"))),
    )
    const res = await handleReviewApiRoute(portalReq(groundedBody, portal.sessionId), portal.env, noopCtx)

    expect(res.status).toBe(502)
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("matches the live GitHub repo tuple case-insensitively", async () => {
    mockEngine.mockResolvedValue(okResult)
    const portal = await portalReviewEnv({ map: '{"O/R":"42"}' })
    stubGithubRepoScope([{ installationId: 42, fullName: "o/r" }])
    const res = await handleReviewApiRoute(
      portalReq({ ...groundedBody, owner: "O", repo: "R" }, portal.sessionId),
      portal.env,
      noopCtx,
    )

    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("rejects a non-GitHub session before any repo lookup", async () => {
    const portal = await portalReviewEnv({ provider: "google" })
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await handleReviewApiRoute(portalReq(groundedBody, portal.sessionId), portal.env, noopCtx)

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("returns 503 when cookie auth cannot decrypt a GitHub token", async () => {
    const portal = await portalReviewEnv()
    delete portal.env.OPENCLAW_SESSION_ENCRYPTION_KEY
    const res = await handleReviewApiRoute(portalReq(groundedBody, portal.sessionId), portal.env, noopCtx)

    expect(res.status).toBe(503)
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it.each(["", "Basic abc", "Bearer", "Bearer wrong"])(
    "a present Authorization header (%j) never falls through to the valid cookie",
    async (authorization) => {
      const portal = await portalReviewEnv()
      portal.env.OPENCLAW_SIGILIX_API_KEY = TOKEN
      stubGithubRepoScope()
      const res = await handleReviewApiRoute(
        portalReq(groundedBody, portal.sessionId, { authorization }),
        portal.env,
        noopCtx,
      )

      expect(res.status).toBe(401)
      expect(mockBuildClient).not.toHaveBeenCalled()
      expect(mockEngine).not.toHaveBeenCalled()
    },
  )

  it("preserves Mode A bearer behavior when a valid cookie is also present", async () => {
    mockEngine.mockResolvedValue(okResult)
    const portal = await portalReviewEnv()
    portal.env.OPENCLAW_SIGILIX_API_KEY = TOKEN
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await handleReviewApiRoute(
      portalReq(validBody, portal.sessionId, { authorization: `Bearer ${TOKEN}` }),
      portal.env,
      noopCtx,
    )

    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("handleReviewApiRoute — engine status mapping (recall-safety)", () => {
  it("RECALL-SAFETY: an errored engine run → 500, NOT a 200/empty clean pass", async () => {
    mockEngine.mockResolvedValue({ status: "errored", telemetry: { internalError: "model 500" } } as never)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN), noopCtx)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/model 500/)
  })
  it("200 with the DryRunReview verbatim on success", async () => {
    const review = { verdict: { summary: "s", confidence: 4, findings: [] }, unanchoredFindings: [] }
    mockEngine.mockResolvedValue({ status: "skipped", dryRunReview: review, telemetry: {} } as never)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN), noopCtx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(review)
    // injected dry-run client + forceFullCoverage, never posts
    expect(mockEngine).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, forceFullCoverage: true, githubClient: expect.anything() }),
    )
  })
  it("RECALL-SAFETY: a no-verdict bail (total model outage) → 500, NOT 200 null", async () => {
    mockEngine.mockResolvedValue({
      status: "skipped",
      telemetry: { fellBackReason: "specialists_all_failed" },
    } as never)
    expect((await handleReviewApiRoute(req(validBody), env(TOKEN), noopCtx)).status).toBe(500)
  })
  it("200 null when the engine genuinely had nothing to review (no failure reason)", async () => {
    mockEngine.mockResolvedValue({ status: "skipped", telemetry: {} } as never)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN), noopCtx)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })
  // Regression for the recall-safety hole the reviewers caught: these no-verdict bail
  // reasons used to be missing from NO_VERDICT_FAILURES → a failed synth read as 200/null.
  it.each(["synth_failed_parse", "synth_invalid_provenance", "cost_governor_trimmed_all_routable"])(
    "RECALL-SAFETY: a no-verdict bail (%s) → 500, NOT a 200/null clean pass",
    async (fellBackReason) => {
      mockEngine.mockResolvedValue({ status: "skipped", telemetry: { fellBackReason } } as never)
      expect((await handleReviewApiRoute(req(validBody), env(TOKEN), noopCtx)).status).toBe(500)
    },
  )
})

describe("handleReviewApiRoute — Mode B (grounded)", () => {
  const groundedBody = { mode: "grounded", owner: "o", repo: "r", prNumber: 1, headSha: "abc123" }

  it("400 on an unknown mode value", async () => {
    const res = await handleReviewApiRoute(req({ ...validBody, mode: "wat" }), env(TOKEN), noopCtx)
    expect(res.status).toBe(400)
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("grounded does NOT require a diff (no 400)", async () => {
    mockEngine.mockResolvedValue(okResult)
    expect((await handleReviewApiRoute(req(groundedBody), groundedEnv(), noopCtx)).status).toBe(200)
  })
  it("503 grounded_not_configured when the GitHub App secrets are unset", async () => {
    const res = await handleReviewApiRoute(req(groundedBody), env(TOKEN), noopCtx) // no APP_ID/PRIVATE_KEY
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error?: string }).error).toBe("grounded_not_configured")
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("422 app_not_installed when the repo isn't in the installation map", async () => {
    const e = groundedEnv({ OPENCLAW_GITHUB_INSTALLATION_MAP: '{"other/repo":"9"}' })
    const res = await handleReviewApiRoute(req(groundedBody), e, noopCtx)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error?: string }).error).toBe("app_not_installed")
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("grounded runs the engine with the RESOLVED installation, the REAL grounded env, and the in-route client", async () => {
    mockEngine.mockResolvedValue(okResult)
    const e = groundedEnv()
    const res = await handleReviewApiRoute(req(groundedBody), e, noopCtx)
    expect(res.status).toBe(200)
    const callArgs = mockEngine.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs.installationId).toBe(42) // resolved from the map
    expect(callArgs.githubClient).toBeDefined() // built in-route (to resolve headSha) and injected
    expect(callArgs.headSha).toBe("abc123") // the client-provided headSha is honored
    expect(callArgs.repoId).toBeUndefined() // no repoId → no review-memory / learnings writes
    expect(callArgs.dryRun).toBe(true) // a CLI review never posts
    expect(callArgs.forceFullCoverage).toBe(true)
    const passedEnv = callArgs.env as Record<string, unknown>
    expect(passedEnv.GITHUB_APP_ID).toBe("1") // REAL env passthrough (not a fresh stub)
    expect(passedEnv.OPENCLAW_CODE_INDEX).toBeUndefined() // NOT the ungrounded clone → grounded retrieval is live
    expect(passedEnv.OPENCLAW_REVIEW_MEMORY_ENABLED).toBe("off") // review-memory disabled → no compute-path write
  })
  it("resolves headSha from the PR when the client omits it (hosted, no token)", async () => {
    mockEngine.mockResolvedValue(okResult)
    const { headSha: _omit, ...noHead } = groundedBody
    const res = await handleReviewApiRoute(req(noHead), groundedEnv(), noopCtx)
    expect(res.status).toBe(200)
    const callArgs = mockEngine.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs.headSha).toBe("server-resolved-sha") // fetched via the App
    expect(callArgs.githubClient).toBeDefined()
  })
  it("502 pr_unavailable when the App can't read the PR (bad creds / 404 / GitHub down)", async () => {
    mockBuildClient.mockResolvedValue({
      getPullRequest: vi.fn(async () => {
        throw new Error("Not Found")
      }),
    } as never)
    const { headSha: _omit, ...noHead } = groundedBody
    const res = await handleReviewApiRoute(req(noHead), groundedEnv(), noopCtx)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error?: string }).error).toBe("pr_unavailable")
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("RECALL-SAFETY: a grounded errored run → 500, never a clean pass", async () => {
    mockEngine.mockResolvedValue({ status: "errored", telemetry: { internalError: "boom" } } as never)
    expect((await handleReviewApiRoute(req(groundedBody), groundedEnv(), noopCtx)).status).toBe(500)
  })
})

// SIG-494: Mode B used to be able to run a GROUNDED review against ANY indexed repo
// with any valid key (the resolved caller installationId was discarded; `lookup` was
// resolved independently from the body-claimed owner/repo and never reconciled).
// These pin the fix.
describe("handleReviewApiRoute — SIG-494 tenant-scope reconciliation (Mode B)", () => {
  const groundedBody = { mode: "grounded", owner: "o", repo: "r", prNumber: 1, headSha: "abc123" }

  async function keyedGroundedEnv(installationId: number, mapJson: string): Promise<Env> {
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = `sigilix_live_review_${installationId}`
    await insertApiKey(db, {
      id: `key-${installationId}`,
      keyHash: await sha256Hex(plaintext),
      installationId,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    return env(undefined, {
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pk",
      OPENCLAW_GITHUB_INSTALLATION_MAP: mapJson,
      SIGILIX_PLATFORM_DB: db,
    }) as Env
  }
  function tokenFor(installationId: number): string {
    return `sigilix_live_review_${installationId}`
  }

  it("200 — a per-tenant key whose installation OWNS the requested repo", async () => {
    mockEngine.mockResolvedValue(okResult)
    const e = await keyedGroundedEnv(42, '{"o/r":"42"}')
    const res = await handleReviewApiRoute(req(groundedBody, tokenFor(42)), e, noopCtx)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("403 — a per-tenant key requesting a repo in a DIFFERENT installation (the core leak, proven closed)", async () => {
    const e = await keyedGroundedEnv(42, '{"o/r":"999"}') // o/r belongs to a DIFFERENT tenant's installation
    const res = await handleReviewApiRoute(req(groundedBody, tokenFor(42)), e, noopCtx)
    expect(res.status).toBe(403)
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("200 (unchanged, still broad) — the legacy global key is exempt from the per-repo gate", async () => {
    mockEngine.mockResolvedValue(okResult)
    const e = groundedEnv() // legacy TOKEN, OPENCLAW_GITHUB_INSTALLATION_MAP: '{"o/r":"42"}'
    const res = await handleReviewApiRoute(req(groundedBody), e, noopCtx)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("Mode A is unaffected — a per-tenant key's OWN diff review still runs without any repo reconciliation", async () => {
    // Mode A is genuinely ungrounded (no tenant's indexed code is ever touched), so the
    // SIG-494 gate intentionally does not apply to it — this pins that it still works.
    mockEngine.mockResolvedValue(okResult)
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = "sigilix_live_review_diffmode"
    await insertApiKey(db, {
      id: "key-diffmode",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const res = await handleReviewApiRoute(
      req(validBody, plaintext),
      env(undefined, { SIGILIX_PLATFORM_DB: db }),
      noopCtx,
    )
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })
})

describe("handleReviewApiRoute — daily ceiling (cost guard)", () => {
  it("429 once the day's counter has reached the limit (engine not called)", async () => {
    const e = env(TOKEN, { OPENCLAW_STATE: kvMock("200") }) // default limit is 200
    const res = await handleReviewApiRoute(req(validBody), e, noopCtx)
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error?: string }).error).toBe("daily_limit_exceeded")
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("admits and increments the counter when under the limit", async () => {
    mockEngine.mockResolvedValue(okResult)
    const kv = kvMock(null)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN, { OPENCLAW_STATE: kv }), noopCtx)
    expect(res.status).toBe(200)
    expect(kv.put).toHaveBeenCalledWith(expect.stringMatching(/^v1review:count:/), "1", expect.anything())
  })
  it("respects a custom OPENCLAW_SIGILIX_API_DAILY_LIMIT", async () => {
    const e = env(TOKEN, { OPENCLAW_STATE: kvMock("5"), OPENCLAW_SIGILIX_API_DAILY_LIMIT: "5" })
    expect((await handleReviewApiRoute(req(validBody), e, noopCtx)).status).toBe(429)
  })
  it("is best-effort: a KV failure never blocks the review", async () => {
    mockEngine.mockResolvedValue(okResult)
    const throwingKv = {
      get: vi.fn(async () => {
        throw new Error("kv down")
      }),
      put: vi.fn(),
    } as unknown as Env["OPENCLAW_STATE"]
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN, { OPENCLAW_STATE: throwingKv }), noopCtx)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })
  it("a validation rejection (422) does NOT consume the day's budget", async () => {
    const kv = kvMock(null)
    const e = groundedEnv({ OPENCLAW_GITHUB_INSTALLATION_MAP: "{}", OPENCLAW_STATE: kv })
    expect(
      (
        await handleReviewApiRoute(
          req({ mode: "grounded", owner: "o", repo: "r", prNumber: 1, headSha: "s" }),
          e,
          noopCtx,
        )
      ).status,
    ).toBe(422)
    expect(kv.put).not.toHaveBeenCalled()
  })
})
