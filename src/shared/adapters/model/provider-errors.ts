// SIG-455 (PR B Task 2) — typed provider rate-limit error.
// Leaf: no heavy imports. Used by model adapters to signal 429/503 with a
// structured retryAfterMs so the backpressure layer can react without parsing
// the error message string.

/**
 * Thrown by a model adapter when the upstream provider responds with an HTTP
 * 429 (Too Many Requests) or 503 (Service Unavailable) status. Carries the
 * parsed `Retry-After` delay so callers can apply it directly without re-parsing.
 */
export class ProviderRateLimitError extends Error {
  readonly retryAfterMs: number
  // `declare` avoids useDefineForClassFields initializing `provider` to
  // `undefined` on every instance — we only set it when a value is present.
  declare readonly provider?: string

  constructor(message: string, retryAfterMs: number, provider?: string) {
    super(message)
    this.name = "ProviderRateLimitError"
    this.retryAfterMs = retryAfterMs
    if (provider !== undefined) this.provider = provider
  }
}

/**
 * Type-guard: returns `true` when `e` is a `ProviderRateLimitError` instance.
 */
export function isProviderRateLimit(e: unknown): e is ProviderRateLimitError {
  return e instanceof ProviderRateLimitError
}
