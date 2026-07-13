import { describe, it, expect } from "vitest"
import { isAnthropicModel, sanitizeSchemaForAnthropic } from "./anthropic-schema"
import { PR_REVIEW_SCHEMA } from "@/src/shared/domain/schemas"

describe("isAnthropicModel", () => {
  it("matches OpenRouter-prefixed and Bedrock-shaped Anthropic ids (case-insensitive)", () => {
    for (const id of [
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-3.5-sonnet",
      "us.anthropic.claude-sonnet-5",
      "eu.anthropic.claude-3-5-sonnet-20240620-v1:0",
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "Anthropic/Claude-Opus",
    ]) {
      expect(isAnthropicModel(id), id).toBe(true)
    }
  })

  it("does NOT match the non-Anthropic fleet (OpenRouter, Bedrock, Ollama Turbo)", () => {
    for (const id of [
      "openai/o3",
      "moonshotai/kimi-k2",
      "deepseek/deepseek-chat",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "deepseek.v3.2",
      "zai.glm-5",
      "nvidia.nemotron-super-3-120b",
      "mistral.mistral-large-3-675b-instruct",
      "deepseek-v4-pro:cloud",
      "glm-5.1:cloud",
    ]) {
      expect(isAnthropicModel(id), id).toBe(false)
    }
  })
})

describe("sanitizeSchemaForAnthropic", () => {
  it("strips minimum/maximum from a top-level integer node, keeps everything else", () => {
    const out = sanitizeSchemaForAnthropic({
      type: "integer",
      minimum: 1,
      maximum: 5,
      description: "a score",
    })
    expect(out).toEqual({ type: "integer", description: "a score" })
  })

  it("strips minimum/maximum from a number node too", () => {
    const out = sanitizeSchemaForAnthropic({ type: "number", minimum: 0, maximum: 1 })
    expect(out).toEqual({ type: "number" })
  })

  it("strips at all nesting depths — nested properties AND array items", () => {
    const out = sanitizeSchemaForAnthropic({
      type: "object",
      properties: {
        score: { type: "integer", minimum: 1, maximum: 5 },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              line: { type: "integer", minimum: 1 },
              lineStart: { type: "integer", minimum: 1, maximum: 1000000 },
            },
            required: ["line"],
          },
        },
      },
      required: ["score"],
    })
    expect(out).toEqual({
      type: "object",
      properties: {
        score: { type: "integer" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              line: { type: "integer" },
              lineStart: { type: "integer" },
            },
            required: ["line"],
          },
        },
      },
      required: ["score"],
    })
  })

  it("preserves siblings, required, enum, descriptions, and string/array nodes untouched", () => {
    const input = {
      type: "object",
      properties: {
        category: { type: "string", enum: ["logic", "security"], description: "the bucket" },
        labels: { type: "array", maxItems: 3, items: { type: "string" } },
        confidence: { type: "integer", minimum: 1, maximum: 5, description: "1-5" },
      },
      required: ["category", "confidence"],
      additionalProperties: false,
    }
    const out = sanitizeSchemaForAnthropic(input)
    expect(out).toEqual({
      type: "object",
      properties: {
        category: { type: "string", enum: ["logic", "security"], description: "the bucket" },
        labels: { type: "array", maxItems: 3, items: { type: "string" } },
        confidence: { type: "integer", description: "1-5" },
      },
      required: ["category", "confidence"],
      additionalProperties: false,
    })
  })

  it("leaves a schema with no integer/number bounds unchanged (deep-equal)", () => {
    const input = {
      type: "object",
      properties: {
        summary: { type: "string" },
        abstain: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["summary"],
    }
    expect(sanitizeSchemaForAnthropic(input)).toEqual(input)
  })

  it("does NOT strip a schema PROPERTY literally named minimum/maximum on an object node", () => {
    // `minimum` here is a property key under an object node, not a numeric
    // constraint — its owning node is type:object, so it must survive.
    const input = {
      type: "object",
      properties: {
        minimum: { type: "string" },
        maximum: { type: "string" },
      },
      required: ["minimum"],
    }
    expect(sanitizeSchemaForAnthropic(input)).toEqual(input)
  })

  it("deep-clones — the input schema is never mutated", () => {
    const input = {
      type: "object",
      properties: { score: { type: "integer", minimum: 1, maximum: 5 } },
    }
    const snapshot = JSON.stringify(input)
    const out = sanitizeSchemaForAnthropic(input)
    expect(JSON.stringify(input)).toBe(snapshot) // input untouched
    expect(out).not.toBe(input) // fresh object
    expect((out.properties as Record<string, unknown>).score).not.toBe(input.properties.score)
  })

  it("removes every min/max from the real PR_REVIEW_SCHEMA while keeping its shape", () => {
    const out = sanitizeSchemaForAnthropic(PR_REVIEW_SCHEMA as unknown as Record<string, unknown>)
    // No `minimum`/`maximum` anywhere in the sanitized copy…
    expect(JSON.stringify(out)).not.toMatch(/"minimum"|"maximum"/)
    // …but the original canonical schema still carries them (not mutated).
    expect(JSON.stringify(PR_REVIEW_SCHEMA)).toMatch(/"minimum"/)
    // Core required keys + the integer `score` field survive.
    expect((out as { required: string[] }).required).toContain("findings")
    const findingProps = (
      out as {
        properties: { findings: { items: { properties: Record<string, { type?: string }> } } }
      }
    ).properties.findings.items.properties
    expect(findingProps.score!.type).toBe("integer")
    expect(findingProps.line!.type).toBe("integer")
  })
})
