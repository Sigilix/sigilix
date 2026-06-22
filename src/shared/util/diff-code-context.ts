// SIG-304 (review CLI): slice the unified diff the engine ALREADY has into a small
// per-finding code window for the `--rich` code panel. Pure display evidence — it
// reuses the diff (no re-fetch, no source re-read, no model/engine logic), degrades to
// `undefined` when a finding has no matching hunk, and NEVER affects recall. The
// hunk-walking mirrors diff-positions.ts (same +/-/ctx line accounting) but keeps the
// line TEXT so the renderer can show it.

import type { PrReviewFinding, CodeContext, CodeContextLine } from "@/src/shared/domain/pr-review-finding"

const CTX = 2 // context lines kept on each side of the matched range
const MAX_LINES = 16 // hard cap on a rendered code window

type FindingAnchor = Pick<PrReviewFinding, "path" | "line" | "startLine" | "anchorSide">

/** Parse a unified diff into per-path ordered lines, keeping text + side line numbers. */
export function parseDiffLines(diff: string): Map<string, CodeContextLine[]> {
  const out = new Map<string, CodeContextLine[]>()
  if (!diff || typeof diff !== "string") return out
  const rows = diff.split(/\r?\n/)
  let path: string | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of rows) {
    if (line.startsWith("diff --git ")) {
      path = null
      inHunk = false
      continue
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim()
      path = p === "/dev/null" ? null : p.startsWith("b/") ? p.slice(2) : p
      if (path && !out.has(path)) out.set(path, [])
      inHunk = false
      continue
    }
    if (line.startsWith("--- ")) {
      inHunk = false
      continue
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (!m) {
        inHunk = false
        continue
      }
      oldLine = Number(m[1])
      newLine = Number(m[2])
      inHunk = path !== null
      continue
    }
    if (!inHunk || path === null) continue
    const entries = out.get(path)
    if (!entries) continue
    if (line.startsWith("+")) {
      entries.push({ newNumber: newLine, text: line.slice(1), kind: "add" })
      newLine++
    } else if (line.startsWith("-")) {
      entries.push({ oldNumber: oldLine, text: line.slice(1), kind: "del" })
      oldLine++
    } else if (line.startsWith(" ") || line.length === 0) {
      entries.push({ newNumber: newLine, oldNumber: oldLine, text: line.slice(1), kind: "ctx" })
      oldLine++
      newLine++
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — no counter movement.
      continue
    } else {
      inHunk = false
    }
  }
  return out
}

/** Slice a code window around `finding` from already-parsed diff lines (parse once, reuse). */
export function sliceFromParsed(
  parsed: Map<string, CodeContextLine[]>,
  finding: FindingAnchor,
): CodeContext | undefined {
  const entries = parsed.get(finding.path)
  if (!entries || entries.length === 0) return undefined
  const side: "LEFT" | "RIGHT" = finding.anchorSide === "LEFT" ? "LEFT" : "RIGHT"
  const lo = Math.min(finding.startLine ?? finding.line, finding.line)
  const hi = Math.max(finding.startLine ?? finding.line, finding.line)
  const num = (e: CodeContextLine): number | undefined => (side === "LEFT" ? e.oldNumber : e.newNumber)
  // First/last entry whose side-line falls in the finding's range.
  let first = -1
  let last = -1
  for (let i = 0; i < entries.length; i++) {
    const n = num(entries[i]!)
    if (n !== undefined && n >= lo && n <= hi) {
      if (first === -1) first = i
      last = i
    }
  }
  if (first === -1) return undefined // finding line isn't in any hunk → no panel
  const from = Math.max(0, first - CTX)
  let to = Math.min(entries.length, last + CTX + 1)
  let truncated = false
  if (to - from > MAX_LINES) {
    to = from + MAX_LINES
    truncated = true
  }
  return { side, lines: entries.slice(from, to), ...(truncated ? { truncated: true } : {}) }
}

/** Convenience: slice directly from a raw diff (parses internally). For single use + tests. */
export function sliceCodeContext(diff: string, finding: FindingAnchor): CodeContext | undefined {
  return sliceFromParsed(parseDiffLines(diff), finding)
}

/**
 * Attach `codeContext` to every finding in a review-shaped object from the diff already
 * in hand. Structural (no DryRunReview import → stays a pure shared util). Returns a new
 * object; findings with no matching hunk are returned unchanged (graceful degrade).
 */
export function attachCodeContextToReview<
  R extends { verdict: { findings: readonly PrReviewFinding[] }; unanchoredFindings: readonly PrReviewFinding[] },
>(review: R, diff: string): R {
  const parsed = parseDiffLines(diff)
  const enrich = (f: PrReviewFinding): PrReviewFinding => {
    const ctx = sliceFromParsed(parsed, f)
    return ctx ? { ...f, codeContext: ctx } : f
  }
  return {
    ...review,
    verdict: { ...review.verdict, findings: review.verdict.findings.map(enrich) },
    unanchoredFindings: review.unanchoredFindings.map(enrich),
  }
}
