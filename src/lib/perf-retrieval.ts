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
  // not control-flow, but `constructor(...) {` is method-shaped noise.
  "constructor",
])

// A function-name capture is keyed off the leading group of each regex.
// All character classes are negated single-char (`[^=]`, `[^{]`, `[^)]`)
// so the patterns are linear — no ReDoS. The optional TypeScript
// type-annotation groups (`: Type`) are non-capturing and never touch
// group 1 (the name), so even when an exotic annotation makes the
// overall match fail, the worst case is a missed name in a retrieval
// query — never a wrong capture.
const FUNCTION_PATTERNS: readonly RegExp[] = [
  // `function foo(` / `export function foo(` / `async function foo(`
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/,
  // `const foo = (args) =>` / `const foo = async (args) =>` /
  // `const foo = function` — plus an optional `: Type` annotation on
  // the binding and an optional `: ReturnType` before the arrow, so
  // TS-typed declarations (`const handler: EventHandler = (e) => {`)
  // are captured.
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  // class / object method shorthand: `foo(args) {`, `async foo(args) {`,
  // or with a TS return-type annotation `foo(args): Promise<T> {`.
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/,
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

/**
 * Decide whether the ensemble should fire the perf-keyword retrieval.
 * Extracted from the orchestrator (which is too large to exercise in
 * isolation — same rationale as `buildFactsByRole`) so the gate is
 * directly unit-testable.
 *
 * Fires only when:
 *   - the performance specialist is in the router's lineup, AND
 *   - the retrieve budget has room for preflight + perf + the synth
 *     conflict-verification reserve. `budgetRemaining` is read BEFORE
 *     any retrieval consumes (the cache consumes only after an internal
 *     `await`), so `> 2` means `maxCalls >= 3` (the default) — leaving
 *     one call for the synth conflict-verification path the
 *     shared preflight retrieval. A repo that lowers the budget to 2
 *     degrades cleanly to the shared snapshot.
 */
export function shouldRunPerfRetrieval(
  specialists: readonly string[],
  budgetRemaining: number,
): boolean {
  return specialists.includes("performance") && budgetRemaining > 2
}

/**
 * Resolve the performance specialist's retrieval snapshot: use the
 * perf-biased snapshot when it has content, else fall back to the
 * shared preflight snapshot so the perf role is never worse off than
 * the others. Extracted for unit-testability.
 */
export function resolvePerfSnapshot(
  formattedPerf: string,
  sharedSnapshot: string,
): string {
  return formattedPerf.length > 0 ? formattedPerf : sharedSnapshot
}

/**
 * Pick the retrieval snapshot a given specialist role sees: the
 * performance role gets the perf-biased snapshot, every other role gets
 * the shared preflight snapshot. This is the one intentional exception
 * to the "all specialists see the same snapshot" invariant. Extracted
 * from the orchestrator's per-role message builder so the per-role
 * selection contract is unit-testable in isolation.
 */
export function selectRetrievalSnapshotForRole(
  role: string,
  perfSnapshot: string,
  sharedSnapshot: string,
): string {
  return role === "performance" ? perfSnapshot : sharedSnapshot
}
