// SIG-317 Part 4b: the EVIDENCE INJECTOR — cross-function asymmetry analysis.
//
// The remaining hard-subtle misses (over-credit / over-refund bypassing a guard
// helper) have NO structural signature you can FP-safely FLAG. But you CAN
// deterministically surface a FACT for the logic specialist to reason about — and
// a fact can't be a false positive. This is the SIG-286 graph-expansion
// philosophy aimed at the recall frontier: turn an open-ended "find the
// over-credit bug" task into a grounded "explain why this asymmetry is safe, or
// flag it" task.
//
// THE ASYMMETRY (pr/10 D8 + pr/11 D8): a function INSERTs/UPDATEs the SAME COLUMN
// an aggregation helper SUMs, but does NOT call that helper. pr/10:
// `refundsTotal()` does `SELECT SUM(amount_cents) FROM refunds`, and `refundCharge`
// does `INSERT INTO refunds (charge_id, amount_cents) …` without calling
// `refundsTotal` → it refunds the full amount, ignoring prior refunds. The
// COLUMN match (the mutator writes the very column the helper sums) is what keeps
// this precise — it excludes status-only updates, audit-log inserts, and helpers
// that aggregate a different column (the dominant noise classes — dual review).
//
// Pure string analysis. Comments blanked for everything; SQL lives inside string
// literals so the SQL extraction reads `body` (strings KEPT), while function-CALL
// detection reads a strings-also-blanked corpus (so a helper name in a doc string
// isn't counted as a call). Output is a HINT string injected into the logic
// specialist's prompt — never a posted finding, so FP-safe by construction; the
// model is the trust authority. Cross-file WITHIN THE PR DIFF (an unchanged,
// pre-existing helper isn't visible — a known v1 recall limit; a future version
// can feed the SIG-138 graph corpus).

export interface AsymmetryHint {
  /** The fact, phrased for the logic specialist to judge. */
  message: string
  /** The bypassing function + the helper it skipped (telemetry / dedupe). */
  fn: string
  helper: string
}

/** Escape a source-derived identifier before interpolating it into a RegExp
 *  (a `$` in a name would otherwise be an anchor — code-review H1). */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const norm = (t: string): string => t.replace(/_/g, "").toLowerCase().split(".").pop()!

/** Blank `//` and `/* *​/` comments to spaces (length-preserving). `alsoStrings`
 *  additionally blanks string/template bodies — used for the call-count corpus
 *  so a name inside a SQL/doc string isn't read as a function call. */
function blank(src: string, alsoStrings = false): string {
  const out = src.split("")
  const n = src.length
  let i = 0
  let inStr: string | null = null
  while (i < n) {
    const c = src[i]!
    if (inStr) {
      if (c === "\\") { if (alsoStrings) { out[i] = " "; if (i + 1 < n) out[i + 1] = " " } i += 2; continue }
      if (alsoStrings && c !== "\n") out[i] = " "
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; if (alsoStrings) out[i] = " "; i++; continue }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") { out[i] = " "; i++ } continue }
    if (c === "/" && src[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] !== "\n") out[i] = " "; i++ }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2 }
      continue
    }
    i++
  }
  return out.join("")
}

/** A named `function NAME(...)` declaration (decl form — the helpers + mutators
 *  in practice are named declarations). Group 1 = name. */
const FN_DECL_RE = /(?:^|[^.\w$])function\s+([A-Za-z_$][\w$]*)\s*\(/g

interface FnInfo { name: string; body: string }

/** Extract named functions + their brace-balanced bodies from one comment-
 *  blanked source. */
function extractFunctions(blanked: string): FnInfo[] {
  const fns: FnInfo[] = []
  for (const m of blanked.matchAll(FN_DECL_RE)) {
    let i = (m.index ?? 0) + m[0].length
    let paren = 1
    while (i < blanked.length && paren > 0) {
      if (blanked[i] === "(") paren++
      else if (blanked[i] === ")") paren--
      i++
    }
    while (i < blanked.length && blanked[i] !== "{" && blanked[i] !== ";") i++
    if (blanked[i] !== "{") continue
    let depth = 0
    const start = i
    for (; i < blanked.length; i++) {
      if (blanked[i] === "{") depth++
      else if (blanked[i] === "}") { depth--; if (depth === 0) break }
    }
    fns.push({ name: m[1]!, body: blanked.slice(start, i + 1) })
  }
  return fns
}

/** The (table, column) an aggregation helper SUM/COUNTs — `SELECT … SUM|COUNT(col)
 *  … FROM table`. Requires a plain column arg + a single `FROM` with NO JOIN/UNION
 *  (an ambiguous multi-table aggregate could mis-attribute — code-review M2). Null
 *  when the body isn't such a helper. */
function aggregateTarget(body: string): { table: string; column: string } | null {
  const agg = /\b(?:sum|count)\s*\(\s*(?:distinct\s+)?([A-Za-z_$][\w$.]*)\s*\)/i.exec(body)
  if (!agg) return null
  if (/\bjoin\b|\bunion\b/i.test(body)) return null
  const from = /\bfrom\s+([A-Za-z_$][\w$.]*)/i.exec(body)
  if (!from) return null
  return { table: norm(from[1]!), column: norm(agg[1]!) }
}

/** Does `body` WRITE `column` into `table` — `INSERT INTO table (… column …)` or
 *  `UPDATE table SET … column = …`? This column match is the FP-safety core: a
 *  mutator that doesn't touch the summed column is not an over-credit risk. */
function writesColumnInto(body: string, table: string, column: string): boolean {
  for (const m of body.matchAll(/\binsert\s+into\s+([A-Za-z_$][\w$.]*)\s*\(([^)]*)\)/gi)) {
    if (norm(m[1]!) !== table) continue
    if (m[2]!.split(",").some((c) => norm(c.trim() || "x") === column)) return true
  }
  for (const m of body.matchAll(/\bupdate\s+([A-Za-z_$][\w$.]*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|;|["'`]|$)/gi)) {
    if (norm(m[1]!) !== table) continue
    for (const a of m[2]!.matchAll(/([A-Za-z_$][\w$]*)\s*=/g)) if (norm(a[1]!) === column) return true
  }
  return false
}

/** Does `codeBody` (strings already blanked) call `name`? */
function callsFunction(codeBody: string, name: string): boolean {
  return new RegExp(`\\b${esc(name)}\\s*\\(`).test(codeBody)
}

/**
 * Analyse all changed files for the over-credit/over-refund "bypassed the guard
 * helper" asymmetry, returning hints for the logic specialist. Pure.
 */
export function analyzeHelperBypass(filesByPath: ReadonlyMap<string, string>): AsymmetryHint[] {
  const fns: Array<FnInfo & { code: string }> = []
  let callCorpus = "" // strings+comments blanked → for call detection only
  for (const source of filesByPath.values()) {
    const commentsBlanked = blank(source) // strings KEPT (SQL is in strings)
    const allBlanked = blank(source, true) // strings ALSO blanked (calls only)
    for (const f of extractFunctions(commentsBlanked)) fns.push({ ...f, code: blank(f.body, true) })
    callCorpus += "\n" + allBlanked
  }
  if (fns.length === 0) return []

  // Aggregation helpers: name -> { table, column }.
  const helpers = new Map<string, { table: string; column: string }>()
  for (const f of fns) {
    const t = aggregateTarget(f.body)
    if (t) helpers.set(f.name, t)
  }
  if (helpers.size === 0) return []

  const hints: AsymmetryHint[] = []
  const seen = new Set<string>()
  for (const [helper, { table, column }] of helpers) {
    // Helper must be CALLED somewhere (calls minus its own declaration(s) > 0),
    // counted on the strings-blanked corpus so a name in a doc/SQL string doesn't
    // inflate it (code-review L2).
    const calls = (callCorpus.match(new RegExp(`\\b${esc(helper)}\\s*\\(`, "g")) ?? []).length
    const decls = (callCorpus.match(new RegExp(`function\\s+${esc(helper)}\\s*\\(`, "g")) ?? []).length
    if (calls - decls <= 0) continue
    for (const f of fns) {
      if (f.name === helper || helpers.has(f.name)) continue // skip helpers themselves
      if (!writesColumnInto(f.body, table, column)) continue // must write the SUMmed column
      if (callsFunction(f.code, helper)) continue // it does call the guard → fine
      const key = `${f.name}:${helper}`
      if (seen.has(key)) continue
      seen.add(key)
      hints.push({
        fn: f.name,
        helper,
        message:
          `\`${f.name}\` writes the \`${column}\` column of \`${table}\` (the same column \`${helper}()\` ` +
          `aggregates with SUM/COUNT, and \`${helper}\` is used elsewhere) but never calls \`${helper}()\`. ` +
          `Verify \`${f.name}\` is not ignoring the prior \`${column}\` total — e.g. refunding/crediting a full ` +
          `amount without subtracting what was already refunded/credited (a repeatable over-refund / ` +
          `over-credit). If the omission is intentional, confirm why.`,
      })
    }
  }
  return hints
}

/** Render the hints as a prompt block for the logic specialist (mirrors the
 *  `[AST RULE FINDINGS — pre-LLM]` block format). Empty string when no hints. */
export function renderAsymmetryHints(hints: readonly AsymmetryHint[]): string {
  if (hints.length === 0) return ""
  const lines = [
    "[CROSS-FUNCTION ASYMMETRY — pre-LLM, deterministic facts to reason about]",
    "These are FACTS surfaced by static analysis, not findings. For each, either",
    "explain why the asymmetry is safe, or raise a finding if it is a real bug:",
  ]
  for (const h of hints) lines.push(`- ${h.message}`)
  return lines.join("\n")
}
