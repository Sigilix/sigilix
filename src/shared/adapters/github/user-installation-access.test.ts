import { describe, expect, it, vi } from "vitest"
import { listUserInstallationIds, userCanAccessInstallation } from "./user-installation-access"

function installation(id: number): { id: number } {
  return { id }
}

describe("userCanAccessInstallation", () => {
  it("confirms the exact installation from a fresh GitHub user-token lookup", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ installations: [installation(7), installation(42)] }), {
          headers: { "content-type": "application/json" },
        }),
    )

    await expect(userCanAccessInstallation("github-user-token", 42, { fetchImpl })).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user/installations?per_page=100&page=1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("paginates to an exact match without trusting total_count", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => installation(index + 1))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(input.toString()).searchParams.get("page")
      return new Response(
        JSON.stringify({ total_count: 1, installations: page === "1" ? firstPage : [installation(200)] }),
      )
    })

    await expect(userCanAccessInstallation("github-user-token", 200, { fetchImpl })).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("returns not_owned only after a complete bounded listing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ installations: [installation(7)] })))

    await expect(userCanAccessInstallation("github-user-token", 42, { fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "not_owned",
    })
  })

  it("fails closed when the listing exceeds the hard page bound", async () => {
    const page = Array.from({ length: 100 }, (_, index) => installation(index + 1))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ installations: page })))

    await expect(userCanAccessInstallation("github-user-token", 999, { fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "lookup_failed",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(21)
  })

  it("enforces the deadline when a transport ignores AbortSignal", async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => undefined)
      })
      let result: unknown = "pending"
      void userCanAccessInstallation("github-user-token", 42, { fetchImpl, timeoutMs: 50 }).then((value) => {
        result = value
      })

      await vi.advanceTimersByTimeAsync(51)
      expect(result).toEqual({ ok: false, reason: "timeout" })
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("enforces the same deadline while a response body is stalled", async () => {
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
      void userCanAccessInstallation("github-user-token", 42, { fetchImpl, timeoutMs: 50 }).then((value) => {
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
  ])("fails closed without a request for %s", async (_label, token, installationId) => {
    const fetchImpl = vi.fn()
    await expect(userCanAccessInstallation(token, installationId, { fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "lookup_failed",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ["GitHub rejection", async () => new Response("nope", { status: 503 })],
    ["malformed JSON", async () => new Response("{")],
    ["network failure", async () => Promise.reject(new Error("offline"))],
  ])("fails closed on %s", async (_label, implementation) => {
    await expect(
      userCanAccessInstallation("github-user-token", 42, { fetchImpl: vi.fn(implementation) }),
    ).resolves.toEqual({ ok: false, reason: "lookup_failed" })
  })
})

describe("listUserInstallationIds", () => {
  it("returns every installation id across pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => installation(index + 1))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(input.toString()).searchParams.get("page")
      return new Response(
        JSON.stringify({ installations: page === "1" ? firstPage : [installation(200), installation(201)] }),
      )
    })

    await expect(listUserInstallationIds("github-user-token", { fetchImpl })).resolves.toEqual([
      ...firstPage.map((i) => i.id),
      200,
      201,
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("drops non-positive / non-integer ids", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ installations: [{ id: 7 }, { id: 0 }, { id: -3 }, {}, { id: 1.5 }] })),
    )
    await expect(listUserInstallationIds("github-user-token", { fetchImpl })).resolves.toEqual([7])
  })

  it("fail-soft: returns [] on a non-ok response (login never blocks)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }))
    await expect(listUserInstallationIds("github-user-token", { fetchImpl })).resolves.toEqual([])
  })

  it("fail-soft: returns [] when the token is empty", async () => {
    await expect(listUserInstallationIds("")).resolves.toEqual([])
  })
})
