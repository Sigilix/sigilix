import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DeepResearchDO, CREATOR_HEADER, type ResearchTestHooks } from "./deep-research-do"
import type { Env } from "@/src/shared/types/env"
import type { SearchQueryResult } from "./search"
import type { FetchPageResult } from "./fetch-guard"
import type { ResearchModelRole } from "./types"

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
