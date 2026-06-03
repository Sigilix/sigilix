// SIG-317 4b-v2: the TOCTOU / CHECK-THEN-ACT RACE evidence-injector.
//
// Sibling of analyze-helper-bypass (over-credit). Deterministic FLAGGING of races
// was CUT (safe atomic variants are byte-near-identical -> 10x noise), but the
// same evidence-injector escape works: surface the FACT for the LOGIC specialist
// to JUDGE (never a posted finding -> FP-safe by construction; a noisy fact only
// wastes attention, never posts an FP). The precision anchor that made the
// over-credit injector safe is available here too: a FOUR-WAY column-continuity
// match — the SELECTed column C == the JS-compared value == the relative-delta
// `UPDATE SET C = C +/- N` target == same table + same key. Everything the
// string analysis cannot decide (READ COMMITTED vs SERIALIZABLE, cron singleton,
// benign best-effort counter) is deferred to the model via hard-enumerated
// safe-branches in the message.
//
// THE BUG (pr/11 D6 addSeat): SELECT seat_count FROM subscriptions WHERE id=$1
// -> JS `if (seat_count >= seat_limit) return` -> SEPARATE `UPDATE subscriptions
// SET seat_count = seat_count + 1 WHERE id=$1`. Two concurrent callers both pass
// the stale check and both increment -> the limit is breached. SAFE = the guard
// lives inside the single mutating statement's WHERE (atomic test-and-set, the
// releaseSeat pattern `... WHERE id=$1 AND seat_count > 0`).
//
// v1 scope: the narrow single-row check-then-act increment/decrement shape ONLY.
// NOT the read-aggregate-then-write over-credit shape (that is analyze-helper-
// bypass's domain; it carries ON CONFLICT, which this detector suppresses on).

import { esc, norm, display, blank, FN_DECL_RE } from "./scan-utils"
import { durableObjectClassSpans, lineInDurableObjectClass } from "../durable-object-spans"

export interface ToctouHint {
  /** The fact, phrased for the logic specialist to judge. */
  message: string
  /** The racing function + the row it check-then-acts on (telemetry / dedupe). */
  fn: string
  table: string
  column: string
}

interface FnSpan {
  name: string
  body: string
  /** Absolute index of the opening `{` in the (comment-blanked) file source. */
  start: number
}

/** Named functions + brace-balanced bodies WITH their absolute start offset (the
 *  offset is needed to map a match back to a file line for the DO-span check). */
function functionsWithOffset(blanked: string): FnSpan[] {
  const out: FnSpan[] = []
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
    out.push({ name: m[1]!, body: blanked.slice(start, i + 1), start })
  }
  return out
}

const lineOf = (src: string, index: number): number => {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++
  return line
}

/** A relational comparison operator (the value-guard signal; `=` alone is a key
 *  equality, NOT a guard). */
const REL_OP = /(>=|<=|===|==|!==|>|<)/

/** A relative-delta UPDATE: `UPDATE T SET ... C = C +/- N ... WHERE ...`. Bounded
 *  to within the SQL string literal (`[^"'\`]`) so it never crosses the closing
 *  quote. Groups: 1=table, 2=set-side, 3=where-side. */
const UPDATE_RE = /\bupdate\s+([A-Za-z_$][\w$.]*)\s+set\s+([^"'`]*?)\bwhere\b([^"'`]*)/gi

/** A SELECT reading columns from one table: `SELECT <cols> FROM T <rest(WHERE...)>`. */
const SELECT_RE = /\bselect\b([^"'`]*?)\bfrom\s+([A-Za-z_$][\w$.]*)([^"'`]*)/gi

/** The column being relatively incremented/decremented in an UPDATE SET-side:
 *  `C = C + N` / `C = C - N` (same column both sides). Returns C or null. */
function relativeDeltaColumn(setSide: string): { column: string; op: string } | null {
  const m = /([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*([+\-])/.exec(setSide)
  if (!m) return null
  if (norm(m[1]!) !== norm(m[2]!)) return null // must be C = C ± N, not C = other + N
  return { column: m[1]!, op: m[3]! }
}

/** First `key = $n` / `key = ident` equality in a WHERE-side → the row key column. */
function whereKeyColumn(whereSide: string): string | null {
  const m = /([A-Za-z_$][\w$]*)\s*=\s*(?:\$\d+|[A-Za-z_$][\w$.]*)/.exec(whereSide)
  return m ? m[1]! : null
}

/** Does the UPDATE's WHERE-side make it an ATOMIC test-and-set (a relational
 *  guard on a column, e.g. `... AND seat_count > 0`)? `=` key equality is not a
 *  guard. A version/CAS predicate also makes the loser no-op. */
function whereIsAtomicGuard(whereSide: string): boolean {
  if (REL_OP.test(whereSide)) return true
  if (/\b(version|rev|revision|lock_version|etag|xmin|updated_at)\s*=\s*\$\d/i.test(whereSide)) return true
  return false
}

/** Body-level atomicity/serialization mechanisms that make a check-then-act safe
 *  regardless of the statement shape. NB: a bare BEGIN/COMMIT is NOT here — under
 *  READ COMMITTED it does not close the check->act window (DeepSeek correction). */
function bodyHasSerializationGuard(bodyKept: string): boolean {
  if (/\bon\s+conflict\b|\bon\s+duplicate\s+key\b/i.test(bodyKept)) return true
  if (/\bserializable\b|\brepeatable\s+read\b/i.test(bodyKept)) return true
  if (/pg_advisory(_xact)?_lock|pg_try_advisory_lock|\bget_lock\s*\(/i.test(bodyKept)) return true
  return false
}

/** Is `col` selected as a BARE column (not inside SUM(/COUNT(/AVG( and not `*`)? */
function selectsBareColumn(selectList: string, col: string): boolean {
  if (/\*/.test(selectList) && !new RegExp(`\\b${esc(display(col))}\\b`).test(selectList)) return false
  // reject if the only occurrence is inside an aggregate call
  const re = new RegExp(`\\b(?:sum|count|avg|min|max|coalesce)\\s*\\(([^)]*)\\)`, "gi")
  let aggregatedOnly = false
  const target = norm(col)
  if (new RegExp(`\\b${esc(display(col))}\\b`).test(selectList)) {
    // appears somewhere; ensure at least one occurrence is OUTSIDE an aggregate
    const withoutAgg = selectList.replace(re, " ")
    return new RegExp(`\\b${esc(display(col))}\\b`).test(withoutAgg)
  }
  void aggregatedOnly; void target
  return false
}

export function analyzeToctouRace(filesByPath: ReadonlyMap<string, string>): ToctouHint[] {
  const hints: ToctouHint[] = []
  const seen = new Set<string>()
  // Optional grounding: atomic siblings (T,C) seen across the corpus, to enrich
  // the message ("the atomic form already exists in X") — never a firing gate.
  const atomicSiblings = new Map<string, string>() // `${normT}:${normC}` -> fn name

  // First pass: collect atomic-sibling forms (UPDATE T SET C=C±N WHERE ... <rel guard>).
  for (const source of filesByPath.values()) {
    const kept = blank(source)
    for (const fn of functionsWithOffset(kept)) {
      for (const u of fn.body.matchAll(UPDATE_RE)) {
        const delta = relativeDeltaColumn(u[2]!)
        if (delta && whereIsAtomicGuard(u[3]!)) {
          atomicSiblings.set(`${norm(u[1]!)}:${norm(delta.column)}`, fn.name)
        }
      }
    }
  }

  const doSpansByPath = durableObjectClassSpans(filesByPath)
  for (const [path, source] of filesByPath) {
    const kept = blank(source) // comments blanked, strings KEPT (SQL is in strings)
    const blanked = blank(source, true) // strings ALSO blanked (JS control-flow)
    const doSpans = doSpansByPath.get(path)

    for (const fn of functionsWithOffset(kept)) {
      if (bodyHasSerializationGuard(fn.body)) continue // ON CONFLICT / SERIALIZABLE / advisory lock
      const bodyBlanked = blanked.slice(fn.start, fn.start + fn.body.length)

      for (const u of fn.body.matchAll(UPDATE_RE)) {
        const updTable = u[1]!
        const setSide = u[2]!
        const whereSide = u[3]!
        const delta = relativeDeltaColumn(setSide)
        if (!delta) continue // not a relative-delta write
        if (whereIsAtomicGuard(whereSide)) continue // atomic test-and-set / CAS -> safe
        const C = delta.column
        if (new RegExp(`\\b${esc(display(C))}\\b`).test(whereSide)) continue // C re-asserted in WHERE -> safe
        const updKey = whereKeyColumn(whereSide)
        if (!updKey) continue
        const updIdx = u.index ?? 0

        // Find a SELECT of C from the SAME table + SAME key column, BEFORE this UPDATE.
        let matched = false
        for (const s of fn.body.matchAll(SELECT_RE)) {
          const selIdx = s.index ?? 0
          if (selIdx >= updIdx) continue
          if (norm(s[2]!) !== norm(updTable)) continue
          if (/\bfor\s+(no\s+key\s+)?update\b/i.test(s[0]!)) continue // row lock -> safe
          const selList = s[1]!
          if (!selectsBareColumn(selList, C)) continue
          const selKey = whereKeyColumn(s[3]!)
          if (!selKey || norm(selKey) !== norm(updKey)) continue // different row -> not this race

          // Value-guard between the SELECT and the UPDATE: a relational comparison
          // whose operand is the READ value of C (not a `rows.length === 0`
          // existence check — its operand is `length`, not C).
          const window = bodyBlanked.slice(selIdx, updIdx)
          const guard = new RegExp(
            `\\b${esc(display(C))}\\b[^;{}\\n]{0,40}(?:>=|<=|===|==|!==|>|<)` +
              `|(?:>=|<=|===|==|!==|>|<)[^;{}\\n]{0,40}\\b${esc(display(C))}\\b`,
          )
          if (!guard.test(window)) continue
          // The compare must GATE the write — a guard-clause short-circuit
          // (`if (cond) return/throw`) between the read and the write. A bare
          // compare that only logs/metrics with NO short-circuit is not a gate
          // (the `touchSeen` non-gating-compare residual) → bias to silence.
          if (!/\b(?:return|throw)\b/.test(window)) continue
          matched = true
          break
        }
        if (!matched) continue

        // Durable Object / serialized-by-construction span -> intra-instance race
        // cannot occur. (The cron/partition cases spans can't see are deferred to
        // the message's "serialized by construction" safe-branch.)
        const absLine = lineOf(source, fn.start + updIdx)
        if (lineInDurableObjectClass(doSpans, absLine)) continue

        const key = `${fn.name}:${norm(updTable)}.${norm(C)}`
        if (seen.has(key)) continue
        seen.add(key)
        const sibling = atomicSiblings.get(`${norm(updTable)}:${norm(C)}`)
        const siblingNote =
          sibling && sibling !== fn.name
            ? ` In the same change, \`${sibling}\` performs the analogous mutation ATOMICALLY (the guard lives inside the single statement), so the atomic primitive was available and was not used here.`
            : ""
        const T = display(updTable)
        const col = display(C)
        hints.push({
          fn: fn.name,
          table: norm(updTable),
          column: norm(C),
          message:
            `\`${fn.name}\` performs a CHECK-THEN-ACT on \`${T}.${col}\`: it SELECTs \`${col}\` for one row ` +
            `(keyed by \`${display(updKey)}\`), uses that value in a JavaScript-side guard, then issues a ` +
            `SEPARATE \`UPDATE ${T} SET ${col} = ${col} ${delta.op} N WHERE ${display(updKey)}\` whose WHERE does ` +
            `NOT re-assert the guard on \`${col}\`. The check and the write are two round-trips with no atomicity ` +
            `between them.${siblingNote} This is the TOCTOU / check-then-act RACE shape. Answer ONE concrete ` +
            `question: if \`${fn.name}\` runs CONCURRENTLY for the same row, can two callers both pass the JS ` +
            `guard on the same stale \`${col}\` and both apply the \`${col}\` ${delta.op} N write, so \`${col}\` ` +
            `breaches the limit the guard was meant to enforce? If yes, raise it as a race/concurrency logic bug ` +
            `and state the interleaving. It is SAFE — say so and NAME the mechanism — ONLY if one actually holds: ` +
            `the guard is enforced INSIDE the mutating statement's own WHERE (atomic test-and-set, ` +
            `e.g. \`... WHERE ${display(updKey)} AND ${col} > 0\`); the SELECT uses \`FOR UPDATE\`; the write is ` +
            `\`INSERT ... ON CONFLICT\` upsert; an advisory lock wraps it; the UPDATE carries an optimistic-version ` +
            `/ CAS predicate; the transaction runs at SERIALIZABLE or REPEATABLE READ isolation; or this code is ` +
            `serialized by construction (single-threaded actor / Durable Object / concurrency-1 queue / cron ` +
            `singleton / partition-keyed consumer). Do NOT clear it on a bare \`BEGIN\`/\`COMMIT\` alone — under ` +
            `READ COMMITTED that does not close the check->act window. Do NOT deflect this as an idempotency, ` +
            `input-validation, error-handling, units, or out-of-scope concern — judge ONLY whether the relative ` +
            `\`${col}\` write can race past the JS guard.`,
        })
        if (hints.length >= 3) return hints // cap: protect the logic-role attention budget
      }
    }
  }
  return hints
}

/** Render the hints as a prompt block for the logic specialist (mirrors the
 *  over-credit `[CROSS-FUNCTION ASYMMETRY]` block). Empty string when no hints. */
export function renderToctouHints(hints: readonly ToctouHint[]): string {
  if (hints.length === 0) return ""
  const lines = [
    "[CHECK-THEN-ACT / TOCTOU RACE — pre-LLM, deterministic facts to reason about]",
    "These are FACTS surfaced by static analysis, not findings. For each, either",
    "explain why the check-then-act is safe (and name the mechanism), or raise a",
    "race finding if two concurrent callers can interleave past the guard:",
  ]
  for (const h of hints) lines.push(`- ${h.message}`)
  return lines.join("\n")
}
