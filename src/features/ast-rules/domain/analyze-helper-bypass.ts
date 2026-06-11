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

import { esc, norm, display, blank, extractFunctions, type FnInfo } from "./scan-utils"

export interface AsymmetryHint {
  /** The fact, phrased for the logic specialist to judge. */
  message: string
  /** The bypassing function + the helper it skipped (telemetry / dedupe). */
  fn: string
  helper: string
}

/** The (table, column) an aggregation helper SUM/COUNTs — `SELECT … SUM|COUNT(col)
 *  … FROM table`. Requires a plain column arg + a single `FROM` with NO JOIN/UNION
 *  (an ambiguous multi-table aggregate could mis-attribute — code-review M2). Null
 *  when the body isn't such a helper. */
function aggregateTarget(body: string): { table: string; column: string; tableRaw: string; columnRaw: string } | null {
  const agg = /\b(?:sum|count)\s*\(\s*(?:distinct\s+)?([A-Za-z_$][\w$.]*)\s*\)/i.exec(body)
  if (!agg) return null
  if (/\bjoin\b|\bunion\b/i.test(body)) return null
  const from = /\bfrom\s+([A-Za-z_$][\w$.]*)/i.exec(body)
  if (!from) return null
  return {
    table: norm(from[1]!),
    column: norm(agg[1]!),
    tableRaw: display(from[1]!),
    columnRaw: display(agg[1]!),
  }
}

/** Does `body` WRITE `column` into `table` — `INSERT INTO table (… column …)` or
 *  `UPDATE table SET … column = …`? This column match is the FP-safety core: a
 *  mutator that doesn't touch the summed column is not an over-credit risk. */
function writesColumnInto(body: string, table: string, column: string): boolean {
  for (const m of body.matchAll(/\binsert\s+into\s+([A-Za-z_$][\w$.]*)\s*\(([^)]*)\)/gi)) {
    if (norm(m[1]!) !== table) continue
    if (m[2]!.split(",").some((c) => norm(c.trim() || "x") === column)) return true
  }
  for (const m of body.matchAll(/\bupdate\s+([A-Za-z_$][\w$.]*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|;|$)/gi)) {
    if (norm(m[1]!) !== table) continue
    for (const a of m[2]!.matchAll(/([A-Za-z_$][\w$]*)\s*=/g)) if (norm(a[1]!) === column) return true
  }
  return false
}

/** Does `codeBody` (strings already blanked) call `name`? Uses a `(?<![\w$])`
 *  boundary (not `\b`) so a `$`-prefixed identifier is matched (Sigilix #308:
 *  `\b` is not a boundary before `$`). */
function callsFunction(codeBody: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${esc(name)}\\s*\\(`).test(codeBody)
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

  // Aggregation helpers: name -> { table, column (normalized, for matching) +
  // tableRaw, columnRaw (original identifiers, for the hint text) }.
  const helpers = new Map<string, { table: string; column: string; tableRaw: string; columnRaw: string }>()
  for (const f of fns) {
    const t = aggregateTarget(f.body)
    if (t) helpers.set(f.name, t)
  }
  if (helpers.size === 0) return []

  const hints: AsymmetryHint[] = []
  const seen = new Set<string>()
  for (const [helper, { table, column, tableRaw, columnRaw }] of helpers) {
    // Helper must be CALLED somewhere (calls minus its own declaration(s) > 0),
    // counted on the strings-blanked corpus so a name in a doc/SQL string doesn't
    // inflate it (code-review L2).
    const calls = (callCorpus.match(new RegExp(`(?<![\\w$])${esc(helper)}\\s*\\(`, "g")) ?? []).length
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
          `\`${f.name}\` writes \`${columnRaw}\` into \`${tableRaw}\` — the column \`${helper}()\` SUMs — WITHOUT ` +
          `first calling \`${helper}()\` to read the prior total, even though \`${helper}\` exists and is used ` +
          `elsewhere. This is the OVER-CREDIT / OVER-REFUND shape. Answer ONE question: does \`${f.name}\` write ` +
          `a FULL or fixed amount (e.g. the whole plan price / charge / invoice total) rather than a delta net ` +
          `of \`${helper}()\`? Concretely: if \`${f.name}\` runs twice for the same entity, is it credited/refunded ` +
          `twice (a repeatable over-credit), or does the second call net out against what \`${helper}()\` already ` +
          `sums? If it double-counts, raise it as a logic bug. It is safe — say so — if \`${f.name}\` writes a ` +
          `usage-derived delta, the duplicate is guarded (e.g. ON CONFLICT, or a prior-total check you can name), ` +
          `or each invocation is an intended distinct grant (e.g. a recurring monthly credit) where the total is ` +
          `MEANT to accumulate. This is NOT a rounding, units, or cents/dollars question, and do not defer it as ` +
          `an idempotency, validation, or out-of-scope concern to avoid answering — judge only whether the WRITE ` +
          `AMOUNT double-counts against what \`${helper}()\` already sums.`,
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
