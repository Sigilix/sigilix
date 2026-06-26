// SIG-455 (PR B Task 2) — parseRetryAfterMs extracted from backpressure.ts so the
// model adapter (shared/adapters) can import it without an inward-violating cross-
// feature import. Leaf: no heavy imports; pure function.

/**
 * Maximum value returned by `parseRetryAfterMs` (5 minutes).
 * A hostile or misconfigured `Retry-After` must never pin us indefinitely.
 */
export const MAX_RETRY_AFTER_MS = 300_000

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 *
 * Supports two formats per RFC 9110 §10.2.3:
 *   - **delta-seconds**: a non-negative integer string (`/^\d+$/`) →
 *     `seconds * 1000`.
 *   - **HTTP-date**: any string parseable by `Date.parse` → `max(0, parsed - nowMs)`.
 *
 * Falls back to `defaultMs` when `header` is `null`, empty, negative,
 * non-numeric + non-date, or produces `NaN`.
 *
 * Always clamps the result to `MAX_RETRY_AFTER_MS` to guard against a
 * pathological large header value that would stall retries for too long.
 *
 * @param header    - The raw `Retry-After` header string, or `null`.
 * @param nowMs     - The current epoch time in ms (injected; not read from Date).
 * @param defaultMs - Value returned when the header is absent or invalid.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number, defaultMs: number): number {
  if (header === null || header === "") return defaultMs

  // Try delta-seconds: must be a non-negative integer string (no sign, no dot).
  if (/^\d+$/.test(header)) {
    const seconds = parseInt(header, 10)
    if (!isNaN(seconds)) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }

  // Guard: a string that looks like a numeric value (signed, float, scientific)
  // but did NOT match the strict non-negative integer above is an invalid
  // delta-seconds (negative or non-integer). Return defaultMs immediately
  // rather than letting Date.parse parse it as a year or partial date.
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(header)) {
    return defaultMs
  }

  // Try HTTP-date.
  const parsed = Date.parse(header)
  if (!isNaN(parsed)) {
    return Math.min(Math.max(0, parsed - nowMs), MAX_RETRY_AFTER_MS)
  }

  return defaultMs
}
