import { describe, expect, it, vi } from "vitest"
import { listGithubUserInstallationRepos } from "@/src/lib/github-user-repo-scope"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("listGithubUserInstallationRepos", () => {
  it("returns only the exact repositories visible through each user installation", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes("/user/installations?")) {
        return json({
          total_count: 1,
          installations: [{ id: 134811639, account: { login: "Sigilix" }, repository_selection: "selected" }],
        })
      }
      if (url.includes("/user/installations/134811639/repositories?")) {
        return json({ total_count: 1, repositories: [{ full_name: "Sigilix/sigilix" }] })
      }
      return json({ message: "unexpected" }, 404)
    }) as unknown as typeof fetch

    await expect(listGithubUserInstallationRepos("token", { fetchImpl, timeoutMs: 1_000 })).resolves.toEqual({
      ok: true,
      repos: [{ installationId: 134811639, owner: "Sigilix", repo: "sigilix" }],
    })
  })

  it("fails closed instead of returning a partial scope when a repo page fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes("/user/installations?")) {
        return json({ total_count: 1, installations: [{ id: 7, account: { login: "acme" } }] })
      }
      return json({ message: "upstream failed" }, 503)
    }) as unknown as typeof fetch

    const result = await listGithubUserInstallationRepos("token", { fetchImpl, timeoutMs: 1_000 })
    expect(result).toEqual({ ok: false, reason: "lookup_failed" })
  })

  it("paginates by page shape when GitHub underreports mutable total_count values", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const page = url.searchParams.get("page")
      if (url.pathname === "/user/installations") {
        if (page === "1") return json({ total_count: 1, installations: Array(100).fill({ id: 7 }) })
        return json({ total_count: 1, installations: [{ id: 8 }] })
      }
      if (url.pathname === "/user/installations/7/repositories") {
        if (page === "1") {
          return json({ total_count: 1, repositories: Array(100).fill({ full_name: "acme/one" }) })
        }
        return json({ total_count: 1, repositories: [{ full_name: "acme/two" }] })
      }
      if (url.pathname === "/user/installations/8/repositories") {
        return json({ total_count: 1, repositories: [{ full_name: "other/three" }] })
      }
      return json({ message: "unexpected" }, 404)
    }) as unknown as typeof fetch

    const result = await listGithubUserInstallationRepos("token", { fetchImpl, timeoutMs: 1_000 })
    expect(result).toEqual({
      ok: true,
      repos: [
        { installationId: 7, owner: "acme", repo: "one" },
        { installationId: 7, owner: "acme", repo: "two" },
        { installationId: 8, owner: "other", repo: "three" },
      ],
    })
  })
})
