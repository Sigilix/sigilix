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
