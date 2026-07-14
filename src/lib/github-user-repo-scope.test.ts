import { describe, expect, it, vi } from "vitest"
import {
  listGithubAppInstallationRepos,
  listGithubUserInstallationRepos,
  listGithubUserInstallationReposForInstallation,
} from "@/src/lib/github-user-repo-scope"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function repository(id: number, fullName: string): { id: number; full_name: string } {
  return { id, full_name: fullName }
}

function repositoriesPage(page: number): Array<{ id: number; full_name: string }> {
  return Array.from({ length: 100 }, (_, index) =>
    repository((page - 1) * 100 + index + 1, `acme/repo-${page}-${index}`),
  )
}

function exactJson(repositories: unknown[], totalCount = repositories.length): Response {
  return json({ total_count: totalCount, repositories })
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

describe("listGithubAppInstallationRepos", () => {
  it("uses only the app installation endpoint with installation-token auth and immutable repository ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      expect(url.pathname).toBe("/installation/repositories")
      expect(url.searchParams.get("per_page")).toBe("100")
      expect(url.searchParams.get("page")).toBe("1")
      expect(new Headers(init?.headers).get("authorization")).toBe("token ghs_installation")
      return exactJson([repository(101, "Acme/api"), repository(202, "Acme/worker")])
    })

    await expect(
      listGithubAppInstallationRepos("ghs_installation", 42, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      ok: true,
      repos: [
        { installationId: 42, repoId: 101, owner: "Acme", repo: "api" },
        { installationId: 42, repoId: 202, owner: "Acme", repo: "worker" },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("listGithubUserInstallationReposForInstallation", () => {
  it("lists only the request-selected installation endpoint and returns immutable repository ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      expect(url.pathname).toBe("/user/installations/42/repositories")
      expect(url.searchParams.get("per_page")).toBe("100")
      expect(url.searchParams.get("page")).toBe("1")
      return exactJson([repository(101, "Acme/api"), repository(202, "Acme/worker")])
    })
    const fetchImpl = fetchMock as unknown as typeof fetch

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({
      ok: true,
      repos: [
        { installationId: 42, repoId: 101, owner: "Acme", repo: "api" },
        { installationId: 42, repoId: 202, owner: "Acme", repo: "worker" },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.some(([input]) => new URL(input.toString()).pathname === "/user/installations")).toBe(
      false,
    )
  })

  it("paginates by page shape while requiring one stable exact total_count", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      expect(url.pathname).toBe("/user/installations/42/repositories")
      return url.searchParams.get("page") === "1"
        ? exactJson(repositoriesPage(1), 101)
        : exactJson([repository(101, "acme/final")], 101)
    }) as unknown as typeof fetch

    const result = await listGithubUserInstallationReposForInstallation("token", 42, {
      fetchImpl,
      timeoutMs: 1_000,
    })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.repos).toHaveLength(101)
    expect(result.ok && result.repos.at(-1)).toEqual({
      installationId: 42,
      repoId: 101,
      owner: "acme",
      repo: "final",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("accepts exactly twenty full pages only after an empty sentinel page proves completeness", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(input.toString()).searchParams.get("page"))
      return exactJson(page <= 20 ? repositoriesPage(page) : [], 2_000)
    }) as unknown as typeof fetch

    const result = await listGithubUserInstallationReposForInstallation("token", 42, {
      fetchImpl,
      timeoutMs: 2_000,
    })
    expect(result.ok && result.repos).toHaveLength(2_000)
    expect(fetchImpl).toHaveBeenCalledTimes(21)
  })

  it("fails closed when the non-empty sentinel page proves the result exceeds the page cap", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(input.toString()).searchParams.get("page"))
      return exactJson(repositoriesPage(page), 2_100)
    }) as unknown as typeof fetch

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 2_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
    expect(fetchImpl).toHaveBeenCalledTimes(21)
  })

  it.each([
    ["missing id", { full_name: "acme/api" }],
    ["zero id", { id: 0, full_name: "acme/api" }],
    ["fractional id", { id: 1.5, full_name: "acme/api" }],
    ["unsafe id", { id: Number.MAX_SAFE_INTEGER + 1, full_name: "acme/api" }],
    ["string id", { id: "101", full_name: "acme/api" }],
    ["missing full_name", { id: 101 }],
    ["empty owner", { id: 101, full_name: "/api" }],
    ["empty repo", { id: 101, full_name: "acme/" }],
    ["extra slash", { id: 101, full_name: "acme/api/other" }],
    ["whitespace", { id: 101, full_name: "acme/api repo" }],
    ["control character", { id: 101, full_name: "acme/api\u0000" }],
    ["DEL character", { id: 101, full_name: "acme/api\u007f" }],
    ["lone high surrogate", { id: 101, full_name: "acme/api\ud800" }],
    ["lone low surrogate", { id: 101, full_name: "acme/api\udfff" }],
    ["oversized full_name", { id: 101, full_name: `acme/${"a".repeat(508)}` }],
  ])("rejects the full result when any repository row has a malformed %s", async (_label, row) => {
    const fetchImpl = vi.fn(async () => exactJson([repository(100, "acme/good"), row]))

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })

  it.each([
    ["one immutable id maps to different names", [repository(101, "acme/api"), repository(101, "acme/worker")]],
    [
      "one case-insensitive name maps to different immutable ids",
      [repository(101, "Acme/API"), repository(202, "acme/api")],
    ],
    ["one immutable id repeats with the same name", [repository(101, "acme/api"), repository(101, "acme/api")]],
  ])("rejects duplicate repository rows when %s", async (_label, repositories) => {
    const fetchImpl = vi.fn(async () => exactJson(repositories))

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })

  it.each([
    ["missing total_count", { repositories: [] }],
    ["negative total_count", { total_count: -1, repositories: [] }],
    ["fractional total_count", { total_count: 1.5, repositories: [] }],
    ["unsafe total_count", { total_count: Number.MAX_SAFE_INTEGER + 1, repositories: [] }],
    ["missing repositories array", { total_count: 0 }],
    ["non-array repositories", { total_count: 0, repositories: null }],
    [
      "more rows than requested per page",
      { total_count: 101, repositories: Array(101).fill(repository(101, "acme/api")) },
    ],
    ["final unique count differs from total_count", { total_count: 2, repositories: [repository(101, "acme/api")] }],
  ])("rejects malformed or partial page shapes: %s", async (_label, body) => {
    const fetchImpl = vi.fn(async () => json(body))

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })

  it("rejects total_count changes across pages", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(input.toString()).searchParams.get("page")
      return page === "1" ? exactJson(repositoriesPage(1), 101) : exactJson([repository(101, "acme/final")], 100)
    }) as unknown as typeof fetch

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })

  it("fails closed when shifting pages repeat an immutable id despite a stable total_count", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(input.toString()).searchParams.get("page"))
      if (page === 1) return exactJson(repositoriesPage(1), 200)
      if (page === 2) {
        return exactJson(
          [
            repository(100, "acme/repo-1-99"),
            ...Array.from({ length: 99 }, (_, index) => repository(index + 101, `acme/repo-2-${index + 1}`)),
          ],
          200,
        )
      }
      return exactJson([], 200)
    }) as unknown as typeof fetch

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("rejects a response whose declared content length exceeds the byte cap", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"total_count":0,"repositories":[]}', {
          headers: { "content-length": "1000001", "content-type": "application/json" },
        }),
    )

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })

  it("rejects a chunked response whose streamed bytes exceed the byte cap", async () => {
    let cancelled = false
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1_000_001))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )

    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
    expect(cancelled).toBe(true)
  })

  it.each([
    ["HTTP failure", async () => json({ message: "unavailable" }, 503)],
    ["malformed JSON", async () => new Response("{")],
    ["network failure", async () => Promise.reject(new Error("offline"))],
  ])("fails closed on %s without returning partial repositories", async (_label, implementation) => {
    await expect(
      listGithubUserInstallationReposForInstallation("token", 42, {
        fetchImpl: vi.fn(implementation),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })

  it("enforces one shared deadline across pages even when the transport ignores AbortSignal", async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        const page = new URL(input.toString()).searchParams.get("page")
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(exactJson(page === "1" ? repositoriesPage(1) : [], 100)), 30)
        })
      }) as unknown as typeof fetch
      let result: unknown = "pending"
      void listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 50 }).then((value) => {
        result = value
      })

      await vi.advanceTimersByTimeAsync(51)
      expect(result).toEqual({ ok: false, reason: "timeout" })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a response body that arrives after the shared deadline", async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      const fetchImpl = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(
                    new ReadableStream<Uint8Array>({
                      start() {
                        // The late response is never consumed.
                      },
                      cancel() {
                        cancelled = true
                      },
                    }),
                  ),
                ),
              100,
            )
          }),
      ) as unknown as typeof fetch
      let result: unknown = "pending"
      void listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 50 }).then((value) => {
        result = value
      })

      await vi.advanceTimersByTimeAsync(51)
      expect(result).toEqual({ ok: false, reason: "timeout" })
      await vi.advanceTimersByTimeAsync(50)
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("enforces the same shared deadline while a response body is stalled", async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Headers arrive, but the body never yields or closes.
              },
              cancel() {
                cancelled = true
              },
            }),
          ),
      )
      let result: unknown = "pending"
      void listGithubUserInstallationReposForInstallation("token", 42, { fetchImpl, timeoutMs: 50 }).then((value) => {
        result = value
      })

      await vi.advanceTimersByTimeAsync(51)
      expect(result).toEqual({ ok: false, reason: "timeout" })
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["empty token", "", 42],
    ["zero installation", "token", 0],
    ["fractional installation", "token", 1.5],
    ["unsafe installation", "token", Number.MAX_SAFE_INTEGER + 1],
  ])("fails closed without a request for %s", async (_label, token, installationId) => {
    const fetchImpl = vi.fn()

    await expect(listGithubUserInstallationReposForInstallation(token, installationId, { fetchImpl })).resolves.toEqual(
      { ok: false, reason: "lookup_failed" },
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
