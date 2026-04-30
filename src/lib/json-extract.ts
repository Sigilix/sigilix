// Robust JSON extraction from free-form LLM responses.
//
// Models occasionally don't comply with "return only JSON" instructions
// — sometimes they prepend a "Here's the overview:" preamble, sometimes
// wrap the JSON in a ```json fence, sometimes append a sign-off. The
// strict `JSON.parse(text.trim())` path rejects all of those; this
// helper tries several extraction strategies in order from most-clean
// to least so the caller's loop short-circuits on the cleanest hit.
//
// Common malformations beyond shape-mismatch:
//   - Unescaped raw newlines inside string values (GLM-5.1 long-form bug)
//   - Trailing commas before } / ]
//   - Smart quotes (curly U+201C/D) instead of straight ASCII
//   - Single quotes around keys/values
//
// We use `jsonrepair` as a final tolerant fallback. It runs only after
// strict JSON.parse fails on every extracted candidate, so well-formed
// output still goes through the fast path.

import { jsonrepair } from "jsonrepair"

export function extractJsonObjectCandidates(text: string): string[] {
  if (typeof text !== "string") return []
  const trimmed = text.trim()
  if (!trimmed) return []

  const candidates: string[] = []
  candidates.push(trimmed)
  candidates.push(
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  )
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim())

  // Balanced-brace scan: walk the whole string and collect EVERY
  // top-level balanced `{...}` chunk as a candidate. Important: we do
  // NOT stop at the first match — a model that wrote
  // "Use {placeholder} for the field, then return:\n{ ... real JSON ... }"
  // would have `{placeholder}` matched first, fail to parse, and we'd
  // never reach the real verdict downstream. Push all of them so the
  // caller's parse loop can pick whichever is valid JSON.
  // Skips braces inside string literals so a quoted `"{"` doesn't
  // shift depth.
  let depth = 0
  let segmentStart = -1
  let inString = false
  let escape = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      if (depth === 0) segmentStart = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && segmentStart >= 0) {
        candidates.push(trimmed.slice(segmentStart, i + 1))
        segmentStart = -1
      } else if (depth < 0) {
        // Stray closing brace — reset and keep scanning so a malformed
        // prefix doesn't prevent us from finding a later valid object.
        depth = 0
        segmentStart = -1
      }
    }
  }
  return candidates
}

/**
 * Run extractJsonObjectCandidates and return the first candidate that
 * parses to a non-null, non-array object. Tries strict JSON.parse first
 * on every candidate (fast path for well-formed output), then falls
 * back to jsonrepair on every candidate (handles unescaped newlines,
 * trailing commas, smart quotes, etc. that GLM-5.1 routinely emits).
 */
export function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const candidates = extractJsonObjectCandidates(text)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate (and after that, the repair pass).
    }
  }

  for (const candidate of candidates) {
    try {
      const repaired = jsonrepair(candidate)
      const parsed = JSON.parse(repaired)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next repair candidate.
    }
  }

  return null
}

/**
 * Same parse strategy as parseFirstJsonObject but accepts top-level
 * JSON arrays too. Used by triage-cr where the model emits
 * `[{verdict}, {verdict}, ...]`.
 */
export function parseFirstJsonValue(text: string): unknown {
  const candidates = extractJsonObjectCandidates(text)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next candidate.
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(jsonrepair(candidate))
    } catch {
      // Try the next repair candidate.
    }
  }

  return null
}
