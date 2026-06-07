// SIG-317 Part 2: deterministic detector for ENUM / type-contract drift — a SQL
// write of a string literal that is NOT a member of the column's declared
// TypeScript string-literal union. The recurring miss on a hard wallet/billing
// PR: `Charge.status` is typed `"pending" | "settled" | "failed"`, but
// `refundCharge` runs `UPDATE charges SET status = 'refunded'` — `'refunded'`
// isn't in the union, so every consumer typed against it (an exhaustive
// `switch`, the frontend) silently treats refunded charges as "unknown".
// Greptile + CodeRabbit catch this by correlating the type with the write; our
// model specialists intermittently miss it. This is the deterministic safety net.
//
// Why a line-scan + a cross-file collect pass, not a single AST rule: the
// constraint (the union) and the violation (the SQL write) live in DIFFERENT
// files (the type in `shared/types.ts`, the query in `billing.ts`), and the SQL
// is buried inside a string-literal argument to `pool.query(...)` that the JS/TS
// walker never descends into. So the runner builds a cross-file type→union map
// first (`buildGlobalUnionMap` over every changed file), then this scans each
// file's `UPDATE … SET` statements against it.
//
// FP-safe by construction (north-star = ZERO P0/P1 false positives), the way the
// dual design + dual review (DeepSeek-v4-pro + Kimi + code-reviewer) forced.
// Correlation is ONLY table→type→column (a SQL write's TABLE picks the declaring
// type — the same PR declares TWO `status` unions, `Invoice` and `Charge`, so a
// column-name-only match is unsound). SKIP on any uncertainty —
//   * no table, or the table maps to 0 / >1 declaring types (ambiguous) → skip;
//   * the mapped type declares no string-literal union for that column → skip
//     (there is NO same-name global fallback: a `status` union on a function
//     param / an unrelated entity must never govern a DB column — code-review H2);
//   * the written value contains `${…}` / concatenation / is a placeholder
//     (`$1`/`?`) → dynamic, can't be checked → skip;
//   * the value IS a member of the union → safe, skip.
// Unions and SQL bodies are read with comments BLANKED (a commented-out type or
// a `--`/`/* */` SQL comment must not seed or trigger a finding — code-review H1
// / DeepSeek), length-preserving so line/column math stays exact.
// And it SURFACES at P2 (a hedged "verify" advisory, never a blocker), per the
// SIG-312 pattern: a deterministic scan can't prove the DB schema doesn't
// legitimately allow the extra value (intentional drift), so the model's logic
// specialist stays the trust judge that escalates a real contract break to
// P0/P1. The `warning`→P2 ceiling is enforced by the synth emit instruction +
// `clampAstEmitScores`; no recall is lost on a real bug (the specialist raises
// its own higher-severity finding, which supersedes this).

import type { AstRuleHit } from "./types"

export const ENUM_LITERAL_DRIFT_RULE_ID = "no-enum-literal-drift"

/** normalized type name → (normalized prop → allowed literal values). */
export type UnionMap = Map<string, Map<string, Set<string>>>

/** A property typed as a string-literal union of >=2 members, on one line:
 *  `status: "a" | "b" | "c"` / `status?: "a" | "b"`. Group 1 = property name,
 *  group 2 = the union body. The trailing `(\| ...)+` demands >=2 members. */
const UNION_DECL_RE =
  /([A-Za-z_$][\w$]*)\s*\??\s*:\s*("(?:[^"\\]|\\.)*"(?:\s*\|\s*"(?:[^"\\]|\\.)*")+)/g

/** An `interface Name { … }` / `type Name = { … }` block with a FLAT body (no
 *  nested braces — property-union types are flat; a nested object type isn't
 *  collected, FN over FP). Group 1 = type name, group 2 = body. */
const TYPE_BLOCK_RE = /(?:interface|type)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*)?\{([^{}]*)\}/g

/** Unescape a TS/SQL string-literal body so the union member and the SQL value
 *  compare on equal terms (`it\'s`/`it''s` ↔ `it's`). */
function unescapeLiteral(v: string): string {
  return v.replace(/''/g, "'").replace(/\\(.)/g, "$1")
}

function literalsOf(unionBody: string): Set<string> {
  const out = new Set<string>()
  for (const m of unionBody.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.add(unescapeLiteral(m[1]!))
  return out
}

/** Canonicalize a name for snake_case↔camelCase / table↔type correlation:
 *  `owner_id` and `ownerId` → `ownerid`; `Charge` → `charge`. */
function normName(n: string): string {
  return n.replace(/_/g, "").toLowerCase()
}

/**
 * Blank `//` and `/* *​/` comments to spaces, length- and newline-preserving, so
 * offsets/lines stay exact and a commented-out type/union or a `--`-style SQL
 * comment can't seed or trigger a finding. String/template literals are
 * respected (a `//` inside `"http://…"` is NOT a comment). `sqlMode` also blanks
 * SQL `--` line comments (used on a query body, which is already string content).
 */
function blankComments(src: string, sqlMode = false): string {
  const out = src.split("")
  const n = src.length
  let i = 0
  let inStr: string | null = null
  while (i < n) {
    const c = src[i]!
    if (inStr) {
      if (c === "\\") { i += 2; continue }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (!sqlMode && (c === '"' || c === "'" || c === "`")) { inStr = c; i++; continue }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") { out[i] = " "; i++ }
      continue
    }
    if (sqlMode && c === "-" && src[i + 1] === "-") {
      while (i < n && src[i] !== "\n") { out[i] = " "; i++ }
      continue
    }
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

/**
 * Collect string-literal unions across many files, keyed by the DECLARING type
 * (the table-disambiguated lookup). Only unions inside a parsed `interface`/`type`
 * block are collected — a union on a function param / variable annotation has no
 * authority over a DB column, so it is deliberately NOT a fallback source. Pure.
 */
export function buildGlobalUnionMap(sources: Iterable<string>): UnionMap {
  const byType: UnionMap = new Map()
  for (const raw of sources) {
    const source = blankComments(raw)
    for (const tb of source.matchAll(TYPE_BLOCK_RE)) {
      const typeName = normName(tb[1]!)
      for (const pm of (tb[2] ?? "").matchAll(UNION_DECL_RE)) {
        const prop = normName(pm[1]!)
        const lits = literalsOf(pm[2]!)
        if (lits.size < 2) continue
        if (!byType.has(typeName)) byType.set(typeName, new Map())
        byType.get(typeName)!.set(prop, lits)
      }
    }
  }
  return byType
}

/** Normalized type-name candidates a SQL table could correspond to:
 *  the name itself + a naive singularization (`charges`→`charge`,
 *  `companies`→`company`, `boxes`→`box`). */
function typeCandidatesForTable(table: string): string[] {
  const n = normName(table.split(".").pop() ?? table) // drop a `schema.` prefix
  const cands = new Set([n])
  if (n.endsWith("ies")) cands.add(n.slice(0, -3) + "y")
  else if (/(?:ses|xes|zes|ches|shes)$/.test(n)) cands.add(n.slice(0, -2))
  else if (n.endsWith("s")) cands.add(n.slice(0, -1))
  return [...cands]
}

/**
 * Resolve the allowed-value set for a (table, column) write, or undefined to
 * SKIP. ONLY the table→type path: a unique declaring type that has the column.
 * 0 or >1 candidate types → undefined (skip).
 */
function resolveUnion(table: string, normCol: string, map: UnionMap): Set<string> | undefined {
  const cands = typeCandidatesForTable(table)
  const withCol = [...map.entries()]
    .filter(([t, props]) => cands.includes(t) && props.has(normCol))
    .map(([, props]) => props.get(normCol)!)
  return withCol.length === 1 ? withCol[0] : undefined
}

const SQL_UPDATE_KEYWORD_RE = /\bupdate\b/i

/** A quoted SQL string candidate. `bodyStart` is the absolute offset of body[0]. */
interface SqlStringCandidate {
  body: string
  bodyStart: number
}

/**
 * Extract double-quoted and template-literal bodies that contain `UPDATE`.
 * Deliberately linear: the previous whole-source backtracking regexp could pin
 * a Worker CPU when an unrelated changed file seeded the union map and a large
 * TS file contained many quote/update-shaped prose fragments.
 *
 * We keep the old delimiter policy: no single-quoted JS strings, because SQL
 * bodies need single quotes for SQL literals (`status = 'refunded'`) and letting
 * apostrophes start candidates creates noise.
 */
function sqlStringCandidates(source: string): SqlStringCandidate[] {
  const out: SqlStringCandidate[] = []
  let i = 0
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      i += 2
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i = Math.min(source.length, i + 2)
      continue
    }
    if (source[i] === "'") {
      const end = findSimpleQuotedStringEnd(source, i, "'")
      i = end < 0 ? i + 1 : end + 1
      continue
    }
    const regexEnd = maybeRegexLiteralEnd(source, i)
    if (regexEnd > i) {
      i = regexEnd
      continue
    }

    const quote = source[i]
    if (quote !== "\"" && quote !== "`") {
      i++
      continue
    }

    const bodyStart = i + 1
    const end = findQuotedStringEnd(source, i, quote)
    if (end < 0) {
      i = bodyStart
      continue
    }

    const body = source.slice(bodyStart, end)
    if (SQL_UPDATE_KEYWORD_RE.test(body)) out.push({ body, bodyStart })
    i = end + 1
  }
  return out
}

function findQuotedStringEnd(source: string, openIdx: number, quote: "\"" | "`"): number {
  let i = openIdx + 1
  while (i < source.length) {
    const c = source[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (quote === "`" && c === "$" && i + 1 < source.length && source[i + 1] === "{") {
      i = skipTemplateExpression(source, i + 1)
      continue
    }
    if (c === quote) return i
    i++
  }
  return -1
}

function skipTemplateExpression(source: string, openBraceIdx: number): number {
  let depth = 1
  let i = openBraceIdx + 1
  while (i < source.length) {
    const c = source[i]
    if (c === "\"" || c === "'" || c === "`") {
      const end = c === "`"
        ? findQuotedStringEnd(source, i, "`")
        : findSimpleQuotedStringEnd(source, i, c)
      if (end < 0) return source.length
      i = end + 1
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      i += 2
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i = Math.min(source.length, i + 2)
      continue
    }
    const regexEnd = maybeRegexLiteralEnd(source, i)
    if (regexEnd > i) {
      i = regexEnd
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return source.length
}

function findSimpleQuotedStringEnd(source: string, openIdx: number, quote: "\"" | "'"): number {
  let i = openIdx + 1
  while (i < source.length) {
    const c = source[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return i
    i++
  }
  return -1
}

function maybeRegexLiteralEnd(source: string, slashIdx: number): number {
  if (source[slashIdx] !== "/" || source[slashIdx + 1] === "/" || source[slashIdx + 1] === "*") return -1
  if (!canStartRegexLiteral(source, slashIdx)) return -1

  let i = slashIdx + 1
  let inClass = false
  while (i < source.length) {
    const c = source[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "\n" || c === "\r") return -1
    if (c === "[") {
      inClass = true
      i++
      continue
    }
    if (c === "]" && inClass) {
      inClass = false
      i++
      continue
    }
    if (c === "/" && !inClass) {
      i++
      while (/[A-Za-z]/.test(source[i] ?? "")) i++
      return i
    }
    i++
  }
  return -1
}

function canStartRegexLiteral(source: string, slashIdx: number): boolean {
  let i = slashIdx - 1
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--
  if (i < 0) return true

  const c = source[i]!
  if ("([{=,:;!&|?+-*~^<>".includes(c)) return true

  const wordEnd = i + 1
  while (i >= 0 && /[A-Za-z_$]/.test(source[i] ?? "")) i--
  const word = source.slice(i + 1, wordEnd)
  return /^(?:return|throw|case|delete|void|typeof|instanceof|yield|await|else|do)$/.test(word)
}

/** `UPDATE <table> SET <set-clause>` up to (not including) WHERE/RETURNING/;/end. */
const UPDATE_SET_RE = /\bupdate\s+([A-Za-z_$][\w$.]*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|;|$)/gi
/** A `col = 'literal'` assignment. Single-quoted only, so `= $1` / `= ?` skip.
 *  The value body allows `''` (SQL's escaped apostrophe) so `'it''s'` is read as
 *  one literal `it''s` (→ `it's` after unescape), not split at the inner quote. */
const SET_ASSIGN_RE = /([A-Za-z_$][\w$]*)\s*=\s*'((?:[^'\\]|\\.|'')*)'/g

function clip(s: string, max = 60): string {
  const v = s.trim()
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function driftMessage(table: string, column: string, value: string, allowed: Set<string>): string {
  const union = [...allowed].map((l) => `"${l}"`).join(" | ")
  // Deliberately HEDGED / advisory (P2): a deterministic scan can't prove the DB
  // schema doesn't legitimately allow the extra value (intentional drift). It
  // surfaces the mismatch; the logic specialist judges + escalates a real break.
  return (
    `Type-contract drift: this SQL writes \`${column} = '${value}'\` to \`${table}\`, but the declared ` +
    `type for \`${column}\` is the string-literal union ${clip(union)} — \`'${value}'\` is not a member. ` +
    `Verify this value is intended: code typed against the union (an exhaustive \`switch\`, the frontend, ` +
    `serializers) will treat \`'${value}'\` as an unknown/unhandled state. ` +
    `If valid, add it to the union; if not, write a declared value.`
  )
}

/**
 * Scan a file's source for an `UPDATE <table> SET <col> = '<literal>'` whose
 * literal is not a member of `<col>`'s declared union (resolved cross-file via
 * `unionMap`, table-disambiguated). Pure; returns raw hits (the runner filters
 * by changed-lines and wraps them as a `warning`/`logic`/`emitWhenUnmatched`
 * advisory). The guard ORDER is the FP-safety contract.
 */
export function scanSqlEnumDrift(source: string, unionMap: UnionMap): AstRuleHit[] {
  const hits: AstRuleHit[] = []
  if (unionMap.size === 0) return hits
  const seen = new Set<number>()
  for (const { body: rawBody, bodyStart } of sqlStringCandidates(source)) {
    // Blank SQL comments inside the body (length-preserving) so a commented-out
    // `-- UPDATE … SET x='y'` can't trigger a finding (DeepSeek FP vector).
    const body = blankComments(rawBody, true)
    for (const um of body.matchAll(UPDATE_SET_RE)) {
      const table = um[1]!
      const setClause = um[2] ?? ""
      const setClauseAbs = bodyStart + (um.index ?? 0) + (um[0].length - setClause.length)
      for (const am of setClause.matchAll(SET_ASSIGN_RE)) {
        const column = am[1]!
        const rawValue = am[2]!
        // Dynamic value (template interpolation / concatenation) → can't check.
        if (rawValue.includes("${")) continue
        const value = unescapeLiteral(rawValue)
        const allowed = resolveUnion(table, normName(column), unionMap)
        if (!allowed || allowed.has(value)) continue // unresolved/ambiguous, or a declared value
        const offset = setClauseAbs + (am.index ?? 0)
        if (seen.has(offset)) continue
        seen.add(offset)
        const lineStartIdx = source.lastIndexOf("\n", offset - 1) + 1
        hits.push({
          message: driftMessage(table, column, value, allowed),
          evidence: am[0].replace(/\s+/g, " ").trim().slice(0, 200),
          line: source.slice(0, offset).split("\n").length,
          column: Math.max(0, offset - lineStartIdx),
        })
      }
    }
  }
  return hits
}
