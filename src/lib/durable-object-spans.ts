// SIG-141: detect the line spans of `class X extends DurableObject`
// declarations in changed JS/TS files, parsed from the AST (NOT raw text — a
// regex would false-match the phrase in comments/strings). Used to suppress
// false method-level authz findings ONLY when they land inside a DurableObject
// class body: a DO method is invokable only by the Worker holding the binding,
// so the binding IS the trust boundary. Findings in co-located top-level
// helpers or other classes in the same file are left untouched, so a real
// access-control bug there is still surfaced.

import { parseSource, type SourceExt } from "./ast-rules/parser"
import type { AstCache } from "./ast-rules/parse-cache"
import { walkAst, type AstNode } from "./ast-rules/walker"

const KNOWN_EXTS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
])

function extOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const ext = path.slice(dot).toLowerCase()
  return KNOWN_EXTS.has(ext) ? (ext as SourceExt) : null
}

export interface LineSpan {
  /** 1-based inclusive start line of the class declaration. */
  start: number
  /** 1-based inclusive end line. */
  end: number
}

/** True when a class node's `extends` clause is `DurableObject` or `<ns>.DurableObject`. */
function extendsDurableObject(node: AstNode): boolean {
  const sc = node?.superClass
  if (!sc) return false
  if (sc.type === "Identifier") return sc.name === "DurableObject"
  // `extends cloudflare.DurableObject` / `extends Workers.DurableObject`
  if (sc.type === "MemberExpression") return sc.property?.name === "DurableObject"
  return false
}

/**
 * Map each changed file path → the line spans of its DurableObject class
 * declarations (empty/absent when none). AST-based; files that don't parse or
 * aren't JS/TS are skipped. Never throws.
 */
export function durableObjectClassSpans(
  filesByPath: ReadonlyMap<string, string>,
  astCache?: AstCache,
): Map<string, LineSpan[]> {
  const out = new Map<string, LineSpan[]>()
  for (const [path, src] of filesByPath) {
    const ext = extOf(path)
    if (ext === null) continue
    // SIG-336: parse-once via the shared cache when provided (else direct).
    const parsed = astCache ? astCache.get(path, src, ext) : parseSource(src, ext)
    if (!parsed.ok) continue
    const spans: LineSpan[] = []
    const collect = (n: AstNode): void => {
      if (!extendsDurableObject(n)) return
      const start = n?.loc?.start?.line
      const end = n?.loc?.end?.line
      if (typeof start === "number" && typeof end === "number") spans.push({ start, end })
    }
    walkAst(parsed.ast as AstNode, {
      ClassDeclaration: collect,
      ClassExpression: collect,
    })
    if (spans.length > 0) out.set(path, spans)
  }
  return out
}

/** True when `line` falls inside any of the given DurableObject class spans. */
export function lineInDurableObjectClass(spans: readonly LineSpan[] | undefined, line: number): boolean {
  return (spans ?? []).some((s) => line >= s.start && line <= s.end)
}
