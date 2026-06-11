// SIG-128: credit orchestrator glue whose new logic delegates to same-PR
// unit-tested helpers, so the tests specialist stops over-firing "needs
// integration tests" on wiring already covered by extracted helper tests.
//
// Pure module, never throws: any failure for a source yields status "none"
// (fail closed — never suppresses a finding). See the design doc for the
// tri-state contract (all = every substantive added line delegates).

import { parseSource, walkAst, type SourceExt, type AstCache, type AstNode } from "@/src/features/ast-rules"
import type { TestingSiblingMapping } from "./testing-evidence-pack"

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const

/**
 * A line consisting only of structural close punctuation (and trivia). Used to
 * exclude such lines from the substantive count.
 *
 * Note: the character class also matches a lone opening `(`, so a
 * punctuation-only line is treated as non-substantive; this can only shrink the
 * `all` denominator (leniency-direction), never cause a real finding to be
 * suppressed incorrectly.
 */
const STRUCTURAL_CLOSE_LINE = /^[)}\]( ;,]*$/

export interface HelperCoverage {
  status: "all" | "partial" | "none"
  /** Distinct same-PR tested-helper source paths that contributed delegating lines. */
  helpers: string[]
  /**
   * SIG-128 PR 6: true when the source's added lines structurally resemble
   * orchestrator glue — small (≤12 substantive lines) AND mostly
   * delegation-shaped AND contains at least one free-function call.
   * Fires INDEPENDENTLY of `status`, so a `partial` source (mix of
   * same-PR tested helpers + pre-existing helpers, as in PR #138's
   * `scheduled` handler) can still be suppressed.
   */
  structurallyGlue: boolean
}

function stripCodeExt(p: string): string {
  for (const e of CODE_EXTS) {
    if (p.endsWith(e)) return p.slice(0, -e.length)
  }
  return p
}

/** Normalize a path by resolving `.`/`..` segments. No leading slash. */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join("/")
}

/**
 * Resolve a RELATIVE import specifier (from `importerPath`) to a member of
 * `candidateSources`, or null. Handles extensionless, `.js`->`.ts`, the
 * `.tsx/.mts/.cts` family, and directory `index.*` imports. Bare/package
 * specifiers return null. Ambiguity (!=1 match) -> null (fail closed).
 */
export function resolveImportToRepoPath(
  importerPath: string,
  specifier: string,
  candidateSources: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null
  const dir = importerPath.includes("/") ? importerPath.slice(0, importerPath.lastIndexOf("/")) : ""
  const joined = normalizePath(`${dir}/${specifier}`)
  const target = stripCodeExt(joined)
  const matches = new Set<string>()
  for (const c of candidateSources) {
    const cStem = stripCodeExt(c)
    if (cStem === target) matches.add(c)
    else if (cStem === `${target}/index`) matches.add(c)
  }
  return matches.size === 1 ? [...matches][0]! : null
}

export interface HelperBinding {
  local: string
  imported: string
  helperSource: string
  helperTest: string
}

/**
 * Parse `code` and return bindings imported from same-PR TESTED helper
 * modules (skipping type-only imports). `testedHelpers` maps a tested
 * source path -> its sibling test path. Never throws — parse failure -> [].
 */
export function extractTestedHelperBindings(
  importerPath: string,
  code: string,
  ext: SourceExt,
  testedHelpers: ReadonlyMap<string, string>,
  astCache?: AstCache,
): HelperBinding[] {
  // SIG-336: parse-once via the shared cache when provided (else direct).
  const parsed = astCache ? astCache.get(importerPath, code, ext) : parseSource(code, ext)
  if (!parsed.ok) return []
  const ast = parsed.ast as AstNode
  const candidateSources = new Set(testedHelpers.keys())
  const out: HelperBinding[] = []
  walkAst(ast, {
    ImportDeclaration: (n) => {
      if (n?.importKind === "type") return
      const spec = typeof n?.source?.value === "string" ? n.source.value : ""
      const helperSource = resolveImportToRepoPath(importerPath, spec, candidateSources)
      if (helperSource === null) return
      const helperTest = testedHelpers.get(helperSource)
      if (!helperTest) return
      for (const s of n?.specifiers ?? []) {
        if (s?.importKind === "type") continue
        const local = s?.local?.name
        if (typeof local !== "string" || local.length === 0) continue
        const imported = typeof s?.imported?.name === "string" ? s.imported.name : local
        out.push({ local, imported, helperSource, helperTest })
      }
    },
  })
  return out
}

/**
 * A line carries executable logic worth test-accounting. Excludes imports,
 * type-only declarations, re-exports, comments, blank lines, and pure
 * structural punctuation. Conservative: when unsure, treat as substantive
 * (so genuine logic is never silently excluded from the `all` denominator).
 * Input is the `+`-stripped added-line text (indentation preserved).
 */
export function isSubstantiveAddedLine(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  if (t.startsWith("//") || t.startsWith("/*")) return false
  // A `*` line is a comment continuation/close ONLY when followed by space,
  // `/`, or end — NOT a generator method like `*build()`.
  if (/^\*(\s|\/|$)/.test(t)) return false
  if (STRUCTURAL_CLOSE_LINE.test(t)) return false
  if (/^import\b/.test(t)) return false
  if (/^export\s+(type|interface)\b/.test(t)) return false
  if (/^(type|interface)\s/.test(t)) return false
  if (/^export\s*\{/.test(t)) return false
  return true
}

/**
 * SIG-128 (Codex MEDIUM): a line that calls a tested helper but ALSO contains
 * inline control-flow / boolean logic is NOT pure delegation — it carries
 * untested logic of its own, so it must not count toward `all`. Conservative
 * and FN-safe: when in doubt we DON'T credit (→ partial/none → finding kept).
 * Markers: `if`/`for`/`while`/`switch` keywords, `&&`, `||`, `??`, ternary.
 */
export function hasInlineControlFlow(text: string): boolean {
  if (/\b(if|for|while|switch)\b/.test(text)) return true
  if (text.includes("&&") || text.includes("||")) return true
  if (text.includes("??")) return true // nullish coalescing
  if (/ \? /.test(text)) return true // ternary (spaced; not ?. ?? ?:)
  return false
}

// ─── SIG-128 PR 6: structural orchestrator-glue heuristic ────────
//
// SIG-128's helper-coverage check only credits SAME-PR tested helpers. A
// wrapper that delegates to a mix of same-PR helpers AND pre-existing
// helpers (e.g. PR #138's `scheduled` handler — same-PR
// `runIndexReconciliation` + pre-existing `isIndexerEnabled`) ends up
// status="partial" not "all", so the bot fires anyway despite being
// pure orchestrator glue.
//
// This adds a SECOND suppression path: detect the wrapper structurally
// (small + mostly delegation-shaped lines) regardless of whether the
// delegated-to callees are tested. Tight thresholds keep FN risk low —
// a genuinely-logic-heavy function survives the heuristic and the
// finding stays.

/** Max substantive lines that can count as "small enough to be glue." */
const GLUE_MAX_SUBSTANTIVE = 12

/** Minimum ratio of delegation-shaped substantive lines to count as glue. */
const GLUE_MIN_DELEGATION_RATIO = 0.5

const ARITHMETIC_OPERATOR = /[+\-*/%]=|[A-Za-z_0-9$)\]]\s*[+\-*/%]\s*[A-Za-z_0-9$(]/
const CONTROL_FLOW_KEYWORD =
  /(?:^|[\s{};(])(if|for|while|switch|return|throw|break|continue|try|catch|finally|else|do|await)\b/
const CALL_EXPRESSION = /[A-Za-z_$][\w$.]*\s*\(/
const ASSIGNMENT_KEYWORD = /(?:^|\s)(const|let|var)\s+[A-Za-z_$]/
const METHOD_OR_FUNCTION_HEADER = /(?:^|\s)(async\s+)?(function\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*[:{=]/
const OBJECT_FIELD_NUMERIC_OR_BARE = /^[\s,]*[A-Za-z_$][\w$]*\s*:/

/**
 * SIG-128 PR 6: classify a substantive added line as "delegation-shaped"
 * (call-through / log / control-flow / catch handler) vs business logic
 * (arithmetic / data transformation / multi-step assignment).
 *
 * Delegation-shaped lines:
 *   - pure log statements (`console.log(...)`, `console.error(...)`)
 *   - control-flow keywords + a call (`if (...) {`, `return`, `throw`,
 *     `try {`, `catch (...) {`, `await foo(x)`)
 *   - bare call expressions (`foo(args)`, `obj.method(args)`)
 *   - simple `const/let x = call(...)` with no arithmetic on the RHS
 *   - method/function headers (`async scheduled(_event, env, ctx) {`)
 *
 * NOT delegation-shaped:
 *   - arithmetic expressions (`a + b * c`, `sum += x`)
 *   - object-literal fields with computed values
 *   - chained transformations with no obvious call
 *
 * Pure — exported for tests.
 */
export function isDelegationShapedLine(text: string): boolean {
  const t = text.trim()
  if (t === "") return false

  // Log calls — common in glue, no business logic.
  if (/^console\.\w+\(/.test(t)) return true

  // Method / function header — `async name(...) {` or `function name(...) {`.
  // Always orchestrator-shape; the body's contents are what we evaluate
  // line-by-line.
  if (METHOD_OR_FUNCTION_HEADER.test(t)) return true

  // Bare `}` etc. already filtered by isSubstantiveAddedLine, but extra
  // safety: a `},` or `)` line is not logic.
  if (/^[\s){}\],;]*$/.test(t)) return true

  // Control-flow keyword on the line. But disqualify if there's arithmetic
  // (e.g. `for (let i = 0; i < n; i++) sum += i * 2` is real logic).
  if (CONTROL_FLOW_KEYWORD.test(t)) {
    if (ARITHMETIC_OPERATOR.test(t)) return false
    return true
  }

  // Object-literal field with a non-call RHS — typically computed values,
  // not delegation. (A field whose value is just a call IS delegation; the
  // check below catches that case via CALL_EXPRESSION + !ARITHMETIC.)
  if (OBJECT_FIELD_NUMERIC_OR_BARE.test(t) && !CALL_EXPRESSION.test(t)) {
    return false
  }

  // Simple `const/let foo = call(...)` with no arithmetic on the RHS.
  if (ASSIGNMENT_KEYWORD.test(t)) {
    if (ARITHMETIC_OPERATOR.test(t)) return false
    if (CALL_EXPRESSION.test(t)) return true
    return false
  }

  // Bare expression that's a call.
  if (CALL_EXPRESSION.test(t)) {
    if (ARITHMETIC_OPERATOR.test(t)) return false
    return true
  }

  return false
}

/**
 * Free-function call (lowercase identifier followed by `(`, NOT preceded
 * by `.` or `?.`). Distinguishes `runIndexReconciliation(env, opts)`
 * (delegation to an imported/free function) from `x.toUpperCase()`
 * (method on a local value — work, not delegation). The leading char
 * lookbehind is via a negated character class so we cover string start,
 * whitespace, `(`, `=`, `,` etc.
 *
 * CodeRabbit M1 (review on PR #143): the negative lookahead excludes JS
 * keywords that would otherwise match the identifier pattern — `if (`,
 * `for (`, `while (`, `switch (`, `catch (`, `function (`, `async (`
 * are control-flow / declaration constructs, not free-function calls.
 * Without this guard, `if (x > 0) return "ok"` would satisfy
 * `hasFreeFunctionCall` and incorrectly count as wrapping an external
 * helper.
 */
const FREE_FUNCTION_CALL =
  /(?:^|[^\w$.?])(?!(?:if|for|while|switch|catch|function|async|return|throw|new|typeof|void|yield|await|do|in|of|else|super|import)\b)[a-z_$][\w$]*\s*\(/

/**
 * SIG-128 PR 6: structural orchestrator-glue detector. Returns true when
 * a changed file's added lines form a small + mostly-delegation block —
 * the shape of a wrapper handler around tested helpers. Used by
 * `evaluateTestFinding` to suppress "lacks coverage" false positives on
 * wiring code regardless of whether the delegated-to helpers are
 * same-PR tested (the limitation of `detectHelperCoverage`).
 *
 * Requirements:
 *   - ≤ {@link GLUE_MAX_SUBSTANTIVE} substantive lines
 *   - ≥ {@link GLUE_MIN_DELEGATION_RATIO} of them delegation-shaped
 *   - at least ONE free-function call (the "wraps an external helper"
 *     signal — distinguishes a delegating wrapper from a small
 *     method-only data transformer, which IS work that warrants a test)
 *
 * Pure — exported for tests.
 */
export function isStructurallyOrchestratorGlue(addedLines: ReadonlyMap<number, string>): boolean {
  let substantive = 0
  let delegation = 0
  let hasFreeFunctionCall = false
  for (const [, text] of addedLines) {
    if (!isSubstantiveAddedLine(text)) continue
    substantive += 1
    if (isDelegationShapedLine(text)) delegation += 1
    // Don't count the function's OWN declaration as a free-function call.
    // `function transform(x) {` matches FREE_FUNCTION_CALL via `transform(`,
    // but it's the function being defined, not a call to anything external.
    if (METHOD_OR_FUNCTION_HEADER.test(text)) continue
    if (FREE_FUNCTION_CALL.test(text)) hasFreeFunctionCall = true
  }
  if (substantive === 0) return false
  if (substantive > GLUE_MAX_SUBSTANTIVE) return false
  if (!hasFreeFunctionCall) return false
  return delegation / substantive >= GLUE_MIN_DELEGATION_RATIO
}

const KNOWN_EXTS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

function extOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const e = path.slice(dot).toLowerCase()
  return KNOWN_EXTS.has(e) ? (e as SourceExt) : null
}

/**
 * Whole-token presence of `name` in `text`.
 *
 * Note: this does NOT distinguish code from comments/strings, so a symbol
 * mentioned only in a comment in the helper's test body still counts as a
 * reference — an accepted fail-open leniency (the module errs toward crediting
 * glue; a full lexer would be over-engineering).
 */
function referencesSymbol(text: string, name: string): boolean {
  // Defensive (CodeRabbit): `name` is interpolated into a RegExp. Today's
  // callers pass acorn-parsed identifiers, but guard against regex injection
  // if reused — a non-identifier can't be a real symbol reference anyway.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${name}(?:[^A-Za-z0-9_$]|$)`).test(text)
}

export interface DetectHelperCoverageArgs {
  filesByPath: ReadonlyMap<string, string>
  addedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>
  siblingMappings: readonly TestingSiblingMapping[]
  testContentByPath: Readonly<Record<string, string>>
  /** SIG-336: optional per-review parse-once cache (shared with the other AST
   *  consumers). Absent → parse directly. */
  astCache?: AstCache
}

/**
 * Tri-state helper-coverage per `->NONE` source. `all` => every substantive
 * added line delegates to a same-PR tested helper whose sibling test
 * references the delegated symbol. Fail closed (-> `none`) on any missing
 * input. Never throws.
 */
export function detectHelperCoverage(args: DetectHelperCoverageArgs): {
  coverageBySource: Record<string, HelperCoverage>
} {
  const testedHelpers = new Map<string, string>()
  for (const m of args.siblingMappings) {
    if (m.test !== null && m.test.length > 0) testedHelpers.set(m.source, m.test)
  }
  const noneSources = args.siblingMappings.filter((m) => m.test === null).map((m) => m.source)
  const coverageBySource: Record<string, HelperCoverage> = {}
  for (const source of noneSources) {
    coverageBySource[source] = computeOne(source, testedHelpers, args)
  }
  return { coverageBySource }
}

function computeOne(
  source: string,
  testedHelpers: ReadonlyMap<string, string>,
  args: DetectHelperCoverageArgs,
): HelperCoverage {
  const NONE: HelperCoverage = { status: "none", helpers: [], structurallyGlue: false }
  const content = args.filesByPath.get(source)
  const ext = extOf(source)
  const added = args.addedLineTextByPath.get(source)
  if (typeof content !== "string" || ext === null || !added || added.size === 0) return NONE

  // SIG-128 PR 6: structural orchestrator-glue check runs FIRST + lives
  // alongside the helper-coverage status. It fires INDEPENDENTLY of
  // whether the file imports same-PR tested helpers, so a wrapper that
  // delegates to a mix of same-PR + pre-existing helpers is still caught.
  const structurallyGlue = isStructurallyOrchestratorGlue(added)

  const bindings = extractTestedHelperBindings(source, content, ext, testedHelpers, args.astCache)
  if (bindings.length === 0) {
    return structurallyGlue ? { status: "none", helpers: [], structurallyGlue: true } : NONE
  }

  let substantive = 0
  let delegating = 0
  const helpers = new Set<string>()
  for (const [, text] of added) {
    if (!isSubstantiveAddedLine(text)) continue
    substantive += 1
    // SIG-128 (Codex MEDIUM): a substantive line that mixes a tested-helper
    // call with inline control-flow/boolean logic is NOT pure delegation. It
    // stays in the `substantive` denominator (forcing partial/none) but can
    // never count as delegating. FN-safe: never moves a source up to `all`.
    if (hasInlineControlFlow(text)) continue
    let lineDelegates = false
    for (const b of bindings) {
      if (!referencesSymbol(text, b.local)) continue
      const testBody = args.testContentByPath[b.helperTest]
      if (typeof testBody === "string" && referencesSymbol(testBody, b.imported)) {
        lineDelegates = true
        helpers.add(b.helperSource)
      }
    }
    if (lineDelegates) delegating += 1
  }

  if (substantive === 0) return { ...NONE, structurallyGlue }
  if (delegating === substantive) {
    return { status: "all", helpers: [...helpers].sort(), structurallyGlue }
  }
  if (delegating > 0) {
    return { status: "partial", helpers: [...helpers].sort(), structurallyGlue }
  }
  return { ...NONE, structurallyGlue }
}
