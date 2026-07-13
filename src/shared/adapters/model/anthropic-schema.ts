// Anthropic structured-output schema sanitizer.
//
// Anthropic's structured-output API (Claude via OpenRouter, and Claude on
// Bedrock) REJECTS the JSON-Schema *validation* keyword family on a typed node.
// It surfaces one keyword at a time, e.g.:
//   output_config.format.schema: For 'integer' type, properties maximum, minimum are not supported
//   output_config.format.schema: For 'array' type, property 'maxItems' is not supported
// So the whole family is unsupported — numeric bounds, array cardinality, and
// string length/pattern/format — not just `minimum`/`maximum`.
//
// Every OTHER provider we run (Moonshot/Kimi, DeepSeek, the rest of the
// OpenRouter/Bedrock fleet) accepts these keywords, and our finding/verdict
// schemas in `src/shared/domain/schemas.ts` use them liberally (score/confidence
// min/max, `maxItems` on finding arrays, `minLength`/`maxLength`/`pattern` on
// strings, …).
//
// Those constraints STAY in the canonical schema — they back post-parse
// validation and the exported types elsewhere — so we strip them ONLY from the
// copy sent to Anthropic, and ONLY when the target model is Anthropic. For every
// other provider the schema sent is byte-identical to today (the sanitizer is
// never invoked, and callers pass the original `args.format` reference through).
//
// The stripped constraints are not lost for recall: the review parser
// (`triage-pr-review.ts`) already rejects and clamps `score`/`confidence` into
// 1–5 at the parse boundary regardless of provider, and every list/string field
// is re-validated post-parse, so an Anthropic model that now sees no constraint
// hint cannot slip an invalid value past validation.

/**
 * The JSON-Schema validation keywords Anthropic's structured-output API forbids
 * on a typed node. Stripped from any node that HAS a `type` (numeric, array, or
 * string) — the offending keyword differs by type, but the whole family is
 * unsupported, so we remove all of them wherever a typed node carries one.
 */
const ANTHROPIC_UNSUPPORTED_KEYWORDS = new Set([
  // numeric
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // array
  "minItems",
  "maxItems",
  "uniqueItems",
  // string
  "minLength",
  "maxLength",
  "pattern",
  "format",
])

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
 * Return a DEEP-CLONED copy of `schema` with every Anthropic-unsupported
 * validation keyword (see `ANTHROPIC_UNSUPPORTED_KEYWORDS`) removed from each
 * node that HAS a `type` (`typeof node.type === "string"`), at any nesting depth
 * (nested `properties`, array `items`, `$defs`, `anyOf`/`oneOf`/`allOf`
 * branches, …). Everything else — `type`, `properties`, `required`, `enum`,
 * `description`, sibling keys, nested objects and arrays — is preserved
 * verbatim. The input is never mutated.
 *
 * A key literally named one of these keywords (e.g. a schema PROPERTY called
 * `pattern`/`format`/`minimum`) that lives under a `properties`/`$defs` map is
 * left untouched: its CONTAINER is a plain map with no `type`, so nothing is
 * stripped from it — stripping only happens on a node that is itself typed.
 */
export function sanitizeSchemaForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
  return stripUnsupportedKeywords(schema) as Record<string, unknown>
}

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => stripUnsupportedKeywords(child))
  }
  if (node === null || typeof node !== "object") {
    return node
  }
  const obj = node as Record<string, unknown>
  const isTypedNode = typeof obj.type === "string"
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (isTypedNode && ANTHROPIC_UNSUPPORTED_KEYWORDS.has(key)) continue
    out[key] = stripUnsupportedKeywords(value)
  }
  return out
}
