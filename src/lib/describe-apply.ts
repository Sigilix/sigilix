// ARC-264: pure body-merge helper for `/sigilix describe apply`.
//
// Given the current PR body, a describe mode, and the generated section
// content, return a new body with the content written between the
// per-mode marker fences:
//
//   <!-- sigilix:describe:<mode>:start -->
//   <generated content>
//   <!-- sigilix:describe:<mode>:end -->
//
// The marker contract is identical to what `renderDescribeComment` in
// triage-pr-describe.ts already emits for the comment-draft path; that
// shared contract is the reason ARC-264 doesn't have to invent a new
// fence format.
//
// Behavior matrix:
//
//   * empty / null body                 → returns "<fenced block>\n"
//   * body with NO matching markers     → appends "\n\n<fenced block>\n"
//                                          after a trimmed copy of the body
//   * body with markers in correct order → replaces only the content
//                                          between them (markers + interior
//                                          → fresh fenced block); content
//                                          outside the markers is bit-for-bit
//                                          preserved
//   * body with markers but reversed     → treat as "no matching markers"
//                                          and append (the existing inverted
//                                          pair is left in place — caller can
//                                          clean up manually; auto-deleting
//                                          would be destructive)
//
// Idempotent: re-applying the same mode + same content twice in a row
// produces a body equal to the result of the first application.
//
// Different modes are independent: the `:pr-description:` markers and
// the `:internal-changelog:` markers can coexist in the same body
// without colliding (each `applyDescribeToBody` call targets exactly
// one mode's marker pair).
//
// Pure — no I/O, no env. The handler in triage-pr-describe.ts wraps
// this with the GitHub PATCH call.

import type { DescribeMode } from "./slash-commands"

/** The marker pair `applyDescribeToBody` writes/replaces. Public so
 *  tests + the handler can reference them by name rather than
 *  hand-rolling the literal strings. */
export function describeMarkers(mode: DescribeMode): {
  start: string
  end: string
} {
  return {
    start: `<!-- sigilix:describe:${mode}:start -->`,
    end: `<!-- sigilix:describe:${mode}:end -->`,
  }
}

export interface ApplyDescribeArgs {
  /** Current PR body (may be empty, null, or undefined — all map to ""). */
  currentBody: string | null | undefined
  /** Which describe mode's marker pair to target. */
  mode: DescribeMode
  /** The section content to write between the markers. Caller is
   *  responsible for any size truncation (LLM output cap, GitHub PR-
   *  body cap, etc.). The helper preserves leading whitespace exactly
   *  (a model may use an intentional leading bullet/heading) but
   *  trims trailing whitespace before writing — without that strip,
   *  a model output with a trailing newline would accumulate blank
   *  lines on every re-apply and break byte-for-byte idempotency. */
  sectionContent: string
}

/**
 * Returns the new PR body. Caller PATCHes it via
 * `client.updatePullRequestBody`.
 */
export function applyDescribeToBody(args: ApplyDescribeArgs): string {
  const { mode, sectionContent } = args
  const body = typeof args.currentBody === "string" ? args.currentBody : ""
  const { start, end } = describeMarkers(mode)

  // Trim trailing whitespace on the inner content so a model output
  // with a trailing newline doesn't accumulate blank lines on every
  // re-apply. Leading whitespace is preserved (the model might use
  // an intentional leading bullet/heading).
  const block = `${start}\n${sectionContent.replace(/\s+$/, "")}\n${end}`

  const startIdx = body.indexOf(start)
  const endIdx = body.indexOf(end)

  // Both markers present AND in the expected order: replace the
  // entire fenced range (markers inclusive) with the fresh block.
  //
  // Guard against malformed shape `start … start … end` (code-
  // review L8 catch): if a second start marker appears BEFORE
  // the first end marker, the simple slice would leave the
  // second start orphaned inside the new block, breaking the
  // next re-run's replace-target detection. In that case fall
  // through to the append path so the broken pair stays visible
  // for manual cleanup rather than getting silently re-fenced.
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const secondStartIdx = body.indexOf(start, startIdx + start.length)
    if (secondStartIdx === -1 || secondStartIdx > endIdx) {
      const before = body.slice(0, startIdx)
      const after = body.slice(endIdx + end.length)
      return before + block + after
    }
    // else: fall through to the append path below.
  }

  // Empty body → just the block + a trailing newline. The trailing
  // newline matches the human convention for PR bodies and keeps
  // diff output cleaner when GitHub renders the body.
  const trimmed = body.trimEnd()
  if (trimmed.length === 0) {
    return block + "\n"
  }

  // Body has content but no matching marker pair: append. Use a
  // blank-line separator so the inserted block reads as its own
  // section.
  return `${trimmed}\n\n${block}\n`
}
