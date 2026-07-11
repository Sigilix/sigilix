import { describe, expect, it, vi } from "vitest"
import type { PrReviewMcpRuntimePort } from "@/src/features/pr-review-app-evidence/ports/runtime"
import { collectPrReviewAppEvidence } from "./collect"

const BASE = "b".repeat(40)
const HEAD = "a".repeat(40)

function manifest() {
  return JSON.stringify({
    version: 1,
    evidence: [
      {
        adapter: "vercel-deployment-status",
        serverId: "vercel-grant",
        teamId: "team_1",
        projectId: "prj_1",
      },
      {
        adapter: "supabase-advisors",
        serverId: "supabase-grant",
        projectId: "supabase-ref",
        advisorType: "security",
      },
    ],
  })
}

function runtime(overrides: Partial<PrReviewMcpRuntimePort> = {}): PrReviewMcpRuntimePort {
  return {
    catalog: vi.fn(async () => [
      { serverId: "vercel-grant", vendor: "vercel", name: "list_deployments" },
      { serverId: "supabase-grant", vendor: "supabase", name: "get_advisors" },
    ]),
    invoke: vi.fn(async ({ toolName }) => ({
      content: [
        {
          type: "text" as const,
          text:
            toolName === "list_deployments"
              ? JSON.stringify({ deployments: [{ meta: { githubCommitSha: HEAD }, state: "READY" }] })
              : JSON.stringify({ lints: [{ level: "ERROR" }] }),
        },
      ],
    })),
    ...overrides,
  }
}

describe("collectPrReviewAppEvidence", () => {
  it("makes zero broker calls for an unknown manifest field", async () => {
    const mcp = runtime()
    await expect(
      collectPrReviewAppEvidence({
        client: { getFileContent: async () => manifest().replace('{"version":1', '{"version":1,"prompt":"inject"') },
        runtime: mcp,
        owner: "acme",
        repo: "api",
        baseSha: BASE,
        headSha: HEAD,
      }),
    ).resolves.toEqual([])
    expect(mcp.catalog).not.toHaveBeenCalled()
    expect(mcp.invoke).not.toHaveBeenCalled()
  })

  it("trusts only the base-SHA manifest and invokes exact reviewed tuples", async () => {
    const getFileContent = vi.fn(async () => manifest())
    const mcp = runtime()

    await expect(
      collectPrReviewAppEvidence({
        client: { getFileContent },
        runtime: mcp,
        owner: "acme",
        repo: "api",
        baseSha: BASE,
        headSha: HEAD,
      }),
    ).resolves.toEqual([
      { kind: "vercel-deployment-status", state: "ready", matchingDeployments: 1 },
      { kind: "supabase-advisors", advisorType: "security", total: 1, errors: 1, warnings: 0, infos: 0 },
    ])
    expect(getFileContent).toHaveBeenCalledWith("acme", "api", "sigilix.mcp.json", BASE, {
      signal: expect.any(AbortSignal),
    })
    expect(mcp.invoke).toHaveBeenCalledWith(
      {
        serverId: "vercel-grant",
        toolName: "list_deployments",
        arguments: { teamId: "team_1", projectId: "prj_1" },
      },
      expect.any(AbortSignal),
    )
    expect(mcp.invoke).toHaveBeenCalledWith(
      {
        serverId: "supabase-grant",
        toolName: "get_advisors",
        arguments: { project_id: "supabase-ref", type: "security" },
      },
      expect.any(AbortSignal),
    )
  })

  it("omits a missing or ambiguous server but keeps another provider's evidence", async () => {
    const mcp = runtime({
      catalog: vi.fn(async () => [
        { serverId: "vercel-grant", vendor: "vercel", name: "list_deployments" },
        { serverId: "vercel-grant", vendor: "vercel", name: "list_deployments" },
        { serverId: "supabase-grant", vendor: "supabase", name: "get_advisors" },
      ]),
    })
    const out = await collectPrReviewAppEvidence({
      client: { getFileContent: async () => manifest() },
      runtime: mcp,
      owner: "acme",
      repo: "api",
      baseSha: BASE,
      headSha: HEAD,
    })
    expect(out).toEqual([
      { kind: "supabase-advisors", advisorType: "security", total: 1, errors: 1, warnings: 0, infos: 0 },
    ])
  })

  it("keeps partial evidence when one provider call fails", async () => {
    const baseline = runtime()
    const mcp = runtime({
      invoke: vi.fn(async (args, signal) =>
        args.toolName === "list_deployments" ? null : baseline.invoke(args, signal),
      ),
    })
    await expect(
      collectPrReviewAppEvidence({
        client: { getFileContent: async () => manifest() },
        runtime: mcp,
        owner: "acme",
        repo: "api",
        baseSha: BASE,
        headSha: HEAD,
      }),
    ).resolves.toEqual([
      { kind: "supabase-advisors", advisorType: "security", total: 1, errors: 1, warnings: 0, infos: 0 },
    ])
  })

  it("applies one total deadline and fails soft", async () => {
    vi.useFakeTimers()
    try {
      const mcp = runtime({
        catalog: vi.fn(
          () =>
            new Promise<
              import("@/src/features/pr-review-app-evidence/domain/types").PrReviewMcpToolDescriptor[] | null
            >(() => undefined),
        ),
      })
      let settled: unknown = "pending"
      void collectPrReviewAppEvidence({
        client: { getFileContent: async () => manifest() },
        runtime: mcp,
        owner: "acme",
        repo: "api",
        baseSha: BASE,
        headSha: HEAD,
      }).then((value) => {
        settled = value
      })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(settled).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
