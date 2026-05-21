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
