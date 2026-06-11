// SIG-121 (SIG-109 PR B): symbol-based retrieval for the logic specialist.
//
// The generic preflight retrieval embeds PR title+body — chunks matched on
// what the PR DESCRIBES. The logic specialist instead wants local codebase
// context for the SYMBOLS the PR changed: the functions/methods/classes/
// exported consts whose body intersects an added line (even when the
// declaration line itself didn't change). We extract those via the existing
// acorn AST infra and embed them as a second, AUGMENTING retrieval query.
//
// Pure module: no I/O. AST extraction with a regex fallback on parse failure
// (per Codex sign-off §2). Single Vectorize namespace → the bias is via query
// terms, not a separate index.

import {
  parseSource,
  walkAst,
  nodeOverlapsChanged,
  type SourceExt,
  type AstNode,
  type ChangedLines,
} from "@/src/features/ast-rules"
import type { RetrievedChunk } from "./retrieval"

const MAX_SYMBOLS = 30
const KNOWN_EXTS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"])

function extOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const ext = path.slice(dot).toLowerCase()
  return KNOWN_EXTS.has(ext) ? (ext as SourceExt) : null
}

/** Best-effort regex fallback: declared names on the file's ADDED lines.
 *  Used only when AST parse fails. */
function regexFallbackSymbols(src: string, addedLines: Set<number>): string[] {
  const out: string[] = []
  const lines = src.split("\n")
  const re = /\b(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/
  for (const ln of addedLines) {
    const line = lines[ln - 1]
    if (typeof line !== "string") continue
    const m = re.exec(line)
    const name = m?.[1] ?? m?.[2]
    if (name) out.push(name)
  }
  return out
}

/**
 * Extract the names of functions / methods / classes / exported consts whose
 * source range intersects an added line, across all changed JS/TS files.
 * AST-based; regex fallback per file on parse failure. Deduped (insertion
 * order), capped at MAX_SYMBOLS. Never throws.
 */
export function extractChangedSymbols(filesByPath: ReadonlyMap<string, string>, changed: ChangedLines): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (name: unknown): void => {
    if (typeof name !== "string" || name.length === 0) return
    if (seen.has(name)) return
    seen.add(name)
    out.push(name)
  }
  for (const [path, src] of filesByPath) {
    if (out.length >= MAX_SYMBOLS) break
    const set = changed.get(path)
    if (!set || set.size === 0) continue
    const ext = extOf(path)
    if (ext === null) continue
    const parsed = parseSource(src, ext)
    if (!parsed.ok) {
      for (const n of regexFallbackSymbols(src, set)) push(n)
      continue
    }
    const overlaps = (node: AstNode): boolean => {
      const s = node?.loc?.start?.line
      const e = node?.loc?.end?.line
      if (typeof s !== "number" || typeof e !== "number") return false
      return nodeOverlapsChanged(changed, path, s, e)
    }
    walkAst(parsed.ast as AstNode, {
      FunctionDeclaration: (n) => {
        if (overlaps(n)) push(n?.id?.name)
      },
      ClassDeclaration: (n) => {
        if (overlaps(n)) push(n?.id?.name)
      },
      MethodDefinition: (n) => {
        if (!overlaps(n)) return
        // `key.name` for identifier keys; `key.value` for string-literal keys.
        push(n?.key?.name ?? (typeof n?.key?.value === "string" ? n.key.value : undefined))
      },
      ExportNamedDeclaration: (n) => {
        const decl = n?.declaration
        if (!decl || decl.type !== "VariableDeclaration") return
        for (const d of decl.declarations ?? []) {
          if (overlaps(d) && d?.id?.type === "Identifier") push(d.id.name)
        }
      },
    })
  }
  return out.slice(0, MAX_SYMBOLS)
}

/**
 * Build the logic specialist's symbol-retrieval query. Empty string when
 * there are no symbols (caller skips the retrieval entirely).
 */
export function buildSymbolRetrievalQuery(symbols: readonly string[]): string {
  if (symbols.length === 0) return ""
  return `Logic review — local definitions and call sites for the changed symbols: ${symbols.join(", ")}.`
}

/** Stable chunk identity for overlap measurement. */
function chunkId(c: RetrievedChunk): string {
  return `${c.path}:${c.lineStart}-${c.lineEnd}`
}

export interface ChunkOverlap {
  sharedCount: number
  symbolCount: number
  intersectionCount: number
  /** |shared ∩ symbol| / |shared ∪ symbol|; 0 when either side empty. */
  jaccard: number
}

/** Compute overlap telemetry between the shared and symbol chunk sets. */
export function computeChunkOverlap(
  shared: readonly RetrievedChunk[],
  symbol: readonly RetrievedChunk[],
): ChunkOverlap {
  const sharedIds = new Set(shared.map(chunkId))
  const symbolIds = new Set(symbol.map(chunkId))
  let intersection = 0
  for (const id of symbolIds) if (sharedIds.has(id)) intersection += 1
  const union = sharedIds.size + symbolIds.size - intersection
  return {
    sharedCount: sharedIds.size,
    symbolCount: symbolIds.size,
    intersectionCount: intersection,
    jaccard: union === 0 ? 0 : intersection / union,
  }
}

/**
 * Gate: run symbol retrieval only when the env flag is "on", the logic
 * specialist is in the lineup, and the retrieve budget leaves room for
 * this call PLUS the synth conflict-verification reserve.
 *
 * Threshold vs `shouldRunPerfRetrieval`'s `> 2`: perf checks its budget
 * BEFORE any retrieval consumes (it fires concurrently with preflight),
 * so `> 2` there means maxCalls >= 3. Symbol retrieval is checked AFTER
 * preflight (and perf, if any) have already consumed, so `budgetRemaining`
 * is the count STILL FREE at that point. We need 1 for this call + 1
 * reserved for synth ⇒ `budgetRemaining > 1` (>= 2). At the default
 * maxCalls=3 this fires for a logic-only PR (preflight took 1, leaving 2)
 * and correctly defers when a perf pass also ran (leaving 1).
 */
export function shouldRunSymbolRetrieval(
  flag: string | undefined,
  specialists: readonly string[],
  budgetRemaining: number,
): boolean {
  return (flag ?? "").trim().toLowerCase() === "on" && specialists.includes("logic") && budgetRemaining > 1
}

/**
 * AUGMENT the logic role's snapshot: shared preflight snapshot first, then
 * the symbol-derived block (do NOT replace — per Codex sign-off §2). Either
 * side may be empty.
 */
export function mergeLogicSnapshot(sharedSnapshot: string, symbolSnapshot: string): string {
  if (symbolSnapshot.length === 0) return sharedSnapshot
  if (sharedSnapshot.length === 0) return symbolSnapshot
  return `${sharedSnapshot}\n\n[LOGIC SYMBOL CONTEXT — local code for changed symbols]\n${symbolSnapshot}`
}
