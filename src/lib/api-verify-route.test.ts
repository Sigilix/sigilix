// POST /v1/verify route: auth gating, validation, the snippet/body caps, the daily
// ceiling, and each verdict passed through as a 200 (a soft-fail `skipped` is NOT an
// error). The oracle (`comparePairInSandbox`) is mocked — its real-engine behavior is
// covered by purelogic-pair.test.ts; here we pin the HTTP contract.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/src/lib/reproduce/purelogic-pair", () => ({ comparePairInSandbox: vi.fn() }))

import { handleVerifyApiRoute } from "./api-verify-route"
import { comparePairInSandbox } from "@/src/lib/reproduce/purelogic-pair"
import type { Env } from "@/src/shared/types/env"

const mockCompare = vi.mocked(comparePairInSandbox)
const TOKEN = "verify-secret"

/** A fresh in-memory KV stub so the daily-ceiling counter doesn't bleed across tests. */
function kvStub(): Env["OPENCLAW_STATE"] {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as Env["OPENCLAW_STATE"]
}

const env = (key?: string, extra: Partial<Env> = {}): Env =>
  ({ OPENCLAW_SIGILIX_API_KEY: key, OPENCLAW_STATE: kvStub(), ...extra }) as unknown as Env

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/verify", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const validBody = { owner: "o", repo: "r", before: "function f(n){return n}", after: "function f(n){return n+1}" }

const changedResult = {
  verdict: "changed" as const,
  detail: "logic-divergence:agree=5:diverge=2",
  elapsedMs: 3,
  sample: { input: "[1]", beforeOut: "V:1", afterOut: "V:2" },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCompare.mockResolvedValue(changedResult)
})

describe("handleVerifyApiRoute — auth + validation", () => {
  it("503 when the key is unset (inert)", async () => {
    expect((await handleVerifyApiRoute(req(validBody), env(undefined))).status).toBe(503)
    expect(mockCompare).not.toHaveBeenCalled()
  })
  it("401 on a missing bearer", async () => {
    expect((await handleVerifyApiRoute(req(validBody, null), env(TOKEN))).status).toBe(401)
    expect(mockCompare).not.toHaveBeenCalled()
  })
  it("401 on a bad bearer", async () => {
    expect((await handleVerifyApiRoute(req(validBody, "nope"), env(TOKEN))).status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await handleVerifyApiRoute(req("{nope", TOKEN), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing before", async () => {
    const { before: _b, ...noBefore } = validBody
    const res = await handleVerifyApiRoute(req(noBefore), env(TOKEN))
    expect(res.status).toBe(400)
    expect(mockCompare).not.toHaveBeenCalled()
  })
  it("400 on a missing after", async () => {
    const { after: _a, ...noAfter } = validBody
    expect((await handleVerifyApiRoute(req(noAfter), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing owner", async () => {
    const { owner: _o, ...noOwner } = validBody
    expect((await handleVerifyApiRoute(req(noOwner), env(TOKEN))).status).toBe(400)
  })
})

describe("handleVerifyApiRoute — body / snippet caps", () => {
  it("413 on an oversized envelope (before the oracle runs)", async () => {
    const huge = { ...validBody, before: "x".repeat(60_000) }
    const res = await handleVerifyApiRoute(req(huge), env(TOKEN))
    expect(res.status).toBe(413)
    expect(mockCompare).not.toHaveBeenCalled()
  })
  it("413 on a single oversized snippet inside a well-formed body", async () => {
    // Under the 48KB body cap but over the 16KB per-snippet cap.
    const big = { ...validBody, after: `() => "${"y".repeat(20_000)}"` }
    const res = await handleVerifyApiRoute(req(big), env(TOKEN))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large")
    expect(mockCompare).not.toHaveBeenCalled()
  })
})

describe("handleVerifyApiRoute — verdicts pass through as 200", () => {
  it("200 changed (with the captured sample)", async () => {
    const res = await handleVerifyApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(changedResult)
    expect(mockCompare).toHaveBeenCalledWith(validBody.before, validBody.after)
  })
  it("200 preserved", async () => {
    mockCompare.mockResolvedValue({ verdict: "preserved", detail: "no-divergence-found", elapsedMs: 2 })
    const res = await handleVerifyApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { verdict: string }).verdict).toBe("preserved")
  })
  it("200 skipped (a soft-fail is NOT an error)", async () => {
    mockCompare.mockResolvedValue({ verdict: "skipped", detail: "arity-mismatch:2!=1", elapsedMs: 1 })
    const res = await handleVerifyApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { verdict: string }).verdict).toBe("skipped")
  })
})

describe("handleVerifyApiRoute — daily ceiling", () => {
  it("429 once the per-day limit is reached", async () => {
    const e = env(TOKEN, { OPENCLAW_SIGILIX_VERIFY_DAILY_LIMIT: "2" })
    expect((await handleVerifyApiRoute(req(validBody), e)).status).toBe(200)
    expect((await handleVerifyApiRoute(req(validBody), e)).status).toBe(200)
    const third = await handleVerifyApiRoute(req(validBody), e)
    expect(third.status).toBe(429)
    expect(mockCompare).toHaveBeenCalledTimes(2) // the 3rd never reached the oracle
  })
  it("the ceiling check runs AFTER cheap validation (a 400 doesn't consume budget)", async () => {
    const e = env(TOKEN, { OPENCLAW_SIGILIX_VERIFY_DAILY_LIMIT: "1" })
    const { before: _b, ...noBefore } = validBody
    expect((await handleVerifyApiRoute(req(noBefore), e)).status).toBe(400) // doesn't count
    expect((await handleVerifyApiRoute(req(validBody), e)).status).toBe(200) // budget still free
  })
})
