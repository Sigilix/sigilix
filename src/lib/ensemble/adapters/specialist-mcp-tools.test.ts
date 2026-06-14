import { afterEach, describe, expect, it, vi } from "vitest"

import { createSpecialistMcpTools } from "./specialist-mcp-tools"

describe("specialist MCP runtime tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("creates only the permitted tool definitions", () => {
    const tools = createSpecialistMcpTools({
      toolIds: ["file_grep", "docs_fetch", "observability_lookup", "browser_check"],
      reviewCorpus: "",
    })

    expect(tools.map((t) => t.id)).toEqual(["file_grep", "docs_fetch", "observability_lookup", "browser_check"])
    expect(tools.find((t) => t.id === "browser_check")?.description).toMatch(/does not execute JavaScript/i)
  })

  it("file_grep reports complete, empty, and truncated status explicitly", async () => {
    const corpus = [
      "src/auth/session.ts:1 export function removedHelper() {}",
      "src/auth/caller-a.ts:2 removedHelper()",
      "src/auth/caller-b.ts:3 removedHelper()",
      "src/auth/caller-c.ts:4 removedHelper()",
    ].join("\n")
    const [fileGrep] = createSpecialistMcpTools({
      toolIds: ["file_grep"],
      reviewCorpus: corpus,
      fileGrepMaxMatches: 2,
    })

    const truncated = await fileGrep!.execute({ query: "removedHelper" }, new AbortController().signal)
    expect(truncated).toMatchObject({ ok: true, status: "truncated", matchCount: 2, truncated: true })

    const empty = await fileGrep!.execute({ query: "doesNotExist" }, new AbortController().signal)
    expect(empty).toMatchObject({ ok: true, status: "empty", matchCount: 0, truncated: false })

    const complete = await fileGrep!.execute(
      { query: "caller-a", pathGlob: "src/auth/caller-a.ts" },
      new AbortController().signal,
    )
    expect(complete).toMatchObject({
      ok: true,
      status: "complete",
      matchCount: 1,
      matches: [{ path: "src/auth/caller-a.ts", line: 2 }],
    })
  })

  it("docs_fetch rejects non-http urls as structured errors", async () => {
    const [docsFetch] = createSpecialistMcpTools({
      toolIds: ["docs_fetch"],
      reviewCorpus: "",
    })

    await expect(
      docsFetch!.execute({ url: "file:///etc/passwd" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "invalid_url" },
    })
  })

  it("docs_fetch rejects local/private urls as structured errors", async () => {
    const [docsFetch] = createSpecialistMcpTools({
      toolIds: ["docs_fetch"],
      reviewCorpus: "",
    })

    await expect(
      docsFetch!.execute({ url: "http://127.0.0.1:8787/metrics" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "host_not_allowed" },
    })

    await expect(
      docsFetch!.execute({ url: "http://[fd00::1]/metrics" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "host_not_allowed" },
    })

    await expect(
      docsFetch!.execute({ url: "http://[2002:c0a8:0101::1]/metrics" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "host_not_allowed" },
    })

    await expect(
      docsFetch!.execute({ url: "http://[::ffff:127.0.0.1]/metrics" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "host_not_allowed" },
    })
  })

  it("browser_check rejects private urls before fetch", async () => {
    const [browserCheck] = createSpecialistMcpTools({
      toolIds: ["browser_check"],
      reviewCorpus: "",
      browserAllowedHosts: ["127.0.0.1"],
    })

    await expect(
      browserCheck!.execute({ url: "http://127.0.0.1:8787" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "host_not_allowed" },
    })
  })

  it("docs_fetch and browser_check require runtime-owned host allowlists before public fetches", async () => {
    const [docsFetch, browserCheck] = createSpecialistMcpTools({
      toolIds: ["docs_fetch", "browser_check"],
      reviewCorpus: "",
    })

    await expect(
      docsFetch!.execute({ url: "https://example.com/docs" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "unavailable",
      error: { code: "not_configured" },
    })

    await expect(
      browserCheck!.execute({ url: "https://example.com" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "unavailable",
      error: { code: "not_configured" },
    })
  })

  it("does not treat fc/fd-prefixed hostnames as private IPv6 literals", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const [docsFetch] = createSpecialistMcpTools({
      toolIds: ["docs_fetch"],
      reviewCorpus: "",
      docsAllowedHosts: ["FD.EXAMPLE.COM"],
    })

    await expect(
      docsFetch!.execute({ url: "https://fd.example.com/docs" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: true,
      status: "complete",
      httpStatus: 200,
      url: "https://fd.example.com/docs",
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("does not follow redirects from allowed URL fetch tools", async () => {
    const fetch = vi.fn(async () => new Response("", { headers: { location: "http://127.0.0.1" }, status: 302 }))
    vi.stubGlobal("fetch", fetch)
    const [docsFetch] = createSpecialistMcpTools({
      toolIds: ["docs_fetch"],
      reviewCorpus: "",
      docsAllowedHosts: ["docs.example.com"],
    })

    await expect(
      docsFetch!.execute({ url: "https://docs.example.com/start" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: { code: "redirect_not_followed" },
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://docs.example.com/start"),
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it("observability_lookup requires a runtime endpoint and host allowlist", async () => {
    const [unconfigured] = createSpecialistMcpTools({
      toolIds: ["observability_lookup"],
      reviewCorpus: "",
    })

    await expect(
      unconfigured!.execute({ query: "review.latency" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      status: "unavailable",
      error: { code: "not_configured" },
    })

    const fetch = vi.fn(async () => new Response("metric=1", { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const [configured] = createSpecialistMcpTools({
      toolIds: ["observability_lookup"],
      reviewCorpus: "",
      observabilityEndpoint: "https://metrics.example.com/search?existing=1",
      observabilityAllowedHosts: ["metrics.example.com"],
    })

    await expect(configured!.execute({ query: "review.latency" }, new AbortController().signal)).resolves.toMatchObject(
      {
        ok: true,
        status: "complete",
        text: "metric=1",
      },
    )
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://metrics.example.com/search?existing=1&q=review.latency"),
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it("returns bounded truncated fetch snapshots", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(13_000), { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const [docsFetch] = createSpecialistMcpTools({
      toolIds: ["docs_fetch"],
      reviewCorpus: "",
      docsAllowedHosts: ["docs.example.com"],
    })

    await expect(
      docsFetch!.execute({ url: "https://docs.example.com/large" }, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: true,
      status: "truncated",
      httpStatus: 200,
      truncated: true,
      text: "x".repeat(12_000),
    })
  })

  it("cancels truncated fetch response streams", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(13_000)))
      },
      cancel,
    })
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const [docsFetch] = createSpecialistMcpTools({
      toolIds: ["docs_fetch"],
      reviewCorpus: "",
      docsAllowedHosts: ["docs.example.com"],
    })

    await docsFetch!.execute({ url: "https://docs.example.com/large" }, new AbortController().signal)

    expect(cancel).toHaveBeenCalled()
  })
})
