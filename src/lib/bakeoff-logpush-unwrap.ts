// SIG-86 — Logpush envelope unwrap for the bake-off CLI.
//
// Cloudflare Workers Logpush wraps each console.log emission in an
// envelope before writing it to R2 as NDJSON. The exact envelope shape
// depends on the configured dataset:
//
//   1. `workers_trace_events` (the default for Workers Logpush):
//      ```
//      {
//        "Outcome": "ok",
//        "ScriptName": "sigilix",
//        "EventTimestampMs": 1748000000000,
//        "Logs": [{"Level": "log", "Message": ["{\"event\":\"...\"}"], "TimestampMs": ...}]
//      }
//      ```
//      Note: `Message` is an ARRAY of strings (Cloudflare docs
//      sample), not a single string — concatenate before JSON.parse.
//      `EventTimestampMs` is a number (ms epoch).
//
//   2. Some Logpush configurations flatten the inner JSON to a string
//      that itself contains escaped JSON ("double-encoded"). When that
//      happens, the first parse yields a string, not an object — recurse
//      once before giving up.
//
//   3. Operator pre-flattened input (line is already a plain
//      `{event: "...", ...}` object) — pass through unchanged.
//
// Extracted to its own module per code-reviewer M3 + M4 on PR review
// so the unwrap heuristic is unit-testable without involving the CLI's
// file I/O.

const ENVELOPE_TIMESTAMP_KEYS = ["EventTimestampMs", "Timestamp", "timestamp"] as const

/**
 * Unwrap a single parsed line into the inner shadow-bake-off event
 * object, or `null` if no inner event is recoverable. Pure, never
 * throws. The CLI uses this on every line; throwing here would break
 * the streaming load on the first bad envelope.
 */
export function unwrapLogpushEnvelope(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  // Path (3): already a flat event object.
  if (typeof obj.event === "string") return obj
  // Paths (1) + (2): walk the Logs[] array.
  const logs = obj.Logs ?? obj.logs
  if (!Array.isArray(logs) || logs.length === 0) return null
  for (const entry of logs) {
    if (entry === null || typeof entry !== "object") continue
    const inner = tryExtractEventFromLogEntry(entry as Record<string, unknown>)
    if (inner !== null) {
      // Backfill `ts` from the envelope if the inner event didn't
      // carry its own. `EventTimestampMs` is the conventional
      // workers_trace_events field.
      stampEnvelopeTimestamp(inner, obj)
      return inner
    }
  }
  return null
}

/**
 * Try to recover an event from a single `Logs[]` entry. Handles
 * `Message` as either a string or an array of strings (Workers
 * Logpush emits the latter — one element per console.log argument),
 * and recurses once on a double-encoded string payload before giving
 * up.
 *
 * CodeRabbit Major on PR review: when `Message` is a multi-element
 * array (e.g. `console.log("label", JSON.stringify(...))`), joining
 * with a space and JSON-parsing the result fails because the joined
 * string isn't valid JSON. Try parsing each element individually
 * before falling back to the joined-string path — recovers the
 * payload from `["label", "{...}"]`-shaped logs.
 */
function tryExtractEventFromLogEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
  const raw = entry.Message ?? entry.message
  for (const candidate of textCandidates(raw)) {
    const event = tryParseEventFromString(candidate)
    if (event !== null) return event
  }
  return null
}

/** Try each plausible textual interpretation of the `Message` field,
 *  yielding the most-specific candidates first (per-element parsing
 *  beats joined-string parsing). The caller short-circuits on the
 *  first parse that yields an event object. */
function* textCandidates(value: unknown): IterableIterator<string> {
  if (typeof value === "string") {
    yield value
    return
  }
  if (Array.isArray(value)) {
    // First pass: each string element on its own — handles
    // `console.log("label", JSON.stringify(...))` payloads where the
    // JSON-stringified arg lives in element[1].
    for (const v of value) {
      if (typeof v === "string") yield v
    }
    // Fallback: joined on a space. Preserves the v1 contract for the
    // unusual case where the JSON is split across multiple elements.
    const joined = value.filter((v): v is string => typeof v === "string").join(" ")
    if (joined.length > 0) yield joined
  }
}

/** Parse a string to an event object, recursing ONCE on a
 *  double-encoded payload (Logpush re-stringifies in some pipelines). */
function tryParseEventFromString(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== "object") return null
  const inner = parsed as Record<string, unknown>
  if (typeof inner.event !== "string") return null
  return inner
}

function stampEnvelopeTimestamp(inner: Record<string, unknown>, envelope: Record<string, unknown>): void {
  if (typeof inner.ts === "string") return
  for (const key of ENVELOPE_TIMESTAMP_KEYS) {
    const v = envelope[key]
    if (typeof v === "string") {
      inner.ts = v
      return
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      inner.ts = new Date(v).toISOString()
      return
    }
  }
}
