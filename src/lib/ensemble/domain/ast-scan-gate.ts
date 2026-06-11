// SIG-318 (PR 12g-2): the shadow-first AST-scan-gate PURE helper. In `post` mode
// the rule's findings flow through untouched; in any other mode (`off`/`shadow`)
// they are STRIPPED from the submission (and their `perFinding` provenance
// dropped), and the stripped anchors are returned so the caller can emit a
// `shadow` measurement log. It was exported (and unit-tested via
// tests/ast-scan-gate.test.ts) from `triage-pr-review-ensemble.ts`; with its only
// non-test callers (the AST scan-gate stanzas) moving to ensemble/app/context/
// gather-graph, it relocates to the domain (the inward dependency direction) and is
// re-exported from the god-file to preserve its public surface. Never imports the
// orchestrator.

/**
 * Shadow-first gate for a deterministic AST security floor. In `post` mode the
 * rule's findings flow through untouched; in any other mode (`off`/`shadow`) they
 * are STRIPPED from the submission (and their `perFinding` provenance dropped),
 * and the stripped anchors are returned so the caller can emit a `shadow`
 * measurement log. Extracted so the off/shadow/post contract is unit-testable
 * (a regression that drops `post` findings or mis-strips is caught). Mirrors the
 * inline IDOR / weak-random / open-redirect / SSRF gates.
 */
export function applyAstScanGate<F extends { ruleId: string; astFindingId: string; path: string; line: number }>(
  astResult: { findings: F[]; perFinding: { delete(key: string): void } },
  ruleId: string,
  mode: string,
): Array<{ path: string; line: number }> {
  if (mode === "post") return []
  const emits = astResult.findings.filter((f) => f.ruleId === ruleId)
  if (emits.length === 0) return []
  astResult.findings = astResult.findings.filter((f) => f.ruleId !== ruleId)
  for (const f of emits) astResult.perFinding.delete(f.astFindingId)
  return emits.map((f) => ({ path: f.path, line: f.line }))
}
