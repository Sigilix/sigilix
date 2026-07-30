// Gateway provider-usage metering. The contract that matters: we read what the
// PROVIDER says it charged for, the client's stream is byte-identical either way,
// and nothing here can ever throw into a completion.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

import {
  readUsageObject,
  extractUsageFromSse,
  withUsageReporting,
  teeForUsage,
} from "@/src/lib/boreas-gateway/provider-usage"

describe("readUsageObject", () => {
  it("reads the OpenAI spelling", () => {
    expect(readUsageObject({ usage: { prompt_tokens: 100, completion_tokens: 25 } })).toEqual({
      inputTokens: 100,
      outputTokens: 25,
    })
  })

  it("reads the input_tokens/output_tokens spelling", () => {
    expect(readUsageObject({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    })
  })

  it("returns null for absent, empty, or all-zero usage rather than inventing a 0-cost row", () => {
    expect(readUsageObject({})).toBeNull()
    expect(readUsageObject({ usage: null })).toBeNull()
    expect(readUsageObject({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBeNull()
    expect(readUsageObject("nonsense")).toBeNull()
    expect(readUsageObject(null)).toBeNull()
  })

  it("coerces junk counts to 0 instead of writing NaN/negatives", () => {
    expect(readUsageObject({ usage: { prompt_tokens: -5, completion_tokens: 12 } })).toEqual({
      inputTokens: 0,
      outputTokens: 12,
    })
    expect(readUsageObject({ usage: { prompt_tokens: "80", completion_tokens: 4 } })).toEqual({
      inputTokens: 0,
      outputTokens: 4,
    })
  })
})

describe("extractUsageFromSse", () => {
  const sse = (lines: string[]) => lines.join("\n")

  it("finds usage on the late chunk of a normal stream", () => {
    const body = sse([
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":340}}',
      "data: [DONE]",
      "",
    ])
    expect(extractUsageFromSse(body)).toEqual({ inputTokens: 1200, outputTokens: 340 })
  })

  it("keeps the LAST usage seen — some providers emit a partial one mid-stream", () => {
    const body = sse([
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":1}}',
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":340}}',
      "data: [DONE]",
    ])
    expect(extractUsageFromSse(body)).toEqual({ inputTokens: 1200, outputTokens: 340 })
  })

  it("skips unparseable chunks, keepalives and [DONE] without throwing", () => {
    const body = sse([
      ": keepalive",
      "data: {broken json",
      "data:",
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}',
      "data: [DONE]",
    ])
    expect(extractUsageFromSse(body)).toEqual({ inputTokens: 5, outputTokens: 6 })
  })

  it("returns null when the provider reported no usage (the pre-include_usage case)", () => {
    expect(extractUsageFromSse(sse(['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"]))).toBeNull()
    expect(extractUsageFromSse("")).toBeNull()
  })
})

describe("withUsageReporting", () => {
  it("asks for usage on a streaming request", () => {
    expect(withUsageReporting({ stream: true, model: "m" })).toEqual({
      stream: true,
      model: "m",
      stream_options: { include_usage: true },
    })
  })

  it("leaves non-streaming requests alone (their response already carries usage)", () => {
    const payload = { stream: false, model: "m" }
    expect(withUsageReporting(payload)).toBe(payload)
    expect(withUsageReporting({ model: "m" })).toEqual({ model: "m" })
  })

  it("FORCES include_usage over a client opt-out (billing is not the client's choice)", () => {
    // Honouring include_usage:false would let the untrusted party switch off the
    // measurement — the exact bypass this module exists to close.
    expect(withUsageReporting({ stream: true, stream_options: { include_usage: false } })).toEqual({
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it("preserves any OTHER stream_options the caller set", () => {
    expect(withUsageReporting({ stream: true, stream_options: { foo: 1, include_usage: false } })).toEqual({
      stream: true,
      stream_options: { foo: 1, include_usage: true },
    })
  })

  it("never mutates the caller's payload", () => {
    const payload: Record<string, unknown> = { stream: true }
    withUsageReporting(payload)
    expect(payload.stream_options).toBeUndefined()
  })
})

describe("teeForUsage", () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":90,"completion_tokens":10}}',
    "data: [DONE]",
    "",
  ].join("\n")

  it("forwards a byte-identical stream AND extracts usage", async () => {
    const upstream = new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-upstream": "vertex" },
    })
    const { forward, usage } = teeForUsage(upstream)

    // The client's branch is untouched — same bytes, status, headers.
    expect(await forward.text()).toBe(sseBody)
    expect(forward.status).toBe(200)
    expect(forward.headers.get("x-upstream")).toBe("vertex")
    expect(await usage).toEqual({ inputTokens: 90, outputTokens: 10 })
  })

  it("extracts usage from a NON-streamed JSON body too", async () => {
    const body = JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } })
    const { forward, usage } = teeForUsage(new Response(body, { status: 200 }))
    expect(await forward.text()).toBe(body)
    expect(await usage).toEqual({ inputTokens: 4, outputTokens: 2 })
  })

  it("a bodyless response (204/error) yields null usage and passes through", async () => {
    const upstream = new Response(null, { status: 204 })
    const { forward, usage } = teeForUsage(upstream)
    expect(forward.status).toBe(204)
    expect(await usage).toBeNull()
  })

  it("usage promise NEVER rejects — a torn stream costs the metering, not the request", async () => {
    const torn = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n'))
        controller.error(new Error("upstream reset"))
      },
    })
    const { forward, usage } = teeForUsage(new Response(torn, { status: 200 }))
    await expect(usage).resolves.toBeNull()
    // The client branch still errors as it should — we don't mask upstream failure.
    await expect(forward.text()).rejects.toThrow()
  })
})

describe("gateway metering wiring (source-level guards)", () => {
  // The wiring is only reachable through a full authed gateway request, so these
  // pin the hand-offs that are silent when broken. Each fails if its line is removed.
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8")

  it("the client-attested report route NO-OPS when provider metering is on", () => {
    // Without this, the client's value lands AFTER the gateway's and simply
    // overwrites it (plain UPDATE, last-writer-wins) — defeating the whole change.
    const route = read("../usage-report-route.ts")
    expect(route).toContain("gatewayProviderUsageEnabled(env)")
    expect(route).toContain('ignored: "provider-metered"')
  })

  it("the gateway mints a server-side event id so a client can't opt out by dropping the header", () => {
    const route = read("./vertex-chat-route.ts")
    expect(route).toContain("crypto.randomUUID()")
    expect(route).toContain("meterEventId")
  })

  it("the cost UPDATE is scoped to the seat (client-supplied ids must not reach another seat's row)", () => {
    expect(read("./vertex-chat-route.ts")).toMatch(/updateUsageEventCost\([\s\S]{0,240}userKey: seatKey/)
  })

  it("metering mode 'off' is a true kill switch for the provider path too", () => {
    expect(read("./vertex-chat-route.ts")).toContain('meterDecision.mode === "off"')
  })

  it("the flag-off path returns the chain response directly — no tee, no stream_options", () => {
    const route = read("./vertex-chat-route.ts")
    expect(route).toMatch(
      /if \(!gatewayProviderUsageEnabled\(env\)[\s\S]{0,160}return runGatewayChain\(env, ctx, cfg, raw as Record<string, unknown>\)/,
    )
  })
})
