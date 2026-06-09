// SIG-318: extracted to a shared/domain leaf so features can reference the
// finding-category vocabulary without importing the `triage-pr-review`
// god-file. The canonical consumer (`triage-pr-review`) re-exports both
// symbols, so existing importers are unchanged.
//
// Leaf module: imports nothing.

export type FindingCategory =
  | "logic"
  | "security"
  | "performance"
  | "error-handling"
  | "testing"
  | "complexity"
  | "style"
  | "syntax"
  | "docs"

export const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "logic",
  "security",
  "performance",
  "error-handling",
  "testing",
  "complexity",
  "style",
  "syntax",
  "docs",
])
