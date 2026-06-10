// SIG-381: locks the model-provider seam (shared/ports + shared/adapters/model).
// Exercises the real wiring through its public surface — fails if the refactor
// is reverted (the barrel/ports would not exist) or if the seam regresses.
import { describe, it, expect } from "vitest"
import * as barrel from "@/src/shared/adapters/model"
import { modelProvider, embeddingProvider, generate, chat } from "@/src/shared/adapters/model"
import { ChatDisabledError, isChatDisabledError } from "@/src/shared/adapters/model/ollama-chat"
import type { ModelProviderPort } from "@/src/shared/ports/model"
import type { EmbeddingPort } from "@/src/shared/ports/embedding"

describe("model adapter seam (SIG-381)", () => {
  it("the barrel exposes the provider-agnostic call surface", () => {
    expect(typeof barrel.generate).toBe("function")
    expect(typeof barrel.chat).toBe("function")
    expect(typeof barrel.embedText).toBe("function")
    expect(typeof barrel.embedTexts).toBe("function")
    expect(barrel.EMBEDDING_MODEL).toBe("@cf/baai/bge-base-en-v1.5")
    expect(barrel.EMBEDDING_DIMENSIONS).toBe(768)
  })

  it("modelProvider is the ModelProviderPort swap seam, wired to the active adapter", () => {
    const port: ModelProviderPort = modelProvider
    expect(typeof port.generate).toBe("function")
    expect(typeof port.chat).toBe("function")
    // The provider object IS the swap point — its methods are the active
    // adapter's functions, so flipping the barrel re-points every consumer.
    expect(port.generate).toBe(generate)
    expect(port.chat).toBe(chat)
  })

  it("quarantines the Ollama-specific kill-switch OUT of the swap seam", () => {
    // ChatDisabledError is an Ollama concern; keeping it off the barrel keeps the
    // Ollama->OpenRouter swap a clean 1-adapter change (Kimi design review).
    const surface = barrel as Record<string, unknown>
    expect(surface.ChatDisabledError).toBeUndefined()
    expect(surface.isChatDisabledError).toBeUndefined()
    // ...but it IS reachable directly from the Ollama adapter module.
    expect(typeof ChatDisabledError).toBe("function")
    expect(isChatDisabledError(new ChatDisabledError())).toBe(true)
    expect(isChatDisabledError(new Error("other"))).toBe(false)
  })

  it("embeddingProvider is the EmbeddingPort, wired to the active adapter", () => {
    const port: EmbeddingPort = embeddingProvider
    expect(typeof port.embedText).toBe("function")
    expect(typeof port.embedTexts).toBe("function")
    expect(port.embedText).toBe(barrel.embedText)
    expect(port.embedTexts).toBe(barrel.embedTexts)
  })
})
