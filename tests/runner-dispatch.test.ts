// SIG-285 runner-dispatch primitive: builds the correct workflow_dispatch call,
// reports accept/fail from the HTTP status, never throws. No network (fetch injected).

import { describe, expect, it } from "vitest"
import {
  dispatchRunnerCheck,
  parseRunnerDispatchMode,
  type RunnerCheckSpec,
} from "../src/lib/runner-dispatch"

const check: RunnerCheckSpec = { findingId: "logic-3", path: "src/a.ts", line: 12, kind: "ast-grep", spec: "$X == $X" }

function mockFetch(status: number, captured: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    captured.url = url
    captured.init = init
    return new Response(status === 204 ? null : "err", { status })
  }) as unknown as typeof fetch
}

describe("parseRunnerDispatchMode", () => {
  it("defaults to off; parses shadow/on", () => {
    expect(parseRunnerDispatchMode(undefined)).toBe("off")
    expect(parseRunnerDispatchMode("nope")).toBe("off")
    expect(parseRunnerDispatchMode(" SHADOW ")).toBe("shadow")
    expect(parseRunnerDispatchMode("on")).toBe("on")
  })
})

describe("dispatchRunnerCheck", () => {
  it("POSTs workflow_dispatch with ref + stringified spec input and returns dispatched on 204", async () => {
    const cap: { url?: string; init?: RequestInit } = {}
    const r = await dispatchRunnerCheck({
      token: "tok", owner: "Sigilix", repo: "sigilix",
      workflowFile: "sigilix-runner-dispatch.yml", ref: "abc123", check,
      fetchImpl: mockFetch(204, cap),
    })
    expect(r).toEqual({ dispatched: true, status: 204 })
    expect(cap.url).toBe("https://api.github.com/repos/Sigilix/sigilix/actions/workflows/sigilix-runner-dispatch.yml/dispatches")
    expect(cap.init?.method).toBe("POST")
    const body = JSON.parse(cap.init?.body as string)
    expect(body.ref).toBe("abc123")
    expect(JSON.parse(body.inputs.spec)).toEqual(check) // spec round-trips as a JSON string input
    const headers = cap.init?.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer tok")
    expect(headers["x-github-api-version"]).toBe("2022-11-28")
  })

  it("reports dispatched:false on a non-204 (e.g. 403 missing permission, 404, 422)", async () => {
    for (const status of [403, 404, 422]) {
      const r = await dispatchRunnerCheck({
        token: "t", owner: "o", repo: "r", workflowFile: "w.yml", ref: "h", check,
        fetchImpl: mockFetch(status),
      })
      expect(r.dispatched).toBe(false)
      expect(r.status).toBe(status)
    }
  })

  it("never throws — a fetch error returns dispatched:false, status 0", async () => {
    const throwing = (async () => { throw new Error("network down") }) as unknown as typeof fetch
    const r = await dispatchRunnerCheck({
      token: "t", owner: "o", repo: "r", workflowFile: "w.yml", ref: "h", check, fetchImpl: throwing,
    })
    expect(r.dispatched).toBe(false)
    expect(r.status).toBe(0)
    expect(r.error).toContain("network down")
  })
})
