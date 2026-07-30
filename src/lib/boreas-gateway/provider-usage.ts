// Gateway usage metering from PROVIDER-REPORTED token counts.
//
// WHY: the gateway records a coding_agent usage row with no tokens, and cost is
// late-bound by `POST /v1/usage/report` — i.e. **the client tells us what we owe**.
// That is self-reported billing from an untrusted client: a modified CLI can
// under-report, an old CLI reports nothing, and a third-party OpenAI-compatible
// client (which the gateway explicitly supports) never calls the report route at
// all, so its spend is invisible. The upstream response already carries an
// authoritative `usage` object; metering off that is strictly more accurate on
// every path and removes the trust assumption entirely.
//
// This does NOT read the request body. Body-blindness for the REQUEST is preserved;
// we only observe what the provider tells us it charged for on the way back.
//
// FAIL-SOFT: any parse/read failure leaves the row as-is (tokens stay 0, the
// client-reported path still works). Metering must never break a completion.

/** OpenAI-compatible usage block. Providers vary on extras; these three are the contract. */
export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
}

function toCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0
}

/** Read a usage object out of a parsed JSON payload, tolerating both the OpenAI
 *  (`prompt_tokens`/`completion_tokens`) and Anthropic-ish (`input_tokens`) spellings. */
export function readUsageObject(payload: unknown): ProviderUsage | null {
  if (!payload || typeof payload !== "object") return null
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object") return null
  const u = usage as Record<string, unknown>
  const inputTokens = toCount(u.prompt_tokens) || toCount(u.input_tokens)
  const outputTokens = toCount(u.completion_tokens) || toCount(u.output_tokens)
  if (inputTokens === 0 && outputTokens === 0) return null
  return { inputTokens, outputTokens }
}

/**
 * Extract usage from an SSE stream body.
 *
 * OpenAI-compatible streams emit usage ONLY when the request set
 * `stream_options.include_usage` — and it arrives on a LATE chunk (typically the
 * last one before `[DONE]`, with an empty `choices` array). We therefore scan every
 * `data:` line and keep the LAST usage seen rather than stopping at the first,
 * because some providers also emit a partial/zero usage mid-stream.
 *
 * Tolerant by construction: unparseable lines are skipped, `[DONE]` is ignored, and
 * a stream with no usage returns null.
 */
export function extractUsageFromSse(text: string): ProviderUsage | null {
  let latest: ProviderUsage | null = null
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    try {
      const found = readUsageObject(JSON.parse(payload))
      if (found) latest = found
    } catch {
      // A chunk split across reads, or a provider keepalive — skip it.
    }
  }
  return latest
}

/**
 * Ask an OpenAI-compatible provider to report usage on a STREAMING request.
 *
 * Returns a new payload; never mutates the caller's object. No-ops only when the
 * request isn't streaming (non-streaming responses always carry usage).
 *
 * `include_usage` is FORCED, merging over whatever the caller sent. Honouring a
 * client-supplied `include_usage: false` would let the untrusted party switch off
 * the billing measurement — the exact threat this module exists to close. Any other
 * stream_options the caller set are preserved.
 */
export function withUsageReporting(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.stream !== true) return payload
  const existing =
    typeof payload.stream_options === "object" && payload.stream_options !== null
      ? (payload.stream_options as Record<string, unknown>)
      : {}
  return { ...payload, stream_options: { ...existing, include_usage: true } }
}

/**
 * Tee an upstream response so the caller still gets a fully transparent stream while
 * we read a copy to extract usage.
 *
 * Returns the response to forward plus a promise resolving to the usage (null when
 * absent/unreadable). The promise NEVER rejects — hand it to `ctx.waitUntil`.
 *
 * The forwarded branch is untouched: same status, same headers, same bytes, and the
 * client is never blocked on our read of the other branch.
 */
export function teeForUsage(response: Response): { forward: Response; usage: Promise<ProviderUsage | null> } {
  if (!response.body) return { forward: response, usage: Promise.resolve(null) }
  let clientBranch: ReadableStream<Uint8Array>
  let meterBranch: ReadableStream<Uint8Array>
  let forward: Response
  try {
    ;[clientBranch, meterBranch] = response.body.tee()
    forward = new Response(clientBranch, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch {
    // A null-body status arriving with a body, an out-of-range status, etc. Metering
    // must never cost us the response — hand back the original untouched.
    return { forward: response, usage: Promise.resolve(null) }
  }
  const usage = (async (): Promise<ProviderUsage | null> => {
    try {
      const text = await new Response(meterBranch).text()
      // One parser for both shapes: a streamed body is SSE, a non-streamed body is
      // a single JSON object (which `extractUsageFromSse` won't match, hence the
      // direct-parse fallback).
      const fromSse = extractUsageFromSse(text)
      if (fromSse) return fromSse
      try {
        return readUsageObject(JSON.parse(text))
      } catch {
        return null
      }
    } catch {
      return null
    }
  })()
  return { forward, usage }
}
