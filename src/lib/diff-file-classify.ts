// SIG-91: classify diff files + detect source ↔ test sibling pairs.
//
// Why this exists:
//   The tests specialist (see `prompts/pr-review-specialists.ts`)
//   consistently fired false-positive "module ships without tests"
//   findings on PRs that DO add sibling test files in the same diff
//   (5/6 findings on PR #104, same pattern on PR #98 and PR #100).
//
//   Root cause: the specialist receives the raw unified diff and has
//   to scan it itself to figure out which files are tests + which
//   sources they cover. The prompt biases the model to fire HARD on
//   "no test files changed" but doesn't ground it on the diff's
//   actual file shape. Models — especially the lighter
//   `deepseek-v4-flash` running this lens — miss the pairing when
//   reading a 12K-token diff.
//
//   Fix: pre-classify the file list deterministically + render the
//   sibling mapping as a labeled block at the top of the specialist
//   message. The model can't ignore what's explicitly stated.
//
// Recognized test patterns (loosely modeled on Vitest / Jest defaults
// + the conventions used across this repo + rubberfit + sigilix):
//   - tests/<name>.test.ts          (this repo's convention)
//   - tests/<dir>/<name>.test.ts    (nested tests/)
//   - <dir>/__tests__/<name>.test.ts
//   - <dir>/<name>.test.ts          (sibling-of-source variant)
//   - <dir>/<name>.spec.ts          (Jest-style)
// Extensions: .ts / .tsx / .js / .jsx / .mjs / .cts / .mts
//
// Sibling resolution heuristic:
//   For a test path `tests/foo.test.ts`, the candidate source paths
//   considered (in priority order) are:
//     - src/foo.ts | src/lib/foo.ts | src/lib/foo.tsx | app/foo.ts | …
//   For a test path `src/lib/foo.test.ts`, the source is `src/lib/foo.ts`.
//   The classifier returns the FIRST candidate that is also present in
//   the diff's file list (so we only report pairs that actually
//   co-occur in this PR — never speculatively cross-reference files
//   the model can't see).

/**
 * Kind classification for a single file path.
 *
 * - `test`   — recognised test file (matches a test path/extension pattern)
 * - `source` — a source file in `src/`, `app/`, `lib/`, `workers/`, etc.
 *              that ISN'T also a test file
 * - `docs`   — Markdown/MDX/AsciiDoc/text documentation
 * - `config` — config files (package.json, tsconfig, eslint, wrangler, etc.)
 * - `other`  — anything else (assets, generated files, snapshots)
 */
export type DiffFileKind = "source" | "test" | "docs" | "config" | "other"

export interface ClassifiedDiffFile {
  path: string
  kind: DiffFileKind
  /** For `source` files: matching test file in the SAME diff, or null. */
  testsSibling: string | null
  /** For `test` files: matching source file in the SAME diff, or null. */
  sourceSibling: string | null
}

const TEST_EXT_RE = /\.(test|spec)\.(?:m|c)?[jt]sx?$/i
const CODE_EXT_RE = /\.(?:m|c)?[jt]sx?$/i
const DOCS_EXT_RE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i
const CONFIG_FILE_RE =
  /^(?:package\.json|package-lock\.json|tsconfig(?:\.[\w.-]+)?\.json|vitest\.config\.[mc]?[jt]s|wrangler\.(?:toml|jsonc?)|eslint\.config\.[mc]?[jt]s|\.eslintrc(?:\.[\w.-]+)?|\.gitignore|\.prettierrc(?:\.[\w.-]+)?|README\.md)$/i

function isTestPath(path: string): boolean {
  if (TEST_EXT_RE.test(path)) return true
  // Bare `tests/foo.ts` (no `.test.`) and `__tests__/foo.ts` are also
  // recognised as test files — common convention in JS projects.
  if (/(^|\/)tests\//.test(path) && CODE_EXT_RE.test(path)) return true
  if (/(^|\/)__tests__\//.test(path) && CODE_EXT_RE.test(path)) return true
  return false
}

export function classifyKind(path: string): DiffFileKind {
  if (isTestPath(path)) return "test"
  const base = path.split("/").pop() ?? path
  if (CONFIG_FILE_RE.test(base)) return "config"
  if (DOCS_EXT_RE.test(path)) return "docs"
  if (CODE_EXT_RE.test(path)) return "source"
  return "other"
}

/**
 * Strip the test marker from a test path to derive the bare module
 * stem. Returns the input unchanged if no test marker is present.
 *
 * Examples:
 *   tests/foo.test.ts        → tests/foo.ts
 *   tests/lib/foo.test.ts    → tests/lib/foo.ts
 *   src/lib/foo.spec.ts      → src/lib/foo.ts
 *   src/lib/__tests__/foo.ts → src/lib/__tests__/foo.ts (no marker change;
 *                              dir-stripping is handled in candidate
 *                              generation, not here)
 */
function stripTestMarker(testPath: string): string {
  return testPath.replace(/\.(test|spec)(\.(?:m|c)?[jt]sx?)$/i, "$2")
}

/**
 * Build the ordered list of source paths a given test path could be a
 * sibling for. Order = priority; the first match against the diff's
 * file set wins.
 */
function candidateSources(testPath: string): string[] {
  const candidates: string[] = []
  const stripped = stripTestMarker(testPath)

  // Same-directory sibling: tests/foo.test.ts → tests/foo.ts. Most
  // useful when the test sits alongside source (Jest co-located style).
  if (stripped !== testPath) {
    candidates.push(stripped)
  }

  // `tests/<rest>` → `src/<rest>`, `src/lib/<rest>`, `app/<rest>`, …
  const testsPrefix = stripped.match(/^(?:.*\/)?tests\/(.+)$/)
  if (testsPrefix && testsPrefix[1]) {
    const rest = testsPrefix[1]
    for (const sourceRoot of ["src", "src/lib", "app", "lib", "workers"]) {
      candidates.push(`${sourceRoot}/${rest}`)
    }
    // Also consider bare `<rest>` (in case the repo has source at the root).
    candidates.push(rest)
  }

  // `<dir>/__tests__/<name>.ts` → `<dir>/<name>.ts`
  // AND `__tests__/<name>.ts` (root-level) → `<name>.ts`, `src/<name>.ts`, …
  // The parent-directory capture is optional so root-level `__tests__/`
  // also resolves to a sibling source — was missing pre-fix, causing
  // `__tests__/foo.test.ts` to never pair with any in-diff source.
  const dunderTests = stripped.match(/^(?:(.+)\/)?__tests__\/([^/]+)$/)
  if (dunderTests && dunderTests[2]) {
    const parent = dunderTests[1]
    const name = dunderTests[2]
    if (parent !== undefined) {
      candidates.push(`${parent}/${name}`)
    } else {
      // Root-level: expand across typical source roots, mirroring the
      // `tests/<rest>` branch above.
      candidates.push(name)
      for (const sourceRoot of ["src", "src/lib", "app", "lib", "workers"]) {
        candidates.push(`${sourceRoot}/${name}`)
      }
    }
  }

  // De-dup while preserving order.
  return Array.from(new Set(candidates))
}

/**
 * Extract the leaf module stem from a source path:
 *   src/lib/foo.ts             → "foo"
 *   src/lib/triage-pr-overview.ts → "triage-pr-overview"
 *   tests/foo.test.ts          → "foo"           (test marker stripped)
 *   tests/triage-pr-foo-bar.test.ts → "triage-pr-foo-bar"
 *
 * Used by the prefix-stem fallback to pair `<source>.ts` with
 * `tests/<source>-<variant>.test.ts` — a common convention for
 * integration tests that exercise specific code paths of one module
 * with a descriptive suffix.
 */
function leafStem(path: string): string {
  const base = path.split("/").pop() ?? path
  // Strip .test./.spec. marker AND the trailing extension.
  return base
    .replace(/\.(test|spec)\.(?:m|c)?[jt]sx?$/i, "")
    .replace(/\.(?:m|c)?[jt]sx?$/i, "")
}

function normalizeRepoPathForSiblingMatch(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "")
}

function appendRepoSiblingSourceCandidates(
  candidates: string[],
  prefix: string | undefined,
  rest: string,
): void {
  if (prefix !== undefined) {
    candidates.push(`${prefix}/${rest}`)
    for (const sourceRoot of ["src", "src/lib", "app", "lib", "workers"]) {
      candidates.push(`${prefix}/${sourceRoot}/${rest}`)
    }
    return
  }

  for (const sourceRoot of ["src", "src/lib", "app", "lib", "workers"]) {
    candidates.push(`${sourceRoot}/${rest}`)
  }
  candidates.push(rest)
}

function repoWideCandidateSources(testPath: string): string[] {
  const candidates: string[] = []
  const stripped = stripTestMarker(testPath)

  if (
    stripped !== testPath &&
    !/(^|\/)(?:tests|__tests__)\//.test(stripped)
  ) {
    candidates.push(stripped)
  }

  const testsPrefix = stripped.match(/^(?:(.+)\/)?tests\/(.+)$/)
  if (testsPrefix && testsPrefix[2]) {
    appendRepoSiblingSourceCandidates(candidates, testsPrefix[1], testsPrefix[2])
  }

  const dunderTests = stripped.match(/^(?:(.+)\/)?__tests__\/([^/]+)$/)
  if (dunderTests && dunderTests[2]) {
    const parent = dunderTests[1]
    if (parent !== undefined) {
      candidates.push(`${parent}/${dunderTests[2]}`)
    } else {
      appendRepoSiblingSourceCandidates(candidates, undefined, dunderTests[2])
    }
  }

  return Array.from(new Set(candidates))
}

function matchesSourceForTestPath(sourcePath: string, testPath: string): boolean {
  const normalizedSource = normalizeRepoPathForSiblingMatch(sourcePath)
  const normalizedTest = normalizeRepoPathForSiblingMatch(testPath)
  return repoWideCandidateSources(normalizedTest).includes(normalizedSource)
}

/**
 * Resolve whether a source file has an already-existing repo-wide test
 * sibling. Returns a path only for one unambiguous recognized test match;
 * no match or multiple plausible matches both fail open as `null`.
 */
export function findExistingTestSiblingForSource(
  sourcePath: string,
  repoPaths: readonly string[],
): string | null {
  const normalizedSource = normalizeRepoPathForSiblingMatch(sourcePath)
  if (normalizedSource.length === 0) return null

  const matches = new Set<string>()
  for (const rawPath of repoPaths) {
    const path = normalizeRepoPathForSiblingMatch(rawPath)
    if (path.length === 0) continue
    if (!isTestPath(path)) continue
    if (matchesSourceForTestPath(normalizedSource, path)) matches.add(path)
  }

  return matches.size === 1 ? [...matches][0]! : null
}

/**
 * Classify every path in a diff's file list + cross-link source/test
 * siblings present in the SAME diff.
 *
 * Pure function — no I/O, no filesystem reads. The classification only
 * considers paths in `paths`; a sibling that exists on disk but isn't
 * in the diff is NOT reported (the model only sees the diff, so
 * out-of-diff existence claims would be unverifiable from its side).
 */
export function classifyDiffFiles(
  paths: readonly string[],
): ClassifiedDiffFile[] {
  const pathSet = new Set(paths)
  const initial: Array<{ path: string; kind: DiffFileKind }> = paths.map((p) => ({
    path: p,
    kind: classifyKind(p),
  }))

  // First pass: for each test, find the first candidate source that
  // is also in the diff.
  const testToSource = new Map<string, string>()
  for (const { path, kind } of initial) {
    if (kind !== "test") continue
    for (const candidate of candidateSources(path)) {
      if (pathSet.has(candidate)) {
        testToSource.set(path, candidate)
        break
      }
    }
  }

  // SIG-141: basename-stem fallback. A test still without a source sibling
  // pairs with any source in the diff sharing its EXACT leaf stem. This covers
  // source files in subdirectories candidateSources() doesn't enumerate (e.g.
  // `src/do/`, `src/prompts/`) — the gap that produced a false "no test
  // coverage" on `src/do/repo-graph.ts` despite `tests/repo-graph.test.ts`
  // existing. Exact-stem (not prefix), so it can't over-match.
  for (const { path, kind } of initial) {
    if (kind !== "test" || testToSource.has(path)) continue
    const tStem = leafStem(path)
    const src = initial.find((f) => f.kind === "source" && leafStem(f.path) === tStem)
    if (src) testToSource.set(path, src.path)
  }

  // Second pass: invert to source → test. Multiple tests for one
  // source: the first-seen wins (deterministic = input order).
  const sourceToTest = new Map<string, string>()
  for (const [test, source] of testToSource) {
    if (!sourceToTest.has(source)) sourceToTest.set(source, test)
  }

  // Third pass — prefix-stem fallback: for any SOURCE still without a
  // sibling, look for a test file in the diff whose leaf stem starts
  // with the source's leaf stem followed by `-` or `_`. This catches
  // the `triage-pr-overview.ts` ↔ `tests/triage-pr-overview-stale-head.test.ts`
  // convention — a single source module with multiple suffixed
  // integration tests. Stem must be ≥ 4 chars to avoid pathological
  // matches on tiny stems (`io.ts` matching `io-loop.test.ts` is
  // probably correct; `a.ts` matching `a-anything.test.ts` is not).
  const MIN_STEM_LEN = 4
  const sources = initial.filter((f) => f.kind === "source")
  const tests = initial.filter((f) => f.kind === "test")
  for (const src of sources) {
    if (sourceToTest.has(src.path)) continue
    const srcStem = leafStem(src.path)
    if (srcStem.length < MIN_STEM_LEN) continue
    const match = tests.find((t) => {
      const tStem = leafStem(t.path)
      if (!tStem.startsWith(`${srcStem}-`) && !tStem.startsWith(`${srcStem}_`)) {
        return false
      }
      // Don't steal a test that's already paired with a stricter
      // match — preserves the first-pass primary pairings.
      const alreadyPaired = testToSource.get(t.path)
      return alreadyPaired === undefined || alreadyPaired === src.path
    })
    if (match) {
      sourceToTest.set(src.path, match.path)
      // Don't write back to testToSource: the prefix-match test may
      // legitimately also cover a stricter sibling already paired
      // above. Leave the test's primary sibling pointing at the
      // stricter match.
      if (!testToSource.has(match.path)) {
        testToSource.set(match.path, src.path)
      }
    }
  }

  return initial.map(({ path, kind }) => ({
    path,
    kind,
    testsSibling: kind === "source" ? sourceToTest.get(path) ?? null : null,
    sourceSibling: kind === "test" ? testToSource.get(path) ?? null : null,
  }))
}

/**
 * Render a labeled block describing the diff's source/test file
 * structure — designed to be injected at the top of the tests
 * specialist's user message so the model treats sibling-coverage as
 * a stated fact rather than something it has to derive.
 *
 * The block is empty (returns "") when the diff contains no source
 * AND no test files (e.g. pure docs / config PR) — keeps the prompt
 * lean for cases where the classification adds no signal.
 */
export function renderDiffFileClassificationBlock(
  classified: readonly ClassifiedDiffFile[],
): string {
  const sources = classified.filter((f) => f.kind === "source")
  const tests = classified.filter((f) => f.kind === "test")
  if (sources.length === 0 && tests.length === 0) return ""

  const lines: string[] = [
    "[DIFF FILE CLASSIFICATION — authoritative; computed from the diff before specialist dispatch]",
    "",
  ]

  if (sources.length > 0) {
    lines.push(`Source files in this diff (${sources.length}):`)
    for (const f of sources) {
      const sibling = f.testsSibling
        ? `  ← covered by test file in this diff: \`${f.testsSibling}\``
        : `  ← no sibling test file in this diff`
      lines.push(`- \`${f.path}\`${sibling}`)
    }
    lines.push("")
  }

  if (tests.length > 0) {
    lines.push(`Test files in this diff (${tests.length}):`)
    for (const f of tests) {
      const sibling = f.sourceSibling
        ? `  → covers source file in this diff: \`${f.sourceSibling}\``
        : `  → no sibling source file in this diff (may cover code outside the diff)`
      lines.push(`- \`${f.path}\`${sibling}`)
    }
    lines.push("")
  }

  const sourcesWithoutSibling = sources.filter((s) => s.testsSibling === null).length
  if (sourcesWithoutSibling > 0 && tests.length > 0) {
    lines.push(
      `${sourcesWithoutSibling} source file(s) above show "no sibling test file in this diff" by the stem-matching heuristic — BUT ${tests.length} test file(s) ARE present in this PR. Before flagging any such source as "module ships without tests", check whether one of the test files above plausibly exercises it (different filename stem, integration-style test, composite test). If yes, do NOT fire a missing-tests finding.`,
    )
    lines.push("")
  }

  lines.push(
    "Use this classification when reasoning about test coverage. A `\"module ships without tests\"` finding is ONLY admissible when the source file has `no sibling test file in this diff` AND the diff actually changes the source (new file or substantial edit) AND no other test file in this diff plausibly covers it. Do NOT flag a source file as untested when its row above shows a covering test file.",
  )

  return lines.join("\n")
}
