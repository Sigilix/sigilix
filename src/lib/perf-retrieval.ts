// SIG-110 PR B — perf-keyword retrieval query construction.
//
// The generic pre-flight retrieval embeds `title + body`, which biases
// Vectorize toward chunks describing WHAT the PR does. The performance
// specialist wants the opposite: chunks that look like perf
// anti-patterns (hot paths, N+1 loops, blocking I/O, retry storms) and
// the specific functions this PR changed. This module builds a
// differentiated query for the performance role only.
//
// Single Vectorize namespace (one index per repo) means we cannot route
// to a separate "anti-pattern index" — the bias is achieved by SEEDING
// the embedded query text with perf anti-pattern vocabulary + the
// changed function names, so the nearest-neighbour search lands on
// perf-relevant code rather than feature-description chunks.
//
// Pure module: no I/O. The ensemble calls these to build the query
// string it then hands to `retrieveChunks`.

/**
 * Perf anti-pattern vocabulary seeded into the performance specialist's
 * retrieval query. Chosen to pull chunks that exhibit the failure modes
 * the perf lens cares about (per the SIG-110 acceptance criteria).
 */
export const PERF_RETRIEVAL_KEYWORDS: readonly string[] = [
  "hot path",
  "timeout",
  "rate limit",
  "batch",
  "cache",
  "N+1",
  "blocking I/O",
  "unbounded loop",
  "retry backoff",
] as const

/** Max changed function names appended to the query (prompt/embed-size
 *  safety; the embed input is capped at 4k chars downstream anyway). */
const MAX_FUNCTION_NAMES = 20

/**
 * JavaScript/TypeScript keywords that the method-shorthand regex would
 * otherwise mis-capture as "function names" (e.g. `if (`, `for (`,
 * `catch (`). Dropped so the changed-function list stays clean.
 */
const CONTROL_FLOW_STOPWORDS: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "await",
  "const", "let", "var", "else", "do", "with", "throw", "typeof", "new",
  "yield", "case", "void", "delete", "in", "of", "instanceof",
])

// A function-name capture is keyed off the leading group of each regex.
const FUNCTION_PATTERNS: readonly RegExp[] = [
  // `function foo(` / `export function foo(` / `async function foo(`
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/,
  // `const foo = (args) =>` / `const foo = async (args) =>` / `const foo = function`
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  // class / object method shorthand: `foo(args) {` or `async foo(args) {`
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
] as const

/**
 * Extract the names of functions/methods introduced or modified on the
 * ADDED lines of a unified diff. Scans only `+`-prefixed lines (skipping
 * the `+++` file header), applies a small set of declaration patterns,
 * filters control-flow keywords, dedupes (insertion order), and caps the
 * result. Best-effort heuristic — never throws.
 */
export function extractChangedFunctionNames(diff: string): string[] {
  if (!diff) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const rawLine of diff.split("\n")) {
    if (!rawLine.startsWith("+")) continue
    if (rawLine.startsWith("+++")) continue
    // Strip the leading `+` so the method-shorthand `^\s*` anchor sees
    // the real indentation.
    const line = rawLine.slice(1)
    for (const re of FUNCTION_PATTERNS) {
      const m = re.exec(line)
      if (!m) continue
      const name = m[1]
      if (!name || CONTROL_FLOW_STOPWORDS.has(name)) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
      if (out.length >= MAX_FUNCTION_NAMES) return out
    }
  }
  return out
}

/**
 * Build the performance specialist's retrieval query: the base query
 * (title + body) seeded with perf anti-pattern keywords and the changed
 * function names. Guaranteed to differ from the bare base query so the
 * embedded vector lands on perf-relevant code.
 */
export function buildPerfRetrievalQuery(
  baseQuery: string,
  changedFunctionNames: readonly string[],
): string {
  const parts: string[] = []
  const trimmedBase = baseQuery.trim()
  if (trimmedBase.length > 0) parts.push(trimmedBase)
  parts.push(
    `Performance review — look for: ${PERF_RETRIEVAL_KEYWORDS.join(", ")}.`,
  )
  if (changedFunctionNames.length > 0) {
    parts.push(`Changed functions: ${changedFunctionNames.join(", ")}.`)
  }
  return parts.join("\n\n")
}
