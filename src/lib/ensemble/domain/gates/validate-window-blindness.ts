// Cross-cutting over-fire, Option B: deterministic window-blindness gate.
//
// The deterministic backstop behind PR #327's prompt-side cross-cutting
// refutation fence. The logic specialist sees only the changed hunks plus a
// few context lines (diff-packing.ts) — NOT the whole file. So it sometimes
// flags a POSITIVE MISREAD: "this value can be undefined / returns NaN / is
// unbounded / is never validated" when the guard that makes the code correct
// lives OUTSIDE the diff window it was shown.
//
// SIG-290 (validate-absence-grounding.ts) catches the ABSENCE-phrased version
// of this ("lacks tests", "no null check"). This gate catches the POSITIVE-
// misread version, and it does so with a STRONGER proof: it demotes ONLY when
// the guard the model claims is absent is literally PRESENT in the full file
// (`astFilesByPath`, the head content) at a line OUTSIDE the window the model
// saw, upstream of the flagged use, on the SAME cited symbol. That is a
// provable window-blindness FP, not a heuristic.
//
// DEMOTE-TO-BODY, NEVER HARD-DROP. Like every gate in this codebase, a flagged
// finding is routed to the review body (still visible to the customer), never
// deleted. Combined with shadow-first measurement, the worst case is a real
// finding moved to the body — never hidden.
//
// FALSE-POSITIVE / RECALL SAFETY (biases HARD toward KEEP — every ambiguity
// keeps the finding inline):
//   - Not a logic finding, or score < 4 → KEEP (scoped to the high-severity
//     logic over-fire this exists to fix; the perf/security lenses have their
//     own gates).
//   - Text doesn't match a positive-misread pattern, or matches an EXCLUSION
//     (past-tense "was unbounded", a fix "now validates X", a conditional, a
//     negation) → KEEP.
//   - Full file unavailable for the path (non-JS/TS, AST features off) → KEEP.
//   - Window not reconstructable for the path → KEEP.
//   - The cited line yields no concrete identifier → KEEP.
//   - No guard on a cited identifier is found upstream + out-of-window + at a
//     dominating (same-or-shallower) indent within the proximity bound → KEEP.
//   This is the SIG-290 "only suppress when PROVABLY out-of-window" posture.
//
// SHADOW-FIRST: the actual demotion is gated behind
//   `OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE` (off | shadow | enforce, default
//   off in code / shadow in wrangler) at the call site. `off` ⇒ never runs;
//   `shadow` ⇒ counts/telemeters but keeps every finding inline (zero behavior
//   change); only `enforce` demotes. This module is pure and mode-agnostic.

import type { PrReviewFinding } from "@/shared/domain/pr-review-finding"

/**
 * Validator mode. `off` (default in code): the gate doesn't run. `shadow`:
 * telemeter what WOULD be demoted but keep every finding inline. `enforce`:
 * demote flagged findings to the review body. Three-state with `off` as the
 * cautious default — matches the off|shadow|enforce idiom of
 * `parseAbsenceClaimValidatorMode` / `parseSecurityUsageValidatorMode`.
 */
export type WindowBlindnessValidatorMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE`. Case-insensitive,
 * whitespace-tolerant; any unknown / missing value resolves to `off` — the
 * cautious default that disables the gate entirely (wrangler sets `shadow`).
 */
export function parseWindowBlindnessValidatorMode(
  raw: string | undefined,
): WindowBlindnessValidatorMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/** Single failure shape — a positive misread whose guard is provably out-of-window. */
export type WindowBlindnessDropReason = "positive-misread-guard-out-of-window"

export type WindowBlindnessDecision =
  | { keep: true }
  | {
      keep: false
      reason: WindowBlindnessDropReason
      /** the cited symbol whose guard was found out-of-window (for shadow telemetry). */
      matchedIdentifier: string
      /** 1-based line of the matching out-of-window guard (for shadow telemetry). */
      guardLine: number
    }

export interface WindowBlindnessContext {
  /**
   * Head (post-PR) full file text, keyed by path — the orchestrator's
   * `astFilesByPath`. Holds the COMPLETE file source, so a guard the model
   * never saw is still readable here. Empty / missing for non-JS/TS files or
   * when AST features are off → those findings fall to KEEP.
   */
  fullFileByPath: ReadonlyMap<string, string>
  /**
   * The set of NEW-side (RIGHT) line numbers the specialist actually saw for
   * each path — the changed + context lines of the diff window, derived from
   * the reviewable positions. A guard at a full-file line NOT in this set was
   * outside the model's window. Missing for a path → that finding keeps.
   *
   * NOTE (v1 limitation, Kimi sign-off): this is the DIFF window, not the
   * PROMPT window. SIG-286 graph-context-expansion may ALSO inject a guard's
   * region as a cross-file context block the model saw — that line would not
   * be in this set, so the gate could label a "saw-but-misread" finding as
   * window-blind. Either way the finding is a false "no guard" claim, so the
   * demote is still the correct outcome; only the reason label is imprecise.
   * Measure the correlation with SIG-286 injection in shadow before enforce.
   */
  windowLinesByPath: ReadonlyMap<string, ReadonlySet<number>>
}

/**
 * Severity floor + proximity bound. The floor mirrors the SIG-308/SIG-109
 * sev>=4 bar (a high-severity logic misread is where window-blindness FPs
 * hurt most). The proximity bound caps how far ABOVE the flagged use we will
 * accept an out-of-window guard — a guard 200 lines up in another function is
 * not the one that protects this use. 40 lines comfortably covers a guard at
 * the top of the enclosing function without reaching across unrelated code.
 */
export const WINDOW_BLINDNESS_MIN_SEVERITY = 4
export const WINDOW_BLINDNESS_UPSTREAM_PROXIMITY = 40

// --- Positive-misread detector ---------------------------------------------
//
// Run EXCLUSIONS first (mirrors SIG-290): a past-tense report, a fix that ADDS
// the guard, a conditional, or a negation is NOT an asserted positive misread.

const MISREAD_EXCLUSION_PATTERNS: readonly RegExp[] = [
  // "now validates X", "adds the missing clamp", "fixes the unchecked index"
  /(?:now|adds?|fixes|implements|introduces)\s+(?:the\s+)?(?:\w+\s+){0,3}(?:validat|clamp|guard|bound|check|finite)/i,
  // "X was unbounded", "the index had been unchecked" — past-tense, resolved.
  /(?:was|were|had\s+been)\s+(?:\w+\s+){0,3}(?:unbounded|unvalidated|unchecked|unguarded|undefined)/i,
  // "if X can be undefined", "when the value might be NaN" — hypothetical.
  // The gap matcher `[^.\n]{0,30}?` tolerates backticks/punctuation around the
  // subject (e.g. "if `x` can be undefined") that a `\w+` gap would not span.
  /(?:if|when|should|could|unless)\b[^.\n]{0,30}?\b(?:can|may|might|be|is|are)\s+(?:\w+\s+){0,2}(?:undefined|null|nan|unbounded)/i,
  // "is not unbounded", "no longer unchecked" — explicit negation.
  /(?:not|no\s+longer)\s+(?:unbounded|unvalidated|unchecked|unguarded)/i,
]

// POSITIVE-MISREAD patterns: a current assertion that a value is unprotected.
const MISREAD_PATTERNS: readonly RegExp[] = [
  /\bcan\s+be\s+(?:undefined|null|nan|negative)\b/i,
  /\b(?:returns?|evaluates?\s+to|results?\s+in|produces?)\s+nan\b/i,
  /\b(?:is|are|may\s+be|could\s+be|might\s+be)\s+(?:unbounded|unvalidated|unchecked|unguarded)\b/i,
  /\b(?:never|not|isn'?t|aren'?t)\s+(?:validated|checked|clamped|bounded|guarded|sanitized|null-?checked)\b/i,
  /\b(?:no|missing|lacks?(?:\s+a)?|without|absent)\s+(?:\w+\s+){0,3}(?:guard|clamp|bounds?\s*check|range\s*check|null\s*check|validation|finite\s*check|length\s*check)\b/i,
  /\b(?:unchecked|unvalidated|unbounded)\s+(?:access|index|input|value|bound|array)\b/i,
]

function findingText(finding: PrReviewFinding): string {
  return `${finding.headline} ${finding.body}`
}

/**
 * Detect a positive-misread finding. EXCLUSIONS first (any match → not a
 * misread). Exported for unit tests.
 */
export function isPositiveMisread(finding: PrReviewFinding): boolean {
  const text = findingText(finding)
  for (const re of MISREAD_EXCLUSION_PATTERNS) {
    if (re.test(text)) return false
  }
  return MISREAD_PATTERNS.some((re) => re.test(text))
}

// --- Identifier + guard analysis -------------------------------------------

const JS_RESERVED = new Set<string>([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "switch", "case", "break", "continue", "new", "this", "typeof", "instanceof",
  "true", "false", "null", "undefined", "void", "await", "async", "yield",
  "throw", "try", "catch", "finally", "in", "of", "do", "delete", "class",
  "extends", "super", "import", "export", "default", "from", "as", "number",
  "string", "boolean", "object", "any", "unknown", "never", "Math", "Number",
  "Array", "Object", "String", "Boolean", "JSON", "console",
])

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g

/**
 * Extract candidate subject identifiers from the cited line — the values the
 * misread could be about. Drops reserved words / built-ins (a guard on `Math`
 * is meaningless) and very short names (< 2 chars are too collision-prone for
 * a whole-file presence search). Exported for unit tests.
 */
export function extractCitedIdentifiers(lineText: string): string[] {
  const out = new Set<string>()
  for (const m of lineText.matchAll(IDENTIFIER_RE)) {
    const id = m[0]
    if (id.length < 2) continue
    if (JS_RESERVED.has(id)) continue
    out.add(id)
  }
  return [...out]
}

function leadingIndent(line: string): number {
  const m = line.match(/^[ \t]*/)
  return m ? m[0].length : 0
}

/**
 * Does `line` contain a GUARD construct bound to identifier `id`? The guard
 * must REFERENCE `id` (not merely sit on the same line as an unrelated guard),
 * mirroring how SIG-308's `clearedLogicCandidates` quote the exact mitigating
 * token. Recognized shapes: finite/NaN checks, min/max/clamp, null/undefined/
 * relational `if` guards, `?? || ` defaults, `typeof`, and length checks.
 */
function lineGuardsIdentifier(line: string, id: string): boolean {
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Every pattern binds the guard to `\b${e}\b` on BOTH sides (DeepSeek nit:
  // a one-sided boundary let `index` match inside `myIndex`). The `.length`
  // guard requires a comparison/boolean context (Kimi nit: a bare
  // `const n = arr.length` is not a guard).
  const guardPatterns: RegExp[] = [
    new RegExp(`(?:Number\\.)?is(?:Finite|NaN|Integer)\\s*\\(\\s*\\b${e}\\b`),
    new RegExp(`Math\\.(?:min|max)\\s*\\([^)]*\\b${e}\\b`),
    new RegExp(`\\bclamp\\w*\\s*\\([^)]*\\b${e}\\b`),
    new RegExp(`\\bif\\s*\\(\\s*!?\\s*\\b${e}\\b`),
    new RegExp(`\\bif\\s*\\([^)]*\\b${e}\\b\\s*(?:===|!==|==|!=|<=|>=|<|>)`),
    new RegExp(`\\b${e}\\b\\s*(?:\\?\\?|\\|\\|)\\s*\\S`),
    new RegExp(`\\btypeof\\s+\\b${e}\\b`),
    new RegExp(`\\b${e}\\b\\s*\\.length\\s*(?:[<>]=?|===?|!==?)`),
    new RegExp(`\\b${e}\\b\\s*(?:===|!==|==|!=)\\s*(?:null|undefined)`),
  ]
  return guardPatterns.some((re) => re.test(line))
}

/**
 * Is `id` REASSIGNED on this line (`id = ` / `id += ` / `id++` …, not `==`,
 * `===`, or an arrow `=>`)? A reassignment between an upstream guard and the
 * flagged use can UNDO the guard (parse → validate → reassign-raw → use), so a
 * guard followed by a reassignment of the same symbol must NOT trigger a demote
 * (DeepSeek nit: the dominance heuristic is control-flow-unaware). Conservative
 * — any textual reassignment keeps the finding.
 */
function lineReassignsIdentifier(line: string, id: string): boolean {
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\b${e}\\b\\s*(?:=(?![=>])|[-+*/%]=|\\+\\+|--)`).test(line)
}

/**
 * Pure decision for ONE finding. Mode-agnostic — the orchestrator gates the
 * demotion behind off/shadow/enforce. Never throws, no I/O.
 *
 * Demote ONLY when ALL hold (every other path KEEPS):
 *   1. logic category AND score >= 4
 *   2. text is a positive misread (and not an excluded phrase)
 *   3. the full file + the window line-set are both available for the path
 *   4. the cited line yields a SUBJECT identifier — one that appears in BOTH
 *      the cited line AND the finding text (so we don't act on a co-cited but
 *      uncomplained-about variable)
 *   5. a subject identifier has a guard, upstream of the flagged line, within
 *      the proximity bound, at a same-or-shallower indent (dominance heuristic),
 *      on a line the model did NOT see (out of the window set), AND that
 *      identifier is NOT reassigned between the guard and the flagged use (a
 *      reassignment can undo the guard — the control-flow-unaware real-bug case)
 */
export function evaluateWindowBlindness(
  finding: PrReviewFinding,
  context: WindowBlindnessContext,
): WindowBlindnessDecision {
  if (finding.category !== "logic") return { keep: true }
  if (finding.score < WINDOW_BLINDNESS_MIN_SEVERITY) return { keep: true }
  if (!isPositiveMisread(finding)) return { keep: true }

  const full = context.fullFileByPath.get(finding.path)
  if (!full) return { keep: true }
  const windowLines = context.windowLinesByPath.get(finding.path)
  if (!windowLines) return { keep: true }

  const lines = full.split(/\r?\n/)
  const citedLine = finding.line
  // Out-of-range cited line (stale full file vs the finding's anchor) → keep.
  if (citedLine < 1 || citedLine > lines.length) return { keep: true }
  const citedText = lines[citedLine - 1]
  if (typeof citedText !== "string" || citedText.trim().length === 0) {
    return { keep: true }
  }

  // Subject binding: only act on identifiers the finding actually complains
  // about — the intersection of the cited line's identifiers and the finding
  // text's identifiers. A guard on a co-cited but uncomplained-about variable
  // must not demote the real finding (both reviewers' top nit).
  const findingIds = new Set(extractCitedIdentifiers(findingText(finding)))
  const subjects = extractCitedIdentifiers(citedText).filter((id) => findingIds.has(id))
  if (subjects.length === 0) return { keep: true }
  const citedIndent = leadingIndent(citedText)

  const start = Math.max(1, citedLine - WINDOW_BLINDNESS_UPSTREAM_PROXIMITY)
  for (let ln = start; ln < citedLine; ln++) {
    if (windowLines.has(ln)) continue // the model SAW this line — not blind
    const text = lines[ln - 1]
    if (typeof text !== "string" || text.trim().length === 0) continue
    // Dominance heuristic: a guard nested deeper than the use may be a
    // non-dominating conditional branch (the real-bug case). Require the guard
    // at the same or a shallower indent than the flagged use.
    if (leadingIndent(text) > citedIndent) continue
    for (const id of subjects) {
      if (!lineGuardsIdentifier(text, id)) continue
      // Reassignment-awareness: if the subject is reassigned anywhere between
      // this guard and the flagged use, the guard may be undone — do not treat
      // it as protective (keep looking for a later, still-protective guard).
      let reassigned = false
      for (let mid = ln + 1; mid < citedLine; mid++) {
        const midText = lines[mid - 1]
        if (typeof midText === "string" && lineReassignsIdentifier(midText, id)) {
          reassigned = true
          break
        }
      }
      if (reassigned) continue
      return {
        keep: false,
        reason: "positive-misread-guard-out-of-window",
        matchedIdentifier: id,
        guardLine: ln,
      }
    }
  }
  return { keep: true }
}
