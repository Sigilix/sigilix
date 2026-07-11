import { describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { buildResearchMcpRuntime } from "./mcp-runtime"

function makeEnv(handler: (request: Request) => Promise<Response> | Response): {
  env: Env
  names: string[]
} {
  const names: string[] = []
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      return handler(request as unknown as Request)
    }),
  }
  const namespace = {
    idFromName: vi.fn((name: string) => {
      names.push(name)
      return { name }
    }),
    get: vi.fn(() => stub),
  }
  return { env: { MCP_CONNECTIONS: namespace } as unknown as Env, names }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

describe("research MCP runtime binding", () => {
  it("does not create an MCP namespace for anonymous or invalid creators", () => {
    const { env, names } = makeEnv(() => json({ tools: [] }))
    expect(buildResearchMcpRuntime(env, "session:111", "run-1", "chat")).toBeUndefined()
    expect(buildResearchMcpRuntime(env, "tenant:-1", "run-1", "chat")).toBeUndefined()
    expect(buildResearchMcpRuntime(env, "tenant:111", "bad run id", "chat")).toBeUndefined()
    expect(buildResearchMcpRuntime(env, "tenant:111", "run-1", "agent" as never)).toBeUndefined()
    expect(names).toEqual([])
  })

  it("uses the exact creator namespace and independently rejects forged catalog capabilities", async () => {
    const { env, names } = makeEnv(() =>
      json({
        tools: [
          {
            serverId: "linear-1",
            vendor: "linear",
            name: "list_comments",
            description: "REMOTE DESCRIPTION MUST NOT WIN",
            inputSchema: {
              type: "object",
              description: "remote prompt",
              properties: { issueId: { type: "string", description: "remote prompt" } },
            },
          },
          { serverId: "linear-1", vendor: "linear", name: "create_issue", inputSchema: { type: "object" } },
          { serverId: "custom-1", vendor: "custom", name: "list_comments", inputSchema: { type: "object" } },
        ],
      }),
    )
    const runtime = buildResearchMcpRuntime(env, "tenant:111", "run-1", "chat")!
    expect(await runtime.catalog()).toEqual([
      {
        serverId: "linear-1",
        vendor: "linear",
        name: "list_comments",
        description: "Read Linear comments visible to the connected account.",
        inputSchema: { type: "object", properties: { issueId: { type: "string" } } },
      },
    ])
    expect(names).toEqual(["tenant:111"])
  })

  it("posts an exact invocation tuple and accepts only sanitized text evidence", async () => {
    let invokeBody: unknown
    const { env } = makeEnv(async (request) => {
      if (new URL(request.url).pathname.endsWith("/catalog")) return json({ tools: [] })
      invokeBody = await request.json()
      return json({
        result: {
          untrusted: true,
          content: [
            { type: "text", text: "comment data", annotations: { audience: ["assistant"] } },
            { type: "image", data: "secret" },
          ],
          truncated: false,
          structuredContent: { secret: true },
        },
      })
    })
    const runtime = buildResearchMcpRuntime(env, "tenant:99", "run-7", "deep-research")!
    await expect(
      runtime.invoke({
        serverId: "linear-1",
        toolName: "list_comments",
        arguments: { issueId: "SIG-193" },
      }),
    ).resolves.toEqual({ untrusted: true, content: [{ type: "text", text: "comment data" }], truncated: false })
    expect(invokeBody).toEqual({
      runId: "run-7",
      serverId: "linear-1",
      toolName: "list_comments",
      arguments: { issueId: "SIG-193" },
    })
  })

  it("fails soft when the internal MCP hop rejects or returns a non-success status", async () => {
    const rejected = makeEnv(() => {
      throw new Error("DO unavailable")
    })
    await expect(buildResearchMcpRuntime(rejected.env, "tenant:99", "run-1", "chat")!.catalog()).resolves.toEqual([])

    const denied = makeEnv(() => json({ error: "denied" }, 503))
    await expect(buildResearchMcpRuntime(denied.env, "tenant:99", "run-1", "chat")!.catalog()).resolves.toEqual([])
  })

  it("bounds an internal MCP hop even when the stub ignores Request.signal", async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | undefined
      const { env } = makeEnv((request) => {
        requestSignal = request.signal
        return new Promise<Response>(() => undefined)
      })
      let outcome: unknown = "pending"
      void buildResearchMcpRuntime(env, "tenant:99", "run-timeout", "chat")!
        .catalog()
        .then((value) => {
          outcome = value
        })

      await vi.advanceTimersByTimeAsync(12_001)
      expect(outcome).toEqual([])
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a response body that arrives after the internal deadline", async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      const { env } = makeEnv(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(
                    new ReadableStream<Uint8Array>({
                      start() {
                        // The timed-out caller must discard this unread body.
                      },
                      cancel() {
                        cancelled = true
                      },
                    }),
                  ),
                ),
              13_000,
            )
          }),
      )
      let outcome: unknown = "pending"
      void buildResearchMcpRuntime(env, "tenant:99", "run-late-response", "chat")!
        .catalog()
        .then((value) => {
          outcome = value
        })

      await vi.advanceTimersByTimeAsync(12_001)
      expect(outcome).toEqual([])
      expect(cancelled).toBe(false)
      await vi.advanceTimersByTimeAsync(999)
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("applies the same deadline to a stalled internal response body", async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      const { env } = makeEnv(
        () =>
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
      let outcome: unknown = "pending"
      void buildResearchMcpRuntime(env, "tenant:99", "run-slow-body", "chat")!
        .catalog()
        .then((value) => {
          outcome = value
        })

      await vi.advanceTimersByTimeAsync(12_001)
      expect(outcome).toEqual([])
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels an oversized internal response before buffering the full body", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        value.enqueue(new Uint8Array(200_000))
        value.enqueue(new Uint8Array(100_000))
      },
      cancel() {
        cancelled = true
      },
    })
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const { env } = makeEnv(() => new Response(stream))
      const bounded = Promise.race([
        buildResearchMcpRuntime(env, "tenant:99", "run-large", "chat")!
          .catalog()
          .then((value) => ({ kind: "result" as const, value })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          guard = setTimeout(() => resolve({ kind: "timeout" }), 1_000)
        }),
      ])
      await expect(bounded).resolves.toEqual({ kind: "result", value: [] })
      expect(cancelled).toBe(true)
    } finally {
      if (guard !== undefined) clearTimeout(guard)
    }
  })

  it("fails soft on an empty successful response body", async () => {
    const { env } = makeEnv(() => new Response(null, { status: 200 }))
    await expect(buildResearchMcpRuntime(env, "tenant:99", "run-empty", "chat")!.catalog()).resolves.toEqual([])
  })

  it("rejects invalid UTF-8 instead of corrupting MCP evidence", async () => {
    const prefix = new TextEncoder().encode('{"result":{"content":[{"type":"text","text":"')
    const suffix = new TextEncoder().encode('"}]}}')
    const body = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength)
    body.set(prefix)
    body[prefix.byteLength] = 0xff
    body.set(suffix, prefix.byteLength + 1)
    const { env } = makeEnv(() => new Response(body))

    await expect(
      buildResearchMcpRuntime(env, "tenant:99", "run-invalid-utf8", "chat")!.invoke({
        serverId: "linear-1",
        toolName: "list_comments",
        arguments: {},
      }),
    ).resolves.toBeNull()
  })

  it("rejects a declared oversized internal response before trusting its JSON", async () => {
    const { env } = makeEnv(
      () =>
        new Response(
          JSON.stringify({
            tools: [{ serverId: "linear-1", vendor: "linear", name: "list_comments", inputSchema: { type: "object" } }],
          }),
          { headers: { "content-length": "256001" } },
        ),
    )

    await expect(buildResearchMcpRuntime(env, "tenant:99", "run-declared-large", "chat")!.catalog()).resolves.toEqual(
      [],
    )
  })
})
