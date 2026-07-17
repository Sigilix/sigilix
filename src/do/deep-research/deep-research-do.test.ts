import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DeepResearchDO, CREATOR_HEADER, type ResearchTestHooks } from "./deep-research-do"
import type { Env } from "@/src/shared/types/env"
import type { SearchQueryResult } from "./search"
import type { FetchPageResult } from "./fetch-guard"
import type { ResearchModelRole } from "./types"
import type { ChatMessage, ChatToolDef } from "@/src/shared/ports/model"
import type { ResearchModelFn } from "./model"
import type { ResearchVideoEvidence } from "./video-evidence"

// ── fake DO state ────────────────────────────────────────────────────

function makeDoState(store = new Map<string, unknown>()): { ctx: DurableObjectState; store: Map<string, unknown> } {
  let alarm: number | null = null
  const ctx = {
    id: { toString: () => "deep-research-instance-1" },
    waitUntil: (_p: Promise<unknown>) => undefined,
    storage: {
      async get<T>(k: string): Promise<T | undefined> {
        return store.get(k) as T | undefined
      },
      async put<T>(k: string, v: T): Promise<void> {
        store.set(k, v)
      },
      async delete(k: string): Promise<boolean> {
        return store.delete(k)
      },
      async deleteAll(): Promise<void> {
        store.clear()
      },
      async setAlarm(t: number): Promise<void> {
        alarm = t
      },
      async getAlarm(): Promise<number | null> {
        return alarm
      },
      async deleteAlarm(): Promise<void> {
        alarm = null
      },
      async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
        const prefix = opts?.prefix ?? ""
        const m = new Map<string, T>()
        for (const [k, v] of store) if (k.startsWith(prefix)) m.set(k, v as T)
        return m
      },
    },
  } as unknown as DurableObjectState
  return { ctx, store }
}

function makeEnv(over: Partial<Env> = {}): Env {
  return { OPENCLAW_TAVILY_API_KEY: "search-key", ...over } as unknown as Env
}

async function makeVideoBucket(args: {
  id: string
  creator: string
  installationId: number
}): Promise<{ bucket: R2Bucket; bytes: Uint8Array }> {
  const bytes = Uint8Array.of(
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    0x69,
    0x73,
    0x6f,
    0x6d,
    0x00,
    0x00,
    0x02,
    0x00,
    0x69,
    0x73,
    0x6f,
    0x6d,
    0x69,
    0x73,
    0x6f,
    0x32,
  )
  const createdAtMs = Date.now()
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer)
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  const customMetadata = {
    version: "1",
    creator: args.creator,
    installationId: String(args.installationId),
    filename: encodeURIComponent("walkthrough.mp4"),
    mimeType: "video/mp4",
    size: String(bytes.byteLength),
    sha256,
    createdAtMs: String(createdAtMs),
    expiresAtMs: String(createdAtMs + 23 * 60 * 60 * 1_000),
  }
  const object = {
    key: `chat/v1/${args.id}`,
    version: "v1",
    size: bytes.byteLength,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date(createdAtMs),
    checksums: {},
    storageClass: "Standard",
    customMetadata,
    httpMetadata: { contentType: "video/mp4" },
    body: new Blob([bytes.slice().buffer]).stream(),
    bodyUsed: false,
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => "",
    json: async <T>() => ({}) as T,
    blob: async () => new Blob([bytes.slice().buffer], { type: "video/mp4" }),
    writeHttpMetadata: () => undefined,
    range: undefined,
    ssecKeyMd5: undefined,
  } as unknown as R2ObjectBody
  const bucket = {
    get: async (key: string) => (key === object.key ? object : null),
  } as unknown as R2Bucket
  return { bucket, bytes }
}

function makeMcpNamespace(): {
  namespace: DurableObjectNamespace
  names: string[]
  calls: Array<{ path: string; body: Record<string, unknown> }>
} {
  const names: string[] = []
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown>
      const path = new URL(request.url).pathname
      calls.push({ path, body })
      if (path.endsWith("/catalog")) {
        return new Response(
          JSON.stringify({
            tools: [
              {
                serverId: "linear-server-1",
                vendor: "linear",
                name: "list_comments",
                description: "Read Linear comments visible to the connected account.",
                inputSchema: {
                  type: "object",
                  properties: { issueId: { type: "string" } },
                  required: ["issueId"],
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )
      }
      return new Response(
        JSON.stringify({
          result: {
            untrusted: true,
            content: [{ type: "text", text: "Daniel: please cover the tenant-boundary regression." }],
            truncated: false,
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  }
  const namespace = {
    idFromName(name: string) {
      names.push(name)
      return { name }
    },
    get() {
      return stub
    },
  } as unknown as DurableObjectNamespace
  return { namespace, names, calls }
}

// Deferred helper for pausing the run mid-flight.
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function baseHooks(over: Partial<ResearchTestHooks> = {}): ResearchTestHooks {
  return {
    model: async (role: ResearchModelRole) => {
      const text =
        role === "classify"
          ? "factual"
          : role === "planner"
            ? "1. facet\nquery one\nquery two"
            : role === "extract"
              ? "Relevant finding with concrete detail about version 3.2 behavior and flags."
              : role === "synthesis"
                ? "Consolidated notes with sourced detail."
                : role === "stopCheck"
                  ? "STOP"
                  : "# Final Answer\n\nSummary [1]."
      return { text, tokens: 10 }
    },
    search: (): Promise<SearchQueryResult> =>
      Promise.resolve({
        ok: true,
        provider: "tavily",
        hits: [{ url: "https://example.com/a", title: "A", snippet: "s" }],
      }),
    fetchPage: (url: string): Promise<FetchPageResult> =>
      Promise.resolve({ ok: true, page: { url, title: "A", domain: "example.com", text: "body" } }),
    ...over,
  }
}

// Read an SSE Response body fully into parsed event objects.
async function readSse(res: Response): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  return buf
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((json) => JSON.parse(json) as { type: string })
}

function req(path: string, method: string, body?: unknown, creator?: string): Request {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["content-type"] = "application/json"
  if (creator !== undefined) headers[CREATOR_HEADER] = creator
  return new Request(`https://deep-research.do${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function drive(instance: DeepResearchDO): Promise<void> {
  await (instance as unknown as { driveDone: Promise<void> | null }).driveDone
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe("DeepResearchDO — SSE buffering + replay", () => {
  it("replays the full transcript from the start after completion, ending with done", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(baseHooks())

    const start = await instance.fetch(req("/start", "POST", { question: "how does X work?" }))
    expect(start.status).toBe(200)
    await drive(instance)

    const stream = await instance.fetch(req("/stream", "GET"))
    const events = await readSse(stream)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("status")
    expect(types).toContain("plan")
    expect(types).toContain("final")
    expect(types[types.length - 1]).toBe("done")
  })

  it("replays the SAME full transcript to a SECOND reconnect (buffer is not consumed)", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(baseHooks())
    await instance.fetch(req("/start", "POST", { question: "q" }))
    await drive(instance)

    const first = await readSse(await instance.fetch(req("/stream", "GET")))
    const second = await readSse(await instance.fetch(req("/stream", "GET")))
    expect(second.map((e) => e.type)).toEqual(first.map((e) => e.type))
    expect(second.length).toBeGreaterThan(3)
  })

  it("a client connecting MID-RUN gets the buffered prefix AND the live remainder", async () => {
    const gateReached = deferred()
    const gateRelease = deferred()
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(
      baseHooks({
        model: async (role: ResearchModelRole) => {
          if (role === "finalReport") {
            gateReached.resolve() // run has buffered everything except final+done
            await gateRelease.promise
            return { text: "# Final [1]", tokens: 10 }
          }
          const text =
            role === "classify" ? "factual" : role === "planner" ? "q one" : role === "stopCheck" ? "STOP" : "notes"
          return { text, tokens: 10 }
        },
      }),
    )

    await instance.fetch(req("/start", "POST", { question: "q" }))
    await gateReached.promise // paused right before the final report

    const streamPromise = readSse(await instance.fetch(req("/stream", "GET")))
    gateRelease.resolve() // let final + done emit live to the connected writer
    await drive(instance)

    const events = await streamPromise
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("status") // replayed from the very start
    expect(types).toContain("final") // received live after connect
    expect(types[types.length - 1]).toBe("done")
  })

  it("a COLD isolate (new instance, same storage) replays from persisted storage", async () => {
    const store = new Map<string, unknown>()
    const first = new DeepResearchDO(makeDoState(store).ctx, makeEnv())
    first.setTestHooks(baseHooks())
    await first.fetch(req("/start", "POST", { question: "q" }))
    await drive(first)

    // Brand-new instance backed by the same persisted store — no in-memory buffer.
    const revived = new DeepResearchDO(makeDoState(store).ctx, makeEnv())
    const events = await readSse(await revived.fetch(req("/stream", "GET")))
    expect(events.map((e) => e.type)).toContain("final")
    expect(events[events.length - 1]!.type).toBe("done")
  })
})

describe("DeepResearchDO — authenticated MCP execution", () => {
  it.each([
    { mode: "chat" as const, surface: "chat" },
    { mode: "deep" as const, surface: "deep-research" },
  ])("wires verified read-only evidence into the $mode model path", async ({ mode, surface }) => {
    const { namespace, names, calls } = makeMcpNamespace()
    const finalMessages: ChatMessage[][] = []
    const model: ResearchModelFn = async (role: ResearchModelRole, messages: ChatMessage[], tools?: ChatToolDef[]) => {
      if (tools?.length) {
        expect(tools).toHaveLength(1)
        expect(tools[0]!.function.name).toBe("sigilix_mcp_0")
        return {
          text: "",
          tokens: 3,
          toolCalls: [
            { function: { name: "sigilix_mcp_0", arguments: { issueId: "SIG-193" } } },
            { function: { name: "forged_tool", arguments: {} } },
          ],
        }
      }
      if (role === "finalReport") finalMessages.push(messages)
      const text =
        role === "classify"
          ? "factual"
          : role === "planner"
            ? "tenant boundary\nSIG-193 review comments"
            : role === "extract"
              ? "Relevant finding with concrete detail about version 3.2 behavior and flags."
              : role === "synthesis"
                ? "Consolidated notes with sourced detail."
                : role === "stopCheck"
                  ? "STOP"
                  : "# Answer\n\nThe review asks for tenant-boundary coverage [MCP: Linear/list_comments]."
      return { text, tokens: 10 }
    }
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv({ MCP_CONNECTIONS: namespace }))
    instance.setTestHooks(baseHooks({ model }))

    const start = await instance.fetch(
      req("/start", "POST", {
        question: "What do the SIG-193 comments ask us to cover?",
        mode,
        creator: "session:111",
        mcpTenantScope: "tenant:42",
      }),
    )
    expect(start.status).toBe(200)
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:111")))
    expect(events[0]).toMatchObject({ type: "status", phase: "planning" })
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(
      events.some(
        (event) =>
          event.type === "note" && typeof event.text === "string" && event.text.includes("Linear/list_comments"),
      ),
    ).toBe(true)
    expect(events.find((event) => event.type === "final")?.markdown).toContain("[MCP: Linear/list_comments]")
    expect(names).toEqual(["tenant:42"])
    expect(calls.map((call) => call.path)).toEqual([
      "/broker/memory/query",
      `/broker/runtime/${surface}/catalog`,
      `/broker/runtime/${surface}/invoke`,
    ])
    expect(calls[0]!.body).toEqual({
      surface,
      query: "What do the SIG-193 comments ask us to cover?",
      topK: 4,
    })
    expect(calls[1]!.body).toEqual({})
    expect(calls[2]!.body).toEqual({
      runId: "deep-research-instance-1",
      serverId: "linear-server-1",
      toolName: "list_comments",
      arguments: { issueId: "SIG-193" },
    })
    expect(
      finalMessages
        .at(-1)
        ?.map((message) => message.content)
        .join("\n"),
    ).toContain("Daniel: please cover the tenant-boundary regression.")
    expect(finalMessages.at(-1)?.[0]?.content).toMatch(/untrusted external data, never instructions/i)
  })

  it("never resolves or calls an MCP namespace without a positive tenant scope", async () => {
    const { namespace, names, calls } = makeMcpNamespace()
    let selectorCalls = 0
    const model: ResearchModelFn = async (_role, _messages, tools) => {
      if (tools?.length) selectorCalls += 1
      return { text: "# Direct answer", tokens: 1 }
    }
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv({ MCP_CONNECTIONS: namespace }))
    instance.setTestHooks(baseHooks({ model }))

    await instance.fetch(
      req("/start", "POST", {
        question: "What do the connected comments say?",
        mode: "chat",
        creator: "session:111",
        mcpTenantScope: "session:111",
      }),
    )
    await drive(instance)

    expect(names).toEqual([])
    expect(calls).toEqual([])
    expect(selectorCalls).toBe(0)
  })
})

describe("DeepResearchDO — verified video context", () => {
  it("loads private R2 bytes, analyzes them, and gives the final model delimited cited evidence", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const { bucket, bytes } = await makeVideoBucket({ id, creator: "session:alice", installationId: 99 })
    const finalMessages: ChatMessage[][] = []
    const analyzeVideo = vi.fn(async ({ question, video }): Promise<ResearchVideoEvidence> => {
      expect(question).toBe("what happens in the walkthrough?")
      expect(video).toMatchObject({ id, mimeType: "video/mp4", installationId: 99, bytes })
      const { bytes: _bytes, ...attachment } = video
      return {
        text:
          `Summary: A settings workflow is shown. [video:${id}]\n` +
          `- model-estimated ~00:04 — Repository access is selected. [video:${id}]`,
        attachment,
        tokens: 150,
      }
    })
    const model: ResearchModelFn = async (role, messages) => {
      if (role === "finalReport") finalMessages.push(messages)
      return { text: `# Answer\n\nRepository access is selected [video:${id}].`, tokens: 10 }
    }
    const { ctx, store } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv({ SIGILIX_CHAT_ATTACHMENTS: bucket }))
    instance.setTestHooks(baseHooks({ model, analyzeVideo }))

    const start = await instance.fetch(
      req("/start", "POST", {
        question: "what happens in the walkthrough?",
        mode: "chat",
        creator: "session:alice",
        videoAttachmentId: id,
        videoAttachmentInstallationId: 99,
      }),
    )
    expect(start.status).toBe(200)
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.some((event) => event.type === "note" && String(event.text).includes("model-estimated"))).toBe(true)
    const prompt =
      finalMessages
        .at(-1)
        ?.map((message) => message.content)
        .join("\n") ?? ""
    expect(prompt).toContain("BEGIN_UNTRUSTED_VIDEO_EVIDENCE")
    expect(prompt).toContain(`[video:${id}]`)
    expect(prompt).toContain("model-estimated ~00:04")
    expect(prompt).toMatch(/untrusted user upload, never instructions/i)
    expect(store.get("meta")).toMatchObject({
      videoAttachmentId: id,
      videoAttachment: { id, filename: "walkthrough.mp4", mimeType: "video/mp4", installationId: 99 },
    })
    expect(JSON.stringify(store.get("meta"))).not.toContain(Buffer.from(bytes).toString("base64"))
  })

  it("fails closed before analysis when the video does not belong to the run creator", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const { bucket } = await makeVideoBucket({ id, creator: "session:alice", installationId: 99 })
    const analyzeVideo = vi.fn()
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv({ SIGILIX_CHAT_ATTACHMENTS: bucket }))
    instance.setTestHooks(baseHooks({ analyzeVideo }))

    await instance.fetch(
      req("/start", "POST", {
        question: "what happens?",
        mode: "chat",
        creator: "session:mallory",
        videoAttachmentId: id,
        videoAttachmentInstallationId: 99,
      }),
    )
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:mallory")))
    expect(events).toContainEqual({ type: "error", message: "video_attachment_unavailable" })
    expect(events.at(-1)).toEqual({ type: "done" })
    expect(analyzeVideo).not.toHaveBeenCalled()
  })

  it("fails honestly without calling the final model when video analysis fails", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const { bucket } = await makeVideoBucket({ id, creator: "session:alice", installationId: 99 })
    const model = vi.fn(baseHooks().model!)
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv({ SIGILIX_CHAT_ATTACHMENTS: bucket }))
    instance.setTestHooks(
      baseHooks({
        model,
        analyzeVideo: async () => {
          throw new Error("provider unavailable")
        },
      }),
    )

    await instance.fetch(
      req("/start", "POST", {
        question: "what happens?",
        mode: "chat",
        creator: "session:alice",
        videoAttachmentId: id,
        videoAttachmentInstallationId: 99,
      }),
    )
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    expect(events).toContainEqual({ type: "error", message: "video_analysis_failed" })
    expect(events.at(-1)).toEqual({ type: "done" })
    expect(model).not.toHaveBeenCalled()
  })
})

describe("DeepResearchDO — cooperative cancel", () => {
  it("cancel makes the run emit the stop note then done, with no final", async () => {
    const gateReached = deferred()
    const gateRelease = deferred()
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(
      baseHooks({
        // Pause after the first round's synthesis so we can cancel between steps.
        model: async (role: ResearchModelRole) => {
          if (role === "synthesis") {
            gateReached.resolve()
            await gateRelease.promise
          }
          const text =
            role === "classify"
              ? "factual"
              : role === "planner"
                ? "q one"
                : role === "extract"
                  ? "Relevant detailed finding about the topic version 3.2."
                  : role === "stopCheck"
                    ? "CONTINUE"
                    : role === "synthesis"
                      ? "notes"
                      : "# Final"
          return { text, tokens: 10 }
        },
      }),
    )

    await instance.fetch(req("/start", "POST", { question: "q" }))
    await gateReached.promise
    const cancelRes = await instance.fetch(req("/cancel", "POST"))
    expect(cancelRes.status).toBe(200)
    gateRelease.resolve()
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET")))
    const types = events.map((e) => e.type)
    expect(events.some((e) => e.type === "note" && /cancelled by request/i.test(String(e.text)))).toBe(true)
    expect(types[types.length - 1]).toBe("done")
    expect(types).not.toContain("final")
  })
})

describe("DeepResearchDO — no secret leakage", () => {
  it("never emits the search API key in any SSE event or log line", async () => {
    const secret = "TOP-SECRET-SEARCH-KEY"
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv({ OPENCLAW_TAVILY_API_KEY: secret }))
    instance.setTestHooks(baseHooks())
    await instance.fetch(req("/start", "POST", { question: "q" }))
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET")))
    for (const e of events) expect(JSON.stringify(e)).not.toContain(secret)
    const logLines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    for (const line of logLines) expect(line).not.toContain(secret)
  })
})

describe("DeepResearchDO — validation", () => {
  it("persists only a registry-valid app selector beside the already-cleaned task", async () => {
    const { ctx, store } = makeDoState()
    const model = vi.fn(baseHooks().model!)
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(baseHooks({ model }))

    const response = await instance.fetch(
      req("/start", "POST", { question: "list recent comments", appId: "linear", creator: "session:42" }),
    )
    await drive(instance)

    expect(response.status).toBe(200)
    expect(store.get("meta")).toMatchObject({
      question: "list recent comments",
      appId: "linear",
      creator: "session:42",
    })
    expect(model).not.toHaveBeenCalled()
  })

  it("rejects a forged app selector before starting", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())

    const response = await instance.fetch(req("/start", "POST", { question: "list", appId: "linear.evil" }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_app" })
  })

  it("rejects a start without a question", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    const res = await instance.fetch(req("/start", "POST", { question: "" }))
    expect(res.status).toBe(400)
  })

  it("cancel before start is a 409", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    const res = await instance.fetch(req("/cancel", "POST"))
    expect(res.status).toBe(409)
  })
})

describe("DeepResearchDO — creator ownership (P2.3)", () => {
  it("a run bound to a creator refuses stream/cancel from a different creator (403)", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(baseHooks())
    await instance.fetch(req("/start", "POST", { question: "q", creator: "session:alice" }))
    await drive(instance)

    // Wrong creator → 403 on both mutating/streaming paths.
    const badStream = await instance.fetch(req("/stream", "GET", undefined, "session:mallory"))
    expect(badStream.status).toBe(403)
    const badCancel = await instance.fetch(req("/cancel", "POST", {}, "session:mallory"))
    expect(badCancel.status).toBe(403)

    // Correct creator → allowed.
    const okStream = await instance.fetch(req("/stream", "GET", undefined, "session:alice"))
    expect(okStream.status).toBe(200)
  })
})

describe("DeepResearchDO — model + effort echo through the DO", () => {
  it("the start body's model + effort surface in the first status event", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(baseHooks())
    await instance.fetch(
      req("/start", "POST", { question: "q", model: "pyroeis", effort: "low", creator: "session:alice" }),
    )
    await drive(instance)

    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    const first = events[0] as { type: string; model?: string; effort?: string }
    expect(first).toMatchObject({ type: "status", model: "pyroeis", effort: "low" })
  })
})

// sig-deep-research-repo-grounding — the DO threads a resolved repo target into
// codebase grounding via the injectable `gatherGrounding` hook.
describe("DeepResearchDO — repo grounding", () => {
  it("grounds a codebase question in the resolved repo and emits repo-file sources", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    const gatherArgs: Array<{ owner: string; repo: string; query: string }> = []
    instance.setTestHooks(
      baseHooks({
        // Fail loudly if a grounded codebase question ever hits web search.
        search: () => Promise.reject(new Error("web search must not run for a grounded codebase question")),
        gatherGrounding: async (args) => {
          gatherArgs.push({ owner: args.owner, repo: args.repo, query: args.query })
          return {
            namespace: "acme/widgets",
            context: "[symbol] src/index/memory-indexer.ts\nexport function indexMemory() {}",
            sources: [
              {
                url: "https://github.com/acme/widgets/blob/HEAD/src/index/memory-indexer.ts#L1-L30",
                title: "src/index/memory-indexer.ts:1-30",
                domain: "acme/widgets",
                kind: "repo" as const,
              },
            ],
            chunkCount: 1,
          }
        },
      }),
    )

    await instance.fetch(
      req("/start", "POST", {
        question: "where does the memory indexing live in our repo?",
        creator: "session:alice",
        owner: "acme",
        repo: "widgets",
        hasIndexedRepo: true,
      }),
    )
    await drive(instance)

    // The DO passed the resolved repo + question to the grounding gatherer.
    expect(gatherArgs).toEqual([
      { owner: "acme", repo: "widgets", query: "where does the memory indexing live in our repo?" },
    ])

    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    const repoSource = events.find((e) => e.type === "source" && (e as { kind?: string }).kind === "repo")
    expect(repoSource).toBeTruthy()
    const final = events.find((e) => e.type === "final") as unknown as {
      markdown: string
      sources: Array<{ kind?: string }>
    }
    expect(final.sources.every((s) => s.kind === "repo")).toBe(true)
    // No web search ran.
    expect(events.some((e) => e.type === "status" && (e as { phase?: string }).phase === "searching")).toBe(false)
  })
})

// sig-chat-conversational-mode — the DO threads the run mode through to the engine
// and skips (heavier) grounding retrieval for a trivial greeting.
describe("DeepResearchDO — conversational mode + trivial guard", () => {
  it("mode 'chat' answers without running web search", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    instance.setTestHooks(
      baseHooks({ search: () => Promise.reject(new Error("web search must not run in chat mode")) }),
    )
    await instance.fetch(
      req("/start", "POST", { question: "how should I name things?", mode: "chat", creator: "session:alice" }),
    )
    await drive(instance)
    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    expect(events.some((e) => e.type === "status" && (e as { phase?: string }).phase === "searching")).toBe(false)
    expect(events.some((e) => e.type === "final")).toBe(true)
    expect(events[events.length - 1]!.type).toBe("done")
  })

  it("a trivial greeting skips grounding entirely and never web-searches", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    let gatherCalls = 0
    instance.setTestHooks(
      baseHooks({
        search: () => Promise.reject(new Error("a greeting must not run web search")),
        gatherGrounding: async () => {
          gatherCalls++
          return null
        },
      }),
    )
    await instance.fetch(
      req("/start", "POST", {
        question: "hey!",
        mode: "deep",
        creator: "session:alice",
        owner: "acme",
        repo: "widgets",
        hasIndexedRepo: true,
      }),
    )
    await drive(instance)
    // Grounding was never gathered for the greeting (cheap-path guard).
    expect(gatherCalls).toBe(0)
    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    expect(events.some((e) => e.type === "status" && (e as { phase?: string }).phase === "searching")).toBe(false)
    expect(events.some((e) => e.type === "final")).toBe(true)
  })

  it("chat mode + a NON-codebase question skips grounding retrieval (kept fast)", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    let gatherCalls = 0
    instance.setTestHooks(
      baseHooks({
        search: () => Promise.reject(new Error("chat mode must not run web search")),
        gatherGrounding: async () => {
          gatherCalls++
          return null
        },
      }),
    )
    await instance.fetch(
      req("/start", "POST", {
        // A general question (no codebase ownership cue) → grounding won't be used,
        // so the DO must not spend the retrieval on it.
        question: "how should I structure a monorepo?",
        mode: "chat",
        creator: "session:alice",
        owner: "acme",
        repo: "widgets",
        hasIndexedRepo: true,
      }),
    )
    await drive(instance)
    expect(gatherCalls).toBe(0)
    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    expect(events.some((e) => e.type === "status" && (e as { phase?: string }).phase === "searching")).toBe(false)
    expect(events.some((e) => e.type === "final")).toBe(true)
  })

  it("chat mode + the implicit implementation-location question DOES gather grounding (repo-cited, no web)", async () => {
    const { ctx } = makeDoState()
    const instance = new DeepResearchDO(ctx, makeEnv())
    let gatherCalls = 0
    instance.setTestHooks(
      baseHooks({
        search: () => Promise.reject(new Error("a grounded codebase question must not run web search")),
        gatherGrounding: async () => {
          gatherCalls++
          return {
            namespace: "sigilix/sigilix",
            context:
              "[symbol] src/features/tenancy/domain/rate-limit.ts\nconst TIER_CAP_MULTIPLIER = { pro: 1, teams: 2, max: 5, ultra: 50 }",
            sources: [
              {
                url: "https://github.com/Sigilix/sigilix/blob/HEAD/src/features/tenancy/domain/rate-limit.ts#L101-L129",
                title: "src/features/tenancy/domain/rate-limit.ts:101-129",
                domain: "Sigilix/sigilix",
                kind: "repo" as const,
              },
            ],
            chunkCount: 1,
          }
        },
      }),
    )
    await instance.fetch(
      req("/start", "POST", {
        question: "Where does the per-tier rate-limit cap get computed, and what are the multipliers?",
        mode: "chat",
        creator: "session:alice",
        owner: "Sigilix",
        repo: "sigilix",
        hasIndexedRepo: true,
      }),
    )
    await drive(instance)
    expect(gatherCalls).toBe(1)
    const events = await readSse(await instance.fetch(req("/stream", "GET", undefined, "session:alice")))
    expect(events.some((e) => e.type === "source" && (e as { kind?: string }).kind === "repo")).toBe(true)
    expect(events.some((e) => e.type === "status" && (e as { phase?: string }).phase === "searching")).toBe(false)
  })
})
