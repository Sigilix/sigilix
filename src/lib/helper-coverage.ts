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
  const candidateSources = new Set(testedHelpers.keys())
  const out: HelperBinding[] = []
  walkAst(parsed.ast as AstNode, {
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
  if (/^[)}\]( ;,]*$/.test(t)) return false
  if (/^import\b/.test(t)) return false
  if (/^export\s+(type|interface)\b/.test(t)) return false
  if (/^(type|interface)\s/.test(t)) return false
  if (/^export\s*\{/.test(t)) return false
  return true
}
