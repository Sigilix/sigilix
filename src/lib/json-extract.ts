// Robust JSON extraction from free-form LLM responses.
//
// Models occasionally don't comply with "return only JSON" instructions
// — sometimes they prepend a "Here's the overview:" preamble, sometimes
// wrap the JSON in a ```json fence, sometimes append a sign-off. The
// strict `JSON.parse(text.trim())` path rejects all of those; this
// helper tries several extraction strategies in order from most-clean
// to least so the caller's loop short-circuits on the cleanest hit.
//
// Pure helper. No I/O. Returns candidate strings — caller is responsible
// for `JSON.parse(candidate)` and shape validation.

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
 * parses to a non-null, non-array object. Convenience wrapper that
 * encapsulates the try/catch loop callers always need.
 */
export function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  for (const candidate of extractJsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}
