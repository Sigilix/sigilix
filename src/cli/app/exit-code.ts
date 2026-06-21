// SIG-304 (review CLI) Phase 1 — CI exit-code semantics.
//   0 — clean (no findings)
//   1 — blocking findings present (any P0/P1) → fail the build
//   2 — advisory only (P2/P3) → surfaced, but distinct from a blocker
// A future `--exit-zero` / `--fail-on <severity>` flag can remap these; this is the
// safe default (a review with findings is never a silent pass).

import type { FindingView } from "@/src/cli/render/finding-view"

export function exitCodeForFindings(views: readonly FindingView[]): 0 | 1 | 2 {
  if (views.length === 0) return 0
  return views.some((v) => v.severity === "P0" || v.severity === "P1") ? 1 : 2
}
