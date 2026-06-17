import { describe, expect, it } from "vitest"
import { parseFailedProvider } from "./model-provider-internals"

// SIG-460: parseFailedProvider feeds runWithRetryAndFallback's provider retry-exclude.
// It must extract + slugify the upstream provider named in a MID-STREAM failure, and
// return null for every other failure shape (so those add no exclusion).
describe("parseFailedProvider (SIG-460)", () => {
  it("extracts + slugifies the provider from the observed mid-stream stream error", () => {
    expect(parseFailedProvider("OpenRouter stream error: Upstream error from WandB: Internal server error")).toBe(
      "wandb",
    )
  })

  it("normalizes multi-word / mixed-case display names to OpenRouter slugs", () => {
    expect(parseFailedProvider("Upstream error from DeepInfra: 500")).toBe("deepinfra")
    expect(parseFailedProvider("Upstream error from Moonshot AI: timeout")).toBe("moonshotai")
    expect(parseFailedProvider("upstream error from Atlas Cloud")).toBe("atlascloud")
  })

  it("returns null when no provider is named (no exclusion added)", () => {
    expect(parseFailedProvider(undefined)).toBeNull()
    expect(parseFailedProvider("")).toBeNull()
    expect(parseFailedProvider("OpenRouter HTTP 503: upstream overloaded")).toBeNull()
    expect(parseFailedProvider("OpenRouter HTTP 429: rate limited")).toBeNull()
    expect(parseFailedProvider("verdict_parse_failed")).toBeNull()
    expect(parseFailedProvider("aborted")).toBeNull()
    expect(parseFailedProvider("OpenRouter stream ended without a [DONE] terminator (likely truncated)")).toBeNull()
  })
})
