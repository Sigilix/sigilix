// ARC-272 — zero-LLM documentation-coverage check.
//
// Runs in the ensemble's pre-fanout deterministic-check pipeline
// alongside secret scan, dep-vuln, AST rules, SARIF, and regex
// deterministic checks. The logic:
//
//   1. If `architectureGlobs` is empty, no-op (operator hasn't
//      opted in).
//   2. Otherwise, partition the PR's changed files:
//      - `architectureHits`: files matching any `architectureGlobs`
//      - `docHits`: files matching any `docPaths`
//   3. Emit a hit when `architectureHits.length > 0 && docHits.length === 0`.
//      The hit lists the architecture files touched and the
//      configured doc paths the operator wants checked.
//
// The hit gets rendered into the specialists' prompt as authoritative
// fact so the synth + specialists can surface it in their findings.
// We don't add a separate finding to the verdict — the existing
// fact-block flow handles surfacing.
//
// Pure module: no I/O, no async, no GitHub calls. Caller hands in
// changed paths + config; helper returns hit-or-null.

import { compileGlob } from "../shared/util/path-glob"

export interface DocsCoverageHit {
  /** Architecture-impacting files touched in this PR (matched
   *  against `architectureGlobs`). Bounded to ≤ 10 for prompt size. */
  architectureFiles: string[]
  /** The doc paths the operator wanted covered. Echoed back in the
   *  hit so the prompt can show "consider updating one of these." */
  docPaths: readonly string[]
}

/**
 * Run the docs-coverage check against a PR's changed-file list.
 * Returns a hit when architecture is touched without doc updates,
 * or `null` when the check is satisfied (or disabled).
 *
 * Caller is responsible for resolving config first via
 * `resolveDocsReviewConfig`.
 */
export function runDocsCoverageCheck(
  changedPaths: ReadonlyArray<string>,
  config: {
    enabled: boolean
    architectureGlobs: readonly string[]
    docPaths: readonly string[]
  },
): DocsCoverageHit | null {
  if (!config.enabled) return null
  if (config.architectureGlobs.length === 0) return null
  if (changedPaths.length === 0) return null

  const archRegexes = compileGlobsSafe(config.architectureGlobs)
  if (archRegexes.length === 0) return null
  const docRegexes = compileGlobsSafe(config.docPaths)

  const architectureFiles: string[] = []
  let docsTouched = false
  for (const p of changedPaths) {
    if (archRegexes.some((r) => r.test(p))) {
      architectureFiles.push(p)
    }
    if (!docsTouched && docRegexes.some((r) => r.test(p))) {
      docsTouched = true
    }
  }
  if (architectureFiles.length === 0) return null
  if (docsTouched) return null
  return {
    architectureFiles: architectureFiles.slice(0, 10),
    docPaths: config.docPaths,
  }
}

/**
 * Compile a list of glob patterns to RegExp, dropping any that
 * fail to compile (instead of throwing). Operators with a typo'd
 * glob shouldn't break the whole check — bad globs degrade to
 * "this pattern matches nothing."
 */
function compileGlobsSafe(patterns: ReadonlyArray<string>): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    try {
      out.push(compileGlob(p))
    } catch {
      // bad glob — drop silently
    }
  }
  return out
}

/**
 * Render the docs-coverage hit as a single authoritative-fact
 * block for the specialists' prompt. Returns the empty string when
 * `hit` is null so callers can join the result into a combined
 * fact block without conditional logic.
 */
export function renderDocsCoverageForPrompt(hit: DocsCoverageHit | null): string {
  if (hit === null) return ""
  const archList = hit.architectureFiles.map((f) => `- \`${f}\``).join("\n")
  const docList = hit.docPaths.map((p) => `\`${p}\``).join(", ")
  return [
    "[DOCS COVERAGE — pre-LLM, structured]",
    "",
    "This PR touches architecture-impacting files but the diff includes no documentation updates.",
    "",
    "**Architecture files touched:**",
    archList,
    "",
    `**Doc paths the operator wants covered:** ${docList}`,
    "",
    "Surface this in your findings if the change warrants a docs update. Flag with `category: docs` and severity `low` (default) or `medium` for large/breaking changes.",
  ].join("\n")
}
