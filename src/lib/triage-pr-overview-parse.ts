// SIG-376 (SIG-318 Tier-1 6/8): the pure model-response parsing/transform
// cluster lifted out of `triage-pr-overview.ts` so that file stays under
// the 1,000-line budget. These functions are pure relocations — bodies are
// byte-identical to their prior in-file definitions; only the surrounding
// `export` keywords (already public) and the type-import paths differ.
//
// Pure module: no IO, no async, no env reads. Depends only on the shared
// `parseFirstJsonObject` util + the `PrOverviewVerdict` / `CachedFileRow`
// types — `PrOverviewVerdict` is imported TYPE-ONLY from the core (erased
// at runtime, so there is no cycle). It does NOT value-import the core
// `triage-pr-overview.ts`.

import { parseFirstJsonObject } from "../shared/util/json-extract"
import type { PrOverviewVerdict } from "./triage-pr-overview"
import type { CachedFileRow } from "./pr-overview-file-cache"

/**
 * Parse the model's overview response into a typed verdict. Tolerates:
 *   1. Clean JSON object
 *   2. JSON wrapped in a ```json ... ``` fence
 *   3. JSON embedded in surrounding prose ("Here's the overview: { ... }")
 *
 * Returns null when the output contains no valid JSON object that has
 * the required shape, so callers can fail loudly rather than post junk.
 */
export function parseOverviewResponse(text: string): PrOverviewVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const confidence = Number(obj.confidence)
  if (!Number.isFinite(confidence) || confidence < 1 || confidence > 5) return null

  // ARC-263: keep all per-file rows (was capped at 5 here). The
  // schema's `maxItems: 20` is the bound; the renderer truncates to
  // top-5 by score for display.
  const files = Array.isArray(obj.files)
    ? obj.files
        .filter(
          (f): f is Record<string, unknown> =>
            !!f && typeof f === "object" && !Array.isArray(f) && typeof (f as { path?: unknown }).path === "string"
        )
        .filter((f) => (f.path as string).trim().length > 0)
        .slice(0, 20)
        .map((f) => ({
          path: (f.path as string).trim(),
          score: Number.isFinite(Number(f.score))
            ? Math.max(1, Math.min(5, Math.round(Number(f.score))))
            : 3,
          overview: typeof f.overview === "string" ? f.overview.trim() : "",
          nextStep: typeof f.nextStep === "string" ? f.nextStep.trim() : "",
        }))
    : []

  const bullets = Array.isArray(obj.bullets)
    ? obj.bullets
        .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
        .map((b) => b.trim())
    : []

  const confidenceReason =
    typeof obj.confidenceReason === "string" ? obj.confidenceReason.trim() : ""

  // SIG-99: optional polish fields. Each is independently clamped /
  // filtered; nothing fails the parse if any is malformed. Absent
  // fields stay undefined → renderer skips the section.
  const verdict: PrOverviewVerdict = {
    summary,
    files,
    confidence: Math.round(confidence),
    confidenceReason,
    bullets,
  }
  const effortRaw = Number(obj.reviewEffort)
  if (Number.isFinite(effortRaw) && effortRaw >= 1 && effortRaw <= 5) {
    verdict.reviewEffort = Math.round(effortRaw)
  }
  if (Array.isArray(obj.suggestedLabels)) {
    const labels = obj.suggestedLabels
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      // code-reviewer HIGH/MEDIUM catch (pre-PR): label strings are
      // rendered inline as `` `${label}` `` with no escape. A label
      // containing a backtick / newline / pipe would break out of the
      // inline-code span and inject raw markdown. Drop anything with
      // markdown metacharacters.
      .filter((s) => !/[`\n\r|]/u.test(s))
      .slice(0, 3)
    if (labels.length > 0) verdict.suggestedLabels = labels
  }
  if (Array.isArray(obj.suggestedReviewers)) {
    const reviewers = obj.suggestedReviewers
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      // Strip a leading `@` if the model adds one — the renderer
      // adds it back uniformly.
      .map((s) => s.trim().replace(/^@/, ""))
      .filter((s) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s))
      .slice(0, 2)
    if (reviewers.length > 0) verdict.suggestedReviewers = reviewers
  }
  if (Array.isArray(obj.relatedPrUrls)) {
    const urls = obj.relatedPrUrls
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      // code-reviewer MEDIUM catch (pre-PR): tighten path-character
      // class to URL-legal characters only AND anchor with `$`. The
      // previous `[^\s)]+` allowed backticks, brackets, and quotes,
      // letting the model smuggle markdown-meta characters into the
      // rendered list. The new pattern accepts only the GitHub PR
      // URL alphabet (owner/repo charset is conservative + `pull/N`
      // is digits + optional `?query` / `#fragment` tail).
      .filter((s) => /^https:\/\/github\.com\/[A-Za-z0-9_.\-/]+\/pull\/\d+(?:[#?][^\s)`'"]*)?$/.test(s))
      .slice(0, 3)
    if (urls.length > 0) verdict.relatedPrUrls = urls
  }
  if (typeof obj.mermaidDiagram === "string") {
    const m = obj.mermaidDiagram.trim()
    // Defensive: only accept blocks that LOOK like Mermaid (start with
    // a known diagram-kind keyword). Prevents the model from injecting
    // arbitrary markdown that would render outside a code fence.
    //
    // code-reviewer HIGH catch (pre-PR): the prefix-keyword guard
    // alone isn't enough. A payload like
    //   "sequenceDiagram\n```\n# pwned"
    // passes the prefix check but the embedded triple-backtick closes
    // the renderer's mermaid fence early, letting the trailing prose
    // render as top-level markdown. Reject any value containing
    // triple-backtick so the fence stays intact.
    if (
      m.length > 0 &&
      /^(?:sequenceDiagram|flowchart|graph|stateDiagram)/u.test(m) &&
      !m.includes("```")
    ) {
      verdict.mermaidDiagram = m
    }
  }
  return verdict
}

/**
 * ARC-263: build a scoped unified diff string from the cache-miss
 * subset of changed files. Each file with a `patch` field renders as
 * a standard `diff --git a/<path> b/<path>\n<patch>` block. Files
 * without a patch (binary / >500KB per GitHub) are listed in a
 * trailing note so the model knows they changed but has no diff to
 * inspect (no row is emitted for them).
 *
 * If `misses` is empty (defensive — caller should have early-returned)
 * OR every miss has no patch, returns the original full diff as a
 * fallback so the review still runs. Exposed for unit tests.
 */
export function scopedDiffFromMisses(
  misses: ReadonlyArray<{ filename: string; patch?: string; status?: string }>,
  fallbackDiff: string,
): string {
  // CodeRabbit MAJOR catch on PR #81: all-hit case. When `misses` is
  // empty, every file's row came from cache — we should NOT feed the
  // full PR diff to the model (defeats the cost-saving purpose). The
  // model still needs SOME diff context for the cumulative
  // `summary`/`confidence`/`bullets`, but those are PR-level fields
  // and a short placeholder is enough — the model has commit
  // messages + PR title/body from the rest of the prompt.
  if (misses.length === 0) {
    return "[All file rows were served from the walkthrough cache; no fresh per-file patches needed.]"
  }
  const withPatch = misses.filter(
    (f): f is { filename: string; patch: string; status?: string } =>
      typeof f.patch === "string" && f.patch.length > 0,
  )
  if (withPatch.length === 0) {
    // code-reviewer L3 catch (commit 1): every miss is binary /
    // >500KB / patch missing. Fall back to the full diff — review
    // still runs but the cache's cost-saving purpose is defeated for
    // this run. Distinct from the misses.length === 0 path above:
    // here the misses are REAL changes that simply don't have a
    // textual diff, so we need the full context.
    console.log(JSON.stringify({
      event: "pr-overview-scoped-diff-fellback-to-full",
      miss_count: misses.length,
      reason: "no-patches-available",
    }))
    return fallbackDiff
  }
  const blocks = withPatch.map(
    (f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`,
  )
  const noPatch = misses.filter((f) => typeof f.patch !== "string" || f.patch.length === 0)
  let scoped = blocks.join("\n")
  if (noPatch.length > 0) {
    scoped += `\n\n[Files changed but no patch available (binary or >500KB):]\n${noPatch.map((f) => `- ${f.filename}${f.status ? ` (${f.status})` : ""}`).join("\n")}`
  }
  return scoped
}

/**
 * ARC-263: merge cached per-file rows with the Ollama-fresh rows in
 * a verdict. Fresh rows win on path collision (the model just looked
 * at this file's current patch, so its judgment supersedes any
 * stale-by-chance cache hit). Total rows are truncated to top-5 by
 * score for display — the comment table stays concise even when the
 * PR has 20 changed files. Exposed for unit tests.
 */
export function mergeCachedAndFreshRows(
  verdict: PrOverviewVerdict,
  cachedRows: ReadonlyMap<string, CachedFileRow>,
): PrOverviewVerdict {
  const freshPaths = new Set(verdict.files.map((f) => f.path))
  const merged: PrOverviewVerdict["files"] = [...verdict.files]
  for (const row of cachedRows.values()) {
    if (!freshPaths.has(row.path)) merged.push(row)
  }
  merged.sort((a, b) => b.score - a.score)
  return { ...verdict, files: merged.slice(0, 5) }
}
