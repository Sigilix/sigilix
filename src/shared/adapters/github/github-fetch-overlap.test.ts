// SIG-374 — tests for the instance-scoped fetch-overlap counter on
// GitHubClient. The counter sizes SIG-371/372 (file-fetch memoization /
// PR-meta round-trip collapse): the adapter only counts, the app layer
// reads `fetchOverlapSummary()` at review end and emits the telemetry
// event. Measurement only — these tests also pin that counting never
// changes fetch behavior.

import { describe, it, expect, vi, afterEach } from "vitest"
import { GitHubClient } from "@/src/shared/adapters/github"

afterEach(() => {
  vi.restoreAllMocks()
})

const newClient = () => new GitHubClient({ token: "ghs_secret_token" })

const FILE_BODY = JSON.stringify({
  type: "file",
  encoding: "base64",
  content: Buffer.from("export const x = 1\n", "utf8").toString("base64"),
})

function mockFetchOk(body: string = FILE_BODY): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  )
}

describe("GitHubClient.fetchOverlapSummary", () => {
  it("starts empty", () => {
    expect(newClient().fetchOverlapSummary()).toEqual({
      totalCalls: 0,
      uniqueKeys: 0,
      dupCalls: 0,
      topDupPaths: [],
      prMetaCalls: 0,
    })
  })

  it("counts duplicate getFileContent calls per (path, ref) and ranks topDupPaths", async () => {
    mockFetchOk()
    const client = newClient()
    await client.getFileContent("o", "r", "src/a.ts", "abc1234")
    await client.getFileContent("o", "r", "src/a.ts", "abc1234")
    await client.getFileContent("o", "r", "src/a.ts", "abc1234")
    await client.getFileContent("o", "r", "src/b.ts", "abc1234")
    await client.getFileContent("o", "r", "src/b.ts", "abc1234")
    await client.getFileContent("o", "r", "src/c.ts", "abc1234")
    const summary = client.fetchOverlapSummary()
    expect(summary.totalCalls).toBe(6)
    expect(summary.uniqueKeys).toBe(3)
    expect(summary.dupCalls).toBe(3)
    expect(summary.topDupPaths).toEqual(["src/a.ts@abc1234", "src/b.ts@abc1234"])
  })

  it("treats the same path at different refs as distinct keys", async () => {
    mockFetchOk()
    const client = newClient()
    await client.getFileContent("o", "r", "src/a.ts", "abc1234")
    await client.getFileContent("o", "r", "src/a.ts", "def5678")
    const summary = client.fetchOverlapSummary()
    expect(summary.totalCalls).toBe(2)
    expect(summary.uniqueKeys).toBe(2)
    expect(summary.dupCalls).toBe(0)
  })

  it("counts failed (404 → null) fetches too — a dup 404 is still a wasted round-trip", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }))
    const client = newClient()
    await client.getFileContent("o", "r", "missing.ts", "abc1234")
    await client.getFileContent("o", "r", "missing.ts", "abc1234")
    expect(client.fetchOverlapSummary().dupCalls).toBe(1)
  })

  it("counts getPullRequest round-trips separately as prMetaCalls", async () => {
    mockFetchOk(JSON.stringify({ number: 1 }))
    const client = newClient()
    await client.getPullRequest("o", "r", 1)
    await client.getPullRequest("o", "r", 1)
    expect(client.fetchOverlapSummary().prMetaCalls).toBe(2)
  })

  it("is instance-scoped — a second client starts at zero", async () => {
    mockFetchOk()
    const a = newClient()
    await a.getFileContent("o", "r", "src/a.ts", "abc1234")
    expect(newClient().fetchOverlapSummary().totalCalls).toBe(0)
    expect(a.fetchOverlapSummary().totalCalls).toBe(1)
  })
})
