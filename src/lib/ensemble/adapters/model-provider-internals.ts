// SIG-318 (PR 8) / SIG-386 — model-provider adapter INTERNALS (PR1 marginal trim).
//
// `isPermanentFailure` is a pure, dependency-free failure-classification helper
// lifted verbatim out of `./model-provider.ts` to land that file at <=1k lines.
// Relocation only: the body is byte-identical (modulo the leading `export`,
// which it already carried). `model-provider.ts` re-exports it so its 16-export
// surface and the `vi.mock` test paths pinned to it are unchanged.

/**
 * Classify a failure reason as permanent (don't retry, don't fall back)
 * vs transient (retry primary, then try fallback).
 *
 * Permanent reasons (CR PR #37 catch — caller should fast-fail):
 *   - parse failure label (model output didn't parse; same prompt at
 *     temp=0 will keep failing)
 *   - HTTP 4xx (except 429 which is rate-limit + transient)
 *     - 404: phantom model name (same problem hits the fallback path
 *       if config is wrong, but better to fail loud than retry silently)
 *     - 401/403: auth — retrying won't fix it
 *     - 400: validation error in our request
 *   - "missing_api_key", "aborted" (already short-circuited but defensive)
 *
 * Transient reasons (keep retrying / falling back):
 *   - HTTP 5xx (server overload — the original case we built for)
 *   - HTTP 429 (rate limited; backoff helps)
 *   - Network errors, timeouts
 *   - Unknown (fail open — assume transient so we still try fallback)
 *
 * The chat() helper throws errors with messages like
 * `Ollama HTTP <status>: <body>`, so we extract the status code. For
 * non-HTTP failures (network), the message has no status — treat as
 * transient.
 */
export function isPermanentFailure(failureReason: string | undefined, parseFailureLabel: string): boolean {
  if (!failureReason) return false
  if (failureReason === parseFailureLabel) return true
  if (failureReason === "missing_api_key" || failureReason === "aborted") return true
  // Match `Ollama HTTP <status>` or generic `HTTP <status>` patterns
  const httpMatch = failureReason.match(/HTTP\s+(\d{3})/i)
  if (httpMatch && httpMatch[1]) {
    const status = Number.parseInt(httpMatch[1], 10)
    if (status === 429) return false // rate-limited = transient
    if (status >= 400 && status < 500) return true // other 4xx = permanent
  }
  return false
}
