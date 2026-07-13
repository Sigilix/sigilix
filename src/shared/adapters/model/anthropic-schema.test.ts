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

  it("preserves siblings, required, enum, descriptions, and item schemas — strips only the constraint keywords", () => {
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
        // `maxItems` stripped from the array node; `items` schema preserved.
        labels: { type: "array", items: { type: "string" } },
        confidence: { type: "integer", description: "1-5" },
      },
      required: ["category", "confidence"],
      additionalProperties: false,
    })
  })

  it("strips array-cardinality keywords (minItems/maxItems/uniqueItems) from a typed array node", () => {
    const out = sanitizeSchemaForAnthropic({
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string" },
    })
    expect(out).toEqual({ type: "array", items: { type: "string" } })
  })

  it("strips string-validation keywords (minLength/maxLength/pattern/format) from a typed string node", () => {
    const out = sanitizeSchemaForAnthropic({
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^[0-9a-fA-F]{40}$",
      format: "date-time",
      description: "keep me",
    })
    expect(out).toEqual({ type: "string", description: "keep me" })
  })

  it("strips the remaining numeric keywords (exclusiveMinimum/exclusiveMaximum/multipleOf)", () => {
    const out = sanitizeSchemaForAnthropic({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
      multipleOf: 0.5,
    })
    expect(out).toEqual({ type: "number" })
  })

  it("strips constraint keywords inside anyOf/oneOf/allOf branch schemas", () => {
    const out = sanitizeSchemaForAnthropic({
      anyOf: [
        { type: "integer", minimum: 1, maximum: 5 },
        { type: "string", maxLength: 10, pattern: "^x" },
      ],
      allOf: [{ type: "array", maxItems: 2, items: { type: "string", format: "email" } }],
    })
    expect(out).toEqual({
      anyOf: [{ type: "integer" }, { type: "string" }],
      allOf: [{ type: "array", items: { type: "string" } }],
    })
  })

  it("leaves a schema with no constraint keywords unchanged (deep-equal)", () => {
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

  it("does NOT strip schema PROPERTIES literally named after a constraint keyword", () => {
    // These are property KEYS under a `properties` map (its container is a plain
    // map with no `type`), not constraints on a typed node — they must survive.
    const input = {
      type: "object",
      properties: {
        minimum: { type: "string" },
        maximum: { type: "string" },
        pattern: { type: "string" },
        format: { type: "string" },
        maxItems: { type: "integer" },
      },
      required: ["minimum", "pattern", "format"],
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

  it("removes every unsupported constraint keyword from the real PR_REVIEW_SCHEMA while keeping its shape", () => {
    const out = sanitizeSchemaForAnthropic(PR_REVIEW_SCHEMA as unknown as Record<string, unknown>)
    // None of the unsupported keywords appear anywhere in the sanitized copy…
    expect(JSON.stringify(out)).not.toMatch(
      /"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minItems|maxItems|uniqueItems|minLength|maxLength|pattern|format)"/,
    )
    // …but the original canonical schema still carries them (not mutated) — it
    // has both `minimum` (score/line) and `maxItems` (the findings array).
    expect(JSON.stringify(PR_REVIEW_SCHEMA)).toMatch(/"minimum"/)
    expect(JSON.stringify(PR_REVIEW_SCHEMA)).toMatch(/"maxItems"/)
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
