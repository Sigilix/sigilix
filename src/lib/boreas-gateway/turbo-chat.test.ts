// #158 — unit coverage for the Turbo (Ollama Turbo, OpenAI-compat) fallback leg,
// isolated from the full route (vertex-chat-route.fallback.test.ts covers the
// end-to-end behavior through the real routes).

import { afterEach, describe, expect, it, vi } from "vitest"
import { attemptTurboLeg, isTurboConfigured, resolveTurboModel } from "@/src/lib/boreas-gateway/turbo-chat"
import { OLLAMA_TURBO_CHAT_COMPLETIONS_URL } from "@/src/lib/boreas-gateway/constants"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("resolveTurboModel", () => {
  it("prefers a non-empty env override over the built-in default", () => {
    expect(resolveTurboModel("custom:cloud", "default:cloud")).toBe("custom:cloud")
  })
  it("falls back to the built-in default when the env override is unset", () => {
    expect(resolveTurboModel(undefined, "default:cloud")).toBe("default:cloud")
  })
  it("falls back to the built-in default when the env override is blank", () => {
    expect(resolveTurboModel("   ", "default:cloud")).toBe("default:cloud")
  })
  it("returns undefined when neither an override nor a default exists (Pyroeis)", () => {
    expect(resolveTurboModel(undefined, undefined)).toBeUndefined()
  })
})

describe("isTurboConfigured", () => {
  it("requires BOTH a key and a resolved model id", () => {
    expect(isTurboConfigured("key", "model:cloud")).toBe(true)
    expect(isTurboConfigured(undefined, "model:cloud")).toBe(false)
    expect(isTurboConfigured("key", undefined)).toBe(false)
    expect(isTurboConfigured("", "model:cloud")).toBe(false)
  })
})

describe("attemptTurboLeg", () => {
  it("forces the resolved model id and sends the Bearer auth header", async () => {
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "cmpl-1" }), { headers: { "content-type": "application/json" } }),
    )
    vi.stubGlobal("fetch", f)

    const result = await attemptTurboLeg(
      { messages: [{ role: "user", content: "hi" }], model: "attacker-chosen" },
      "glm-5.2:cloud",
      "turbo-key",
      5000,
    )

    expect(result.response.status).toBe(200)
    expect(result.upstreamModel).toBe("glm-5.2:cloud")
    const call = f.mock.calls[0]
    expect(String(call?.[0])).toBe(OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
    const init = call?.[1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer turbo-key")
    const sent = JSON.parse(init.body as string) as { model?: string }
    expect(sent.model).toBe("glm-5.2:cloud")
    expect(sent.model).not.toBe("attacker-chosen")
  })

  it("never throws — a network failure is synthesized into a generic 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network fell over")
      }),
    )
    const result = await attemptTurboLeg({ messages: [] }, "glm-5.2:cloud", "turbo-key", 5000)
    expect(result.response.status).toBe(502)
    const body = (await result.response.json()) as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain("turbo-key")
    expect(JSON.stringify(body)).not.toContain("network fell over")
  })
})
