// SIG-418 Phase 2 (Design B′) — the compact whole-PR summary injected into every
// multi-batch specialist's context (domain layer).
//
// When the PR is reviewed in batches, a batched specialist sees only its batch's
// diff slice — it loses the whole-PR awareness a single-batch specialist has (the
// full changed-file set + how the changed code connects across files). This pure
// helper builds a compact, deterministic summary block — the changed-file list +
// the dependency/seam hints already computed from the SIG-138 graph blast paths —
// so a batched specialist still reasons about the PR as a whole. Needed for the
// batches to be meaningful; harmless in the dark shadow pass (PR 2).
//
// PURE: no env / network / storage. Bounded (caps the list lengths) so the block
// can't blow a batch's token budget on a wide PR.

/** Inputs to the whole-PR summary. All already computed upstream by the
 *  orchestrator (the packed file paths + the graph blast caller/dependent paths). */
export interface MultiBatchPrSummaryInput {
  /** Every changed file under review this PR (reviewed + spillover). */
  changedFiles: readonly string[]
  /** Files that CALL into the changed code (SIG-138 blast radius). */
  callerPaths: readonly string[]
  /** Files that DEPEND ON / import the changed code (SIG-138 blast radius). */
  dependentPaths: readonly string[]
}

/** Cap each rendered list so the summary stays compact on wide PRs. */
const MAX_LISTED = 40

function renderList(label: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const shown = paths.slice(0, MAX_LISTED)
  const suffix = paths.length > MAX_LISTED ? ` (+${paths.length - MAX_LISTED} more)` : ""
  return `${label} (${paths.length}): ${shown.join(", ")}${suffix}`
}

/**
 * Build the compact whole-PR summary block. Returns "" when there is nothing to
 * summarize (no changed files) so callers can omit the block entirely. PURE.
 */
export function buildMultiBatchPrSummary(input: MultiBatchPrSummaryInput): string {
  const lines: string[] = []
  const files = renderList("Changed files", input.changedFiles)
  if (files) lines.push(files)
  const callers = renderList("Callers of changed code", input.callerPaths)
  if (callers) lines.push(callers)
  const dependents = renderList("Files importing/depending on changed code", input.dependentPaths)
  if (dependents) lines.push(dependents)
  if (lines.length === 0) return ""
  return [
    "[WHOLE-PR CONTEXT — this review is batched; you see ONE batch's diff below, but the PR spans these files]",
    ...lines,
    "Consider cross-file interactions (callers/dependents above) even for code outside this batch's diff.",
  ].join("\n")
}
