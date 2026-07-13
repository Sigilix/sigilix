// Anthropic structured-output schema sanitizer.
//
// Anthropic's structured-output API (Claude via OpenRouter, and Claude on
// Bedrock) REJECTS `minimum`/`maximum` on a `type:"integer"` (or
// `type:"number"`) node:
//   output_config.format.schema: For 'integer' type, properties maximum, minimum are not supported
// Every OTHER provider we run (Moonshot/Kimi, DeepSeek, the rest of the
// OpenRouter/Bedrock fleet) accepts those keywords, and our finding/verdict
// schemas in `src/shared/domain/schemas.ts` put min/max on ~15 integer fields
// (score, confidence, line, startLine, lineStart, lineEnd, reviewEffort, …).
//
// Those constraints STAY in the canonical schema — they back post-parse
// validation and the exported types elsewhere — so we strip them ONLY from the
// copy sent to Anthropic, and ONLY when the target model is Anthropic. For every
// other provider the schema sent is byte-identical to today (the sanitizer is
// never invoked, and callers pass the original `args.format` reference through).
//
// The stripped range is not lost for recall: the review parser
// (`triage-pr-review.ts`) already rejects and clamps `score`/`confidence` into
// 1–5 at the parse boundary regardless of provider, so an Anthropic model that
// now sees no min/max hint cannot slip an out-of-range value past validation.

/** JSON-Schema primitive types Anthropic forbids min/max on. */
const ANTHROPIC_NUMERIC_TYPES = new Set(["integer", "number"])

/**
 * True when `model` targets an Anthropic model on any provider we route to:
 *   - OpenRouter ids are provider-prefixed — `anthropic/claude-sonnet-4.6`.
 *   - Bedrock ids / inference profiles carry the vendor segment —
 *     `us.anthropic.claude-sonnet-5`, `anthropic.claude-3-...`.
 * Both cases contain the substring "anthropic" or "claude" (case-insensitive),
 * so a single test covers the OpenRouter and Bedrock adapters. No non-Anthropic
 * model id we run contains either token, so the match is exact for our fleet.
 */
export function isAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase()
  return lower.includes("anthropic") || lower.includes("claude")
}

/**
 * Return a DEEP-CLONED copy of `schema` with `minimum`/`maximum` removed from
 * every node whose own `type` is `"integer"` or `"number"`, at any nesting depth
 * (nested `properties`, array `items`, `$defs`, etc.). Everything else — `type`,
 * `properties`, `required`, `enum`, `description`, sibling keys, nested objects
 * and arrays — is preserved verbatim. The input is never mutated.
 *
 * A key literally named `minimum`/`maximum` that is a schema PROPERTY (i.e. it
 * lives under a `properties` map, whose owning node has `type:"object"`) is left
 * untouched: stripping only happens on a node that is ITSELF a numeric type.
 */
export function sanitizeSchemaForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
  return stripNumericBounds(schema) as Record<string, unknown>
}

function stripNumericBounds(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => stripNumericBounds(child))
  }
  if (node === null || typeof node !== "object") {
    return node
  }
  const obj = node as Record<string, unknown>
  const isNumericNode = typeof obj.type === "string" && ANTHROPIC_NUMERIC_TYPES.has(obj.type)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (isNumericNode && (key === "minimum" || key === "maximum")) continue
    out[key] = stripNumericBounds(value)
  }
  return out
}
