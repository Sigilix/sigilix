// SIG-318 P2: dep-vulns feature barrel — the ONLY legal cross-feature
// import surface. External consumers reach this feature via
// `@/features/dep-vulns`; its internal layers (domain / app / render)
// stay private behind this re-export. No logic here.

export { runDepVulnScan } from "./app/scanner"
export type { DepVulnFinding, ScanResult, ScanSkipReason, RunDepVulnScanArgs } from "./app/scanner"
export { renderDepVulnFindingsForPrompt } from "./render/render"
