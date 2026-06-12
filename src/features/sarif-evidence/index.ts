// SIG-318 P2: sarif-evidence feature barrel — the ONLY legal
// cross-feature import surface. External consumers reach this feature
// via `@/features/sarif-evidence`; its internal layers (domain / app /
// render) stay private behind this re-export. No logic here.

export { runSarifEvidence } from "./app/runner"
export type { ScanSkipReason } from "./app/runner"
export { parseSarif } from "./domain/sarif-parser"
export { normalizeSarifPath } from "./domain/path-normalize"
export { buildChangedLines } from "./domain/diff-lines"
export { rolesForSarifFinding, sarifFindingHasRole } from "./domain/roles"
export type { SarifFinding, SarifRun } from "./domain/types"
export { renderSarifFindingsForPrompt, renderSarifFindingsAsJsonForSynth } from "./render/render"
export { buildSarifCheckAnnotations } from "./render/annotations"
