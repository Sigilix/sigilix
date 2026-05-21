// SIG-128: credit orchestrator glue whose new logic delegates to same-PR
// unit-tested helpers, so the tests specialist stops over-firing "needs
// integration tests" on wiring already covered by extracted helper tests.
//
// Pure module, never throws: any failure for a source yields status "none"
// (fail closed — never suppresses a finding). See the design doc for the
// tri-state contract (all = every substantive added line delegates).

import { parseSource, type SourceExt } from "./ast-rules/parser"
import { walkAst, type AstNode } from "./ast-rules/walker"
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
    if (seg === "..") { out.pop(); continue }
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
): HelperBinding[] {
  const parsed = parseSource(code, ext)
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
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false
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
 * Markers: `if`/`for`/`while`/`switch` keywords, `&&`, `||`.
 */
export function hasInlineControlFlow(text: string): boolean {
  if (/\b(if|for|while|switch)\b/.test(text)) return true
  if (text.includes("&&") || text.includes("||")) return true
  return false
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
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${name}(?:[^A-Za-z0-9_$]|$)`).test(text)
}

export interface DetectHelperCoverageArgs {
  filesByPath: ReadonlyMap<string, string>
  addedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>
  siblingMappings: readonly TestingSiblingMapping[]
  testContentByPath: Readonly<Record<string, string>>
}

/**
 * Tri-state helper-coverage per `->NONE` source. `all` => every substantive
 * added line delegates to a same-PR tested helper whose sibling test
 * references the delegated symbol. Fail closed (-> `none`) on any missing
 * input. Never throws.
 */
export function detectHelperCoverage(
  args: DetectHelperCoverageArgs,
): { coverageBySource: Record<string, HelperCoverage> } {
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
  const NONE: HelperCoverage = { status: "none", helpers: [] }
  const content = args.filesByPath.get(source)
  const ext = extOf(source)
  const added = args.addedLineTextByPath.get(source)
  if (typeof content !== "string" || ext === null || !added || added.size === 0) return NONE

  const bindings = extractTestedHelperBindings(source, content, ext, testedHelpers)
  if (bindings.length === 0) return NONE

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

  if (substantive === 0) return NONE
  if (delegating === substantive) return { status: "all", helpers: [...helpers].sort() }
  if (delegating > 0) return { status: "partial", helpers: [...helpers].sort() }
  return NONE
}
