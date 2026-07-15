// SIG-494 — POST /v1/context route: auth gating, validation, body cap, the honest
// null-grounding case (200, not an error), 500 only on an unexpected throw, and the
// graceful App-configured vs index-only-degrade fetcher resolution. gatherAgentContext +
// the GitHub App seams are mocked (their own suites cover them).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"

vi.mock("./agent-context", () => ({ gatherAgentContext: vi.fn() }))
vi.mock("@/src/shared/adapters/github/github-installation", () => ({ resolveInstallation: vi.fn() }))
vi.mock("@/src/lib/ensemble/adapters/review-sink", () => ({ buildClient: vi.fn() }))
// Keep the real learnings barrel (so resolveAppliedMemoryProvenance / buildMemoryProvenance
// run for real), stubbing ONLY the KV load + the org-apply gate the route depends on.
vi.mock("@/src/features/learnings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/learnings")>()
  return {
    ...actual,
    loadLearnings: vi.fn(),
    resolveSurfaceMemoryApplyMode: vi.fn(() => "off"),
  }
})
// #146: self-heal seams. `indexNamespace` is pure — keep the real impl so the marker key is real.
vi.mock("./index-producer", () => ({ enqueueIndexJobsForRepos: vi.fn(), isIndexerEnabled: vi.fn() }))
vi.mock("./repo-index-manifest", () => ({
  readRepoIndexManifest: vi.fn(),
  indexNamespace: (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`,
}))

import { handleAgentContextRoute } from "./api-context-route"
import { gatherAgentContext } from "./agent-context"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { loadLearnings, resolveSurfaceMemoryApplyMode } from "@/src/features/learnings"
import { enqueueIndexJobsForRepos, isIndexerEnabled } from "./index-producer"
import { readRepoIndexManifest } from "./repo-index-manifest"
import type { Env } from "@/src/shared/types/env"

const mockGather = vi.mocked(gatherAgentContext)
const mockResolve = vi.mocked(resolveInstallation)
const mockBuild = vi.mocked(buildClient)
const mockLoadLearnings = vi.mocked(loadLearnings)
const mockEnqueue = vi.mocked(enqueueIndexJobsForRepos)
const mockIndexerEnabled = vi.mocked(isIndexerEnabled)
const mockReadManifest = vi.mocked(readRepoIndexManifest)
const mockSurfaceMode = vi.mocked(resolveSurfaceMemoryApplyMode)
const TOKEN = "ctx-secret"
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

/** A minimal in-memory KV so the storm-guard marker get/put behave like real KV. */
function makeKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
  } as unknown as KVNamespace
}

const env = (key?: string, extra: Partial<Env> = {}): Env =>
  ({ OPENCLAW_SIGILIX_API_KEY: key, ...extra }) as unknown as Env
const appEnv = (extra: Partial<Env> = {}): Env =>
  env(TOKEN, {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "pk",
    OPENCLAW_GITHUB_INSTALLATION_MAP: '{"o/r":"42"}',
    ...extra,
  })

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/context", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
const validBody = { owner: "o", repo: "r", query: "where is auth" }
const okResult = {
  context: "GROUNDED",
  telemetry: {
    namespace: "o/r",
    chunkCount: 3,
    graphAvailable: true,
    symbolsExpanded: 2,
    callersRendered: 1,
    superseded: 1,
    contextChars: 8,
  },
}

let getFileContentMock: ReturnType<typeof vi.fn>

function mockClient(getBranch: () => Promise<{ headSha: string; treeSha: string } | null>) {
  mockBuild.mockResolvedValue({
    getRepository: vi.fn(async () => ({ default_branch: "main", id: 1 })),
    getBranch: vi.fn(getBranch),
    getFileContent: getFileContentMock,
  } as never)
}

/** Pull the fetcher the route handed to gatherAgentContext (gather is mocked, so the
 *  closure is never invoked unless we call it ourselves). */
function capturedFetcher(): (path: string) => Promise<string | null> {
  return (mockGather.mock.calls[0]?.[0] as { fetchFileContent: (p: string) => Promise<string | null> }).fetchFileContent
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolve.mockReturnValue({ ok: true, installationId: 42 } as never)
  getFileContentMock = vi.fn(async () => "file")
  mockClient(async () => ({ headSha: "abc", treeSha: "t" }))
  mockGather.mockResolvedValue(okResult as never)
  mockLoadLearnings.mockResolvedValue(null) // default: no learnings
  mockSurfaceMode.mockReturnValue("off") // default: surface-memory-apply OFF (repo-only)
  // #146 self-heal defaults: indexer on, no manifest yet, enqueue succeeds.
  mockIndexerEnabled.mockReturnValue(true)
  mockReadManifest.mockResolvedValue({ kind: "missing" } as never)
  mockEnqueue.mockResolvedValue({ attempted: 1, succeeded: 1, perRepoFailed: 0, sensitiveSkipped: 0 } as never)
})

describe("handleAgentContextRoute — auth + validation", () => {
  it("503 when the key is unset (inert)", async () => {
    expect((await handleAgentContextRoute(req(validBody), env(undefined))).status).toBe(503)
    expect(mockGather).not.toHaveBeenCalled()
  })
  it("401 on a bad bearer", async () => {
    expect((await handleAgentContextRoute(req(validBody, "nope"), env(TOKEN))).status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await handleAgentContextRoute(req("{nope", TOKEN), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing query", async () => {
    const { query: _q, ...noQuery } = validBody
    expect((await handleAgentContextRoute(req(noQuery), env(TOKEN))).status).toBe(400)
  })
  it("413 on an oversized body (before grounding)", async () => {
    const huge = { ...validBody, query: "x".repeat(70_000) }
    const res = await handleAgentContextRoute(req(huge), env(TOKEN))
    expect(res.status).toBe(413)
    expect(mockGather).not.toHaveBeenCalled()
  })

  // #155 slice 2: the route now authenticates via resolveApiKey (D1 api_key lookup,
  // falling back to the legacy global key). These pin the new invariants at the
  // route level (resolveApiKey's own unit suite covers the resolver exhaustively).
  it("200 with a valid per-tenant api_key — NO global key configured at all", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = "sigilix_live_ctx_test"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const res = await handleAgentContextRoute(
      req(validBody, plaintext),
      env(undefined, { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "pk", SIGILIX_PLATFORM_DB: db }),
    )
    expect(res.status).toBe(200)
  })
  it("401 on a genuine D1 fault — fails CLOSED even though the presented bearer is the valid global key", async () => {
    const res = await handleAgentContextRoute(
      req(validBody, TOKEN),
      env(TOKEN, { SIGILIX_PLATFORM_DB: makeBrokenDb() }),
    )
    expect(res.status).toBe(401)
    expect(mockGather).not.toHaveBeenCalled()
  })
})

// SIG-494: any valid key used to be able to request grounded retrieval for ANY indexed
// repo (the resolved caller installationId was discarded; resolveGrounding independently
// re-resolved the installation from the body-claimed owner/repo). These pin the fix —
// a per-tenant key is now reconciled against the repo's OWN resolved installation.
describe("handleAgentContextRoute — SIG-494 tenant-scope reconciliation", () => {
  async function keyedEnv(installationId: number, extra: Partial<Env> = {}): Promise<Env> {
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = `sigilix_live_ctx_${installationId}`
    await insertApiKey(db, {
      id: `key-${installationId}`,
      keyHash: await sha256Hex(plaintext),
      installationId,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    return env(undefined, { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "pk", SIGILIX_PLATFORM_DB: db, ...extra }) as Env
  }
  function tokenFor(installationId: number): string {
    return `sigilix_live_ctx_${installationId}`
  }

  it("200 — a per-tenant key whose installation OWNS the requested repo", async () => {
    mockResolve.mockReturnValue({ ok: true, installationId: 42 } as never)
    const res = await handleAgentContextRoute(req(validBody, tokenFor(42)), await keyedEnv(42))
    expect(res.status).toBe(200)
    expect(mockGather).toHaveBeenCalled()
  })

  it("403 — a per-tenant key requesting a repo in a DIFFERENT installation (the core leak, proven closed)", async () => {
    mockResolve.mockReturnValue({ ok: true, installationId: 999 } as never) // o/r belongs to a DIFFERENT tenant
    const res = await handleAgentContextRoute(req(validBody, tokenFor(42)), await keyedEnv(42))
    expect(res.status).toBe(403)
    expect(mockGather).not.toHaveBeenCalled()
  })

  it("403 — fail-closed when the requested repo doesn't resolve to any installation", async () => {
    mockResolve.mockReturnValue({ ok: false } as never)
    const res = await handleAgentContextRoute(req(validBody, tokenFor(42)), await keyedEnv(42))
    expect(res.status).toBe(403)
    expect(mockGather).not.toHaveBeenCalled()
  })

  it("200 (unchanged, still broad) — the legacy global key is exempt from the per-repo gate", async () => {
    mockResolve.mockReturnValue({ ok: true, installationId: 999 } as never) // o/r resolves to a DIFFERENT installation
    const res = await handleAgentContextRoute(req(validBody, TOKEN), appEnv())
    expect(res.status).toBe(200)
    expect(mockGather).toHaveBeenCalled()
  })
})

describe("handleAgentContextRoute — retrieval", () => {
  it("200 with the packed context + telemetry + status:grounded", async () => {
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "grounded", context: "GROUNDED", telemetry: okResult.telemetry })
  })
  it("logs an agent-context-served observability event with the grounding status + chunkCount", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      await handleAgentContextRoute(req(validBody), appEnv())
      const served = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('"event":"agent-context-served"'))
      expect(served).toBeDefined()
      const parsed = JSON.parse(served!)
      expect(parsed).toMatchObject({
        event: "agent-context-served",
        status: "grounded",
        chunkCount: okResult.telemetry.chunkCount,
      })
    } finally {
      logSpy.mockRestore()
    }
  })
  it("200 with null context when nothing grounded (honest, NOT an error)", async () => {
    mockGather.mockResolvedValue({
      context: null,
      telemetry: { ...okResult.telemetry, chunkCount: 0, contextChars: 0 },
    } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(((await res.json()) as { context: unknown }).context).toBeNull()
  })
  it("500 only on an unexpected engine throw", async () => {
    mockGather.mockRejectedValue(new Error("boom"))
    expect((await handleAgentContextRoute(req(validBody), appEnv())).status).toBe(500)
  })
  it("builds the App client + a file fetcher when configured + installed", async () => {
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), 42)
    const call = mockGather.mock.calls[0]?.[0] as { fetchFileContent?: unknown }
    expect(typeof call.fetchFileContent).toBe("function")
  })
  it("the App fetcher reads files at the resolved default-branch HEAD sha", async () => {
    await handleAgentContextRoute(req(validBody), appEnv())
    await capturedFetcher()("src/x.ts")
    expect(getFileContentMock).toHaveBeenCalledWith("o", "r", "src/x.ts", "abc")
  })
  it("falls back to the default-branch NAME as ref when getBranch returns null", async () => {
    mockClient(async () => null)
    await handleAgentContextRoute(req(validBody), appEnv())
    await capturedFetcher()("src/x.ts")
    expect(getFileContentMock).toHaveBeenCalledWith("o", "r", "src/x.ts", "main")
  })
  it("loads the repo's learnings (negative memory) and passes them, most-recent first", async () => {
    mockLoadLearnings.mockResolvedValue({
      schemaVersion: 1,
      scope: "repo",
      subjectId: "1",
      entries: [
        { id: "1", rule: "cents are integers", polarity: "require", createdTs: "2026-06-01" },
        { id: "2", rule: "empty catch in worker.ts is intentional", polarity: "suppress", createdTs: "2026-06-02" },
      ],
    } as never)
    await handleAgentContextRoute(req(validBody), appEnv())
    expect(mockLoadLearnings).toHaveBeenCalledWith(expect.anything(), "repo", "1") // repoId from getRepository
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    expect(call.learnings?.length).toBe(2)
    expect(call.learnings?.[0]).toContain("empty catch in worker.ts is intentional") // newest first
    expect(call.learnings?.[0]).toContain("[dismissed]") // suppress polarity surfaced
  })
  it("does not load learnings when the App can't resolve a repo id (index-only)", async () => {
    await handleAgentContextRoute(req(validBody), env(TOKEN)) // no APP_ID
    expect(mockLoadLearnings).not.toHaveBeenCalled()
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    expect(call.learnings).toBeUndefined()
  })
  it("degrades to index-only (no buildClient) when the App is unconfigured", async () => {
    const res = await handleAgentContextRoute(req(validBody), env(TOKEN)) // no APP_ID / PRIVATE_KEY
    expect(res.status).toBe(200)
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockGather).toHaveBeenCalled()
  })
  it("degrades to index-only when the App is not installed on the repo", async () => {
    mockResolve.mockReturnValue({ ok: false } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockGather).toHaveBeenCalled()
  })
})

// Part 1 (apply-everywhere): when OPENCLAW_SURFACE_MEMORY_APPLY is "on", /v1/context
// grounding folds the installation's ORG guardrails into the repo-scope learnings,
// ordered + labeled ABOVE repo facts. Off (default) stays repo-only, byte-identical.
describe("handleAgentContextRoute — surface-memory-apply (Part 1: CLI org gap)", () => {
  const repoStore = {
    schemaVersion: 1,
    scope: "repo",
    subjectId: "1",
    entries: [{ id: "r1", rule: "cents are integers", polarity: "require", createdTs: "2026-06-01" }],
  }
  const orgStore = {
    schemaVersion: 1,
    scope: "org",
    subjectId: "42",
    entries: [
      {
        id: "o1",
        rule: "all PRs need a design doc",
        polarity: "require",
        type: "durable_preference",
        createdTs: "2026-06-05",
      },
    ],
  }
  function byScope(repo: unknown, org: unknown) {
    return async (_e: unknown, scope: string) => (scope === "repo" ? repo : org) as never
  }

  it("OFF (default) — repo-scope learnings ONLY, the org KV key is never read", async () => {
    mockLoadLearnings.mockImplementation(byScope(repoStore, orgStore))
    await handleAgentContextRoute(req(validBody), appEnv())
    expect(mockLoadLearnings).toHaveBeenCalledWith(expect.anything(), "repo", "1")
    expect(mockLoadLearnings).not.toHaveBeenCalledWith(expect.anything(), "org", expect.anything())
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    expect(call.learnings).toEqual(["[required] cents are integers"]) // repo-only, unchanged
  })

  it("ON — org guardrails are included and labeled ABOVE repo facts", async () => {
    mockSurfaceMode.mockReturnValue("on")
    mockLoadLearnings.mockImplementation(byScope(repoStore, orgStore))
    await handleAgentContextRoute(req(validBody), appEnv())
    expect(mockLoadLearnings).toHaveBeenCalledWith(expect.anything(), "org", "42") // installation id
    expect(mockLoadLearnings).toHaveBeenCalledWith(expect.anything(), "repo", "1")
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    const lines = call.learnings ?? []
    expect(lines[0]).toBe("[org policy — must follow] all PRs need a design doc") // org FIRST + labeled
    // The org guardrail is ordered strictly ABOVE the repo fact.
    expect(lines.indexOf("[org policy — must follow] all PRs need a design doc")).toBeLessThan(
      lines.indexOf("[required] cents are integers"),
    )
  })

  it("ON — a learning mirrored repo→org surfaces ONCE, as the org guardrail (org wins the dedup)", async () => {
    mockSurfaceMode.mockReturnValue("on")
    const shared = {
      id: "shared",
      rule: "no console.log in prod",
      polarity: "require",
      type: "durable_preference",
      createdTs: "2026-06-10",
    }
    mockLoadLearnings.mockImplementation(
      byScope({ ...repoStore, entries: [shared] }, { ...orgStore, entries: [shared] }),
    )
    await handleAgentContextRoute(req(validBody), appEnv())
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    expect(call.learnings).toEqual(["[org policy — must follow] no console.log in prod"]) // once, as org
  })

  it("ON — a non-durable org rule is labeled [org guidance] (not a must-follow policy)", async () => {
    mockSurfaceMode.mockReturnValue("on")
    const orgGuidance = {
      ...orgStore,
      entries: [{ id: "g1", rule: "we use zod for parsing", polarity: "context", createdTs: "2026-06-05" }],
    }
    mockLoadLearnings.mockImplementation(byScope({ ...repoStore, entries: [] }, orgGuidance))
    await handleAgentContextRoute(req(validBody), appEnv())
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    expect(call.learnings).toEqual(["[org guidance] we use zod for parsing"])
  })

  it("ON — the org leg soft-fails (its KV read throws) → degrades to repo-only, never throws", async () => {
    mockSurfaceMode.mockReturnValue("on")
    mockLoadLearnings.mockImplementation(async (_e: unknown, scope: string) => {
      if (scope === "org") throw new Error("org kv down")
      return repoStore as never
    })
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200) // request never breaks on a memory fault
    const call = mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }
    expect(call.learnings).toEqual(["[required] cents are integers"]) // repo facts still surface
  })
})

// SIG memory-provenance: when SIGILIX_MEMORY_PROVENANCE is "on", the response ALSO
// carries a display-only `provenance` note (the #955 MemoryProvenance shape) for the
// org∪repo learnings this turn actually applied. OFF (default) → no field, response
// byte-identical. Display-only: never gates retrieval, never surfaces suppress text.
describe("handleAgentContextRoute — memory provenance (display-only, flag-gated)", () => {
  // Entries carry `scope` (buildMemoryProvenance keys per-scope counts on it).
  const provRepoStore = {
    schemaVersion: 1,
    scope: "repo",
    subjectId: "1",
    entries: [{ id: "r1", rule: "cents are integers", polarity: "require", scope: "repo", createdTs: "2026-06-01" }],
  }
  const provOrgStore = {
    schemaVersion: 1,
    scope: "org",
    subjectId: "42",
    entries: [
      {
        id: "o1",
        rule: "all PRs need a design doc",
        polarity: "require",
        type: "durable_preference",
        scope: "org",
        createdTs: "2026-06-05",
      },
    ],
  }
  function byScope(repo: unknown, org: unknown) {
    return async (_e: unknown, scope: string) => (scope === "repo" ? repo : org) as never
  }

  it("flag ON — response carries #955-shape provenance for the applied org∪repo set", async () => {
    mockSurfaceMode.mockReturnValue("on")
    mockLoadLearnings.mockImplementation(byScope(provRepoStore, provOrgStore))
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_MEMORY_PROVENANCE: "on" }))
    const body = (await res.json()) as {
      status: string
      context: unknown
      telemetry: unknown
      provenance?: {
        total: number
        orgCount: number
        repoCount: number
        suppressCount: number
        items: { id: string }[]
      }
    }
    // The retrieval payload is unchanged by the flag.
    expect(body.status).toBe("grounded")
    expect(body.context).toBe("GROUNDED")
    expect(body.telemetry).toEqual(okResult.telemetry)
    // Provenance describes exactly the applied org guardrail + repo fact.
    expect(body.provenance).toBeDefined()
    expect(body.provenance!.total).toBe(2)
    expect(body.provenance!.orgCount).toBe(1)
    expect(body.provenance!.repoCount).toBe(1)
    expect(body.provenance!.suppressCount).toBe(0)
    expect(body.provenance!.items.map((i) => i.id).sort()).toEqual(["o1", "r1"])
  })

  it("flag OFF (default) — NO provenance field, response byte-identical to before", async () => {
    mockSurfaceMode.mockReturnValue("on")
    mockLoadLearnings.mockImplementation(byScope(provRepoStore, provOrgStore))
    const res = await handleAgentContextRoute(req(validBody), appEnv()) // provenance unset
    const body = (await res.json()) as Record<string, unknown>
    expect("provenance" in body).toBe(false)
    expect(body).toEqual({ status: "grounded", context: "GROUNDED", telemetry: okResult.telemetry })
  })

  it("flag ON but no learnings applied — no provenance field (empty set → no note)", async () => {
    mockSurfaceMode.mockReturnValue("on")
    mockLoadLearnings.mockResolvedValue(null) // nothing to apply
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_MEMORY_PROVENANCE: "on" }))
    const body = (await res.json()) as Record<string, unknown>
    expect("provenance" in body).toBe(false)
  })

  it("RECALL-SAFETY — provenance never changes the applied set and never surfaces suppress text", async () => {
    mockSurfaceMode.mockReturnValue("on")
    const suppressRule = "silence the legacy lint warning"
    const orgWithSuppress = {
      ...provOrgStore,
      entries: [
        provOrgStore.entries[0],
        { id: "sup1", rule: suppressRule, polarity: "suppress", scope: "org", createdTs: "2026-06-06" },
      ],
    }
    mockLoadLearnings.mockImplementation(byScope(provRepoStore, orgWithSuppress))

    // OFF vs ON: the learnings actually injected into the prompt must be identical.
    const off = await handleAgentContextRoute(req(validBody), appEnv())
    const offLearnings = (mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }).learnings
    mockGather.mockClear()
    const on = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_MEMORY_PROVENANCE: "on" }))
    const onLearnings = (mockGather.mock.calls[0]?.[0] as { learnings?: readonly string[] }).learnings

    expect(onLearnings).toEqual(offLearnings) // the flag never reorders/filters the applied set
    const onBody = (await on.json()) as {
      context: unknown
      provenance?: { total: number; orgCount: number; repoCount: number; suppressCount: number }
    }
    const offBody = (await off.json()) as { context: unknown }
    expect(onBody.context).toBe(offBody.context) // the grounded answer is unchanged
    // The suppress rule is counted, but its TEXT never appears anywhere in the payload.
    expect(onBody.provenance!.suppressCount).toBe(1)
    expect(onBody.provenance!.orgCount).toBe(1) // the suppress entry is NOT a guardrail
    expect(onBody.provenance!.repoCount).toBe(1)
    expect(onBody.provenance!.total).toBe(3)
    expect(JSON.stringify(onBody)).not.toContain(suppressRule)
  })
})

describe("handleAgentContextRoute — #146 status + self-heal", () => {
  const nullGather = { context: null, telemetry: { ...okResult.telemetry, chunkCount: 0, contextChars: 0 } }

  async function statusOf(res: Response): Promise<string> {
    return ((await res.json()) as { status: string }).status
  }

  it("status=grounded when chunks are present (chunkCount > 0)", async () => {
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(res.status).toBe(200)
    expect(await statusOf(res)).toBe("grounded")
    expect(mockEnqueue).not.toHaveBeenCalled() // grounded never self-heals
  })

  it("P1: status=indexing (NOT grounded) when context is non-null from learnings alone but chunkCount is 0, and self-heals exactly once", async () => {
    // gatherAgentContext returns a non-null `context` (the learnings block) even with zero
    // code chunks — learnings are keyed by repoId, independent of code indexing. Classifying
    // that as "grounded" would permanently mask a never-code-indexed repo.
    mockGather.mockResolvedValue({
      context: "# Team conventions & past decisions\n- some rule",
      telemetry: { ...okResult.telemetry, chunkCount: 0, contextChars: 42 },
    } as never)
    mockReadManifest.mockResolvedValue({ kind: "missing" } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; context: string | null }
    expect(body.status).toBe("indexing")
    expect(body.context).not.toBeNull() // context payload is unchanged — only `status` differs
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it("status=not-connected when no installation, and does NOT enqueue", async () => {
    mockResolve.mockReturnValue({ ok: false } as never) // App not installed for owner/repo
    mockGather.mockResolvedValue(nullGather as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(res.status).toBe(200)
    expect(await statusOf(res)).toBe("not-connected")
    expect(mockReadManifest).not.toHaveBeenCalled() // never reach the manifest read
    expect(mockEnqueue).not.toHaveBeenCalled() // no App ⇒ nothing to index
  })

  it("status=indexing when installed but no manifest, and enqueues exactly ONE index job", async () => {
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockResolvedValue({ kind: "missing" } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(res.status).toBe(200)
    expect(await statusOf(res)).toBe("indexing")
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 42,
        reason: "on-demand-context-miss",
        repositories: [{ full_name: "o/r", id: 1 }], // repoId from getRepository threaded through
      }),
    )
  })

  it("status=grounded (no enqueue) when installed AND a manifest with chunks already exists", async () => {
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockResolvedValue({ kind: "ok", manifest: { chunkCount: 5 } } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(await statusOf(res)).toBe("grounded") // index exists; the query just matched nothing
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("P1: status=indexing (and self-heals) when the manifest is ok but chunkCount is 0", async () => {
    // A manifest can exist (kind: "ok") from an index run that completed without upserting any
    // chunks (e.g. an empty repo). That manifest is NOT usable for grounding — it must fall
    // through to self-heal, not get stuck reporting "grounded" forever.
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockResolvedValue({ kind: "ok", manifest: { chunkCount: 0 } } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(await statusOf(res)).toBe("indexing")
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it("storm guard: a second call while the marker is fresh does NOT re-enqueue", async () => {
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockResolvedValue({ kind: "missing" } as never)
    const sharedEnv = appEnv({ OPENCLAW_STATE: makeKv() }) // one KV, shared across both calls
    const first = await handleAgentContextRoute(req(validBody), sharedEnv)
    const second = await handleAgentContextRoute(req(validBody), sharedEnv)
    expect(await statusOf(first)).toBe("indexing")
    expect(await statusOf(second)).toBe("indexing")
    expect(mockEnqueue).toHaveBeenCalledTimes(1) // marker set by the first call gates the second
  })

  it("does not enqueue when the indexer flag is off (no consumer)", async () => {
    mockIndexerEnabled.mockReturnValue(false)
    mockGather.mockResolvedValue(nullGather as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(await statusOf(res)).toBe("indexing") // still distinguishable for the CLI
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("P2: soft-fails to status=indexing (does not throw) when the manifest read rejects", async () => {
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockRejectedValue(new Error("KV unavailable"))
    const res = await handleAgentContextRoute(req(validBody), appEnv({ OPENCLAW_STATE: makeKv() }))
    expect(res.status).toBe(200) // never throws into a 500 on a manifest-read blip
    expect(await statusOf(res)).toBe("indexing")
    // Conservative soft-fail: an unreadable manifest is "unknown", not "confirmed unindexed",
    // so the route reports indexing without ALSO attempting an enqueue it can't justify yet.
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("P3: writes the storm-guard marker even when the enqueue was skipped for sensitivity, so a second poll does not re-attempt", async () => {
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockResolvedValue({ kind: "missing" } as never)
    mockEnqueue.mockResolvedValue({ attempted: 1, succeeded: 0, perRepoFailed: 0, sensitiveSkipped: 1 } as never)
    const sharedEnv = appEnv({ OPENCLAW_STATE: makeKv() }) // one KV, shared across both calls
    const first = await handleAgentContextRoute(req(validBody), sharedEnv)
    const second = await handleAgentContextRoute(req(validBody), sharedEnv)
    expect(await statusOf(first)).toBe("indexing")
    expect(await statusOf(second)).toBe("indexing")
    // Without the P3 fix this would be called twice — once per poll, forever, since
    // succeeded stays 0 for every attempt on a sensitive-denylisted repo.
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it("P3 (control): a genuine per-repo enqueue FAILURE does NOT write the marker, so the next poll retries", async () => {
    mockGather.mockResolvedValue(nullGather as never)
    mockReadManifest.mockResolvedValue({ kind: "missing" } as never)
    mockEnqueue.mockResolvedValue({ attempted: 1, succeeded: 0, perRepoFailed: 1, sensitiveSkipped: 0 } as never)
    const sharedEnv = appEnv({ OPENCLAW_STATE: makeKv() })
    const first = await handleAgentContextRoute(req(validBody), sharedEnv)
    const second = await handleAgentContextRoute(req(validBody), sharedEnv)
    expect(await statusOf(first)).toBe("indexing")
    expect(await statusOf(second)).toBe("indexing")
    expect(mockEnqueue).toHaveBeenCalledTimes(2) // no marker written ⇒ retries every poll
  })
})
