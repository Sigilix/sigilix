// SIG-304 (review CLI) Phase 1 — CI exit-code semantics.
//   0 — clean (no findings, FULL coverage)
//   1 — blocking findings present (any P0/P1) → fail the build
//   2 — advisory only (P2/P3), OR a DEGRADED (partial-coverage) review → surfaced,
//       but distinct from a blocker
// A future `--exit-zero` / `--fail-on <severity>` flag can remap these; this is the
// safe default (a review with findings — or one that didn't fully run — is never a
// silent pass).

import type { FindingView } from "@/src/cli/render/finding-view"

export function exitCodeForFindings(views: readonly FindingView[], incomplete = false): 0 | 1 | 2 {
  const base: 0 | 1 | 2 = views.length === 0 ? 0 : views.some((v) => v.severity === "P0" || v.severity === "P1") ? 1 : 2
  // RECALL-SAFETY: a partial review (a specialist was unavailable) must NEVER exit 0
  // even with zero surviving findings — the missing specialist may have been the one
  // that would have flagged the bug.
  if (base === 0 && incomplete) return 2
  return base
}
