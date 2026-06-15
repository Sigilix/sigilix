// SIG-360 / SIG-127: anchor-line substantiveness classifier — a pure leaf so
// domain/feature code can reference it without importing the triage god-file.

/**
 * SIG-127: classify a finding's anchored added-line TEXT as substantive
 * code or a structural line. File/block-level findings (e.g. "lacks
 * integration tests") often get anchored by the model to a structural
 * line — a bare `}`, a blank line — and then render as an inline
 * comment "on an empty line." Such findings are routed to the review
 * summary body instead (see `buildReviewSubmission`).
 *
 * Non-substantive when `text` is undefined, empty/whitespace-only, or
 * consists ONLY of structural punctuation/whitespace
 * (`{ } ( ) [ ] ; ,` and whitespace). Substantive otherwise.
 *
 * Pure — exported for tests.
 */
export function isSubstantiveAnchorLine(text: string | undefined): boolean {
  if (text === undefined) return false
  if (text.trim() === "") return false
  return !/^[\s{}()[\];,]*$/.test(text)
}

/**
 * SIG-436: strip a WHOLE-LINE comment off `text`, returning what (if anything)
 * is left as code. Pure helper for `isSubstantiveCodeAnchorLine`.
 *
 * Removes ONLY a comment that begins the (trimmed) line — never code that
 * precedes a trailing comment:
 *   - a line-comment that IS the line: `// note`, `# note` → "" (whole line is comment)
 *   - a block comment that STARTS the line: `/* … *​/` (code after a same-line
 *     close is preserved), an unterminated `/* …`, a JSDoc continuation/close
 *     (`* …`, `*​/ …`), or a JSX comment (`{/* … *​/}`).
 *
 * It does NOT strip a trailing line-comment after code (`const x = 1 // note`)
 * — that line is real code and must stay substantive. Conservative by design:
 * when unsure whether something is a comment, it is left in place (so the line
 * stays substantive and is never wrongly skipped).
 */
export function stripWholeLineComment(text: string): string {
  const trimmed = text.trim()
  if (trimmed === "") return ""
  // A `//`-comment that starts the line: the entire remainder is a comment.
  if (trimmed.startsWith("//")) return ""
  // A `#`-comment (shell / Python / YAML), but NOT a TS `#private` field or
  // method (`#count = 0`, `#flush()`). This is a TS-strict codebase, so `#`
  // immediately followed by an identifier char is CODE, not a comment; only
  // `#` + whitespace/end (a real `# note`) or a `#!` shebang is a comment.
  if (trimmed === "#" || /^#(\s|!)/.test(trimmed)) return ""
  // A JSX comment that starts the line (`{/* … *​/}`): strip the braced span;
  // keep any code that follows the close. (Checked before the bare `/*` case.)
  if (trimmed.startsWith("{/*")) {
    const close = trimmed.indexOf("*/}")
    return close === -1 ? "" : trimmed.slice(close + 3).trim()
  }
  // A block comment that STARTS the line (`/* … *​/` possibly with code after the
  // close, or an unterminated `/* …`). Strip up to and including a same-line
  // close; keep any code that follows the close.
  if (trimmed.startsWith("/*")) {
    const close = trimmed.indexOf("*/", 2)
    return close === -1 ? "" : trimmed.slice(close + 2).trim()
  }
  // A JSDoc / block continuation or close line — `*​/`, a bare `*`, or `* …`
  // (star + whitespace). NOT a generator method (`*entries() {`,
  // `*[Symbol.iterator]()`): a `*` immediately followed by an identifier/`[` char
  // is CODE, so it stays substantive. Strip up to a same-line `*​/` close if
  // present, else the whole continuation line is comment. (Limitation: a `*`-leading
  // continuation whose first `*​/` sits inside a string/regex literal would
  // mis-slice — vanishingly rare, and the failure is conservative: it strips more,
  // at worst yielding a body-demote, never a fabricated wrong target.)
  if (trimmed.startsWith("*/") || trimmed === "*" || /^\*\s/.test(trimmed)) {
    const close = trimmed.indexOf("*/")
    return close === -1 ? "" : trimmed.slice(close + 2).trim()
  }
  return trimmed
}

/**
 * SIG-436: a STRICTER substantiveness classifier — true only for a line that
 * carries real CODE. It rejects everything `isSubstantiveAnchorLine` rejects
 * (undefined / blank / pure structural punctuation), AND a line that is ONLY a
 * comment (`// …`, `/* … *​/`, ` * …` JSDoc continuation, `*​/`, `#`, `{/* … *​/}`)
 * or a comment followed only by structural punctuation.
 *
 * Why: the model frequently anchors a finding to the `// comment` line directly
 * ABOVE the buggy statement (the comment describes the bug; the bug is the next
 * line). `isSubstantiveAnchorLine` treats that comment as substantive (it has
 * letters), so the forward-walk stops on the comment and the inline comment
 * publishes one line above the bug. Under this stricter predicate the
 * forward-walk skips the comment and lands on the next real code line — the
 * statement the comment annotates.
 *
 * Used ONLY behind the `OPENCLAW_ANCHOR_PRECISION` flag (the strict path of
 * `pickSubstantiveAnchorLineForward`); `isSubstantiveAnchorLine` and every other
 * caller are unchanged. A line with code THEN a trailing comment
 * (`const x = 1 // note`) stays substantive. Pure — exported for tests.
 */
export function isSubstantiveCodeAnchorLine(text: string | undefined): boolean {
  if (!isSubstantiveAnchorLine(text)) return false
  // `isSubstantiveAnchorLine` already ruled out undefined/blank/pure-structural.
  const code = stripWholeLineComment(text as string)
  // What remains after removing a whole-line comment must itself be substantive
  // code (not empty, not pure structural punctuation).
  return isSubstantiveAnchorLine(code)
}
