// A request-body reader that enforces a BYTE cap as the stream is consumed, so an
// oversized body is aborted mid-read rather than fully buffered. Shared by the
// authenticated POST routes (runner ingest, /v1/review): both verify the caller
// from the HEADER first, then read the body through this guard, so an unauthorized
// caller can never force a large buffer. Returns `null` once the cap is exceeded
// (the caller maps that to HTTP 413).

/**
 * Read the request body as text, enforcing a BYTE cap as the stream is consumed
 * (so an oversized body is aborted, not fully buffered). Returns `null` once the
 * cap is exceeded. A cheap Content-Length precheck short-circuits the obvious
 * case; the stream count is the real guard (CL can be absent or lie low).
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const cl = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(cl) && cl > maxBytes) return null
  const body = request.body
  if (!body) {
    const t = await request.text()
    return new TextEncoder().encode(t).byteLength > maxBytes ? null : t
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(merged)
}
