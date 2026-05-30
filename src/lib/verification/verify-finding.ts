// SIG-285 PR 1 — worker-native, line-anchored verification of a candidate
// finding. NO subprocess, NO new GitHub permissions: the only "execution" is
// re-checking the finding's own cited evidence against the PR diff it was made
// about.
//
// THE SOUND MODEL (DeepSeek): a check cannot PROVE a bug (a passing check only
// shows the cited evidence is real, not that the bug is exploitable) nor prove
// safety (a failing check might mean the check is wrong). So the worker-native
// v1 check answers the one thing it CAN answer soundly + line-anchored: "does
// the code token the finding cites actually appear at the line the finding
// points to?"
//
//   - CONFIRMED    — a cited token is present at the cited line (the citation is
//                    grounded; the finding's evidence is real there).
//   - REFUTED      — the cited line IS in the diff but NONE of the finding's
//                    cited tokens appear on it (a mis-anchored / hallucinated
//                    citation — only this verdict would ever demote, in PR 4).
//   - INCONCLUSIVE — the cited line isn't an added line in this diff (can't
//                    verify worker-native; fail-open).
//   - NO-CHECK     — no checkable token could be derived from the finding.
//
// Demotion is NOT applied here (PR 1 is shadow-only). This module is pure +
// side-effect-free so it's trivially testable; the ensemble calls it and emits
// telemetry.

import type { PrReviewFinding } from "../triage-pr-review"

export type VerificationVerdict = "confirmed" | "refuted" | "inconclusive" | "no-check"

export interface VerificationCheck {
  /** v1 is always a worker-native token-at-line check. */
  kind: "worker-token"
  /** A deterministic descriptor of what was checked — NEVER a shell command,
   *  never executed (named `descriptor`, not `command`, to keep it that way). */
  descriptor: string
  status: "pass" | "fail" | "error" | "skipped"
  /** Compact evidence: the cited line's content (truncated). */
  outputSnippet: string
}

export interface VerificationResult {
  verdict: VerificationVerdict
  /** The tokens derived from the finding (for telemetry / debugging). */
  tokens: string[]
  check?: VerificationCheck
}

const SNIPPET_MAX = 200
const MAX_TOKENS = 6

/**
 * A stable, content-addressed key for a finding so PR 2 can JOIN a verification
 * verdict to the same finding's later SIG-114 dismissal/address outcome. FNV-1a
 * over `path:line:headline` (the same triple the dismissal corpus is keyed by);
 * hex, no crypto needed (collision-resistance isn't security-critical here).
 */
export function findingKey(finding: Pick<PrReviewFinding, "path" | "line" | "headline">): string {
  const s = `${finding.path}:${finding.line}:${finding.headline ?? ""}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

// A token is a backticked span that looks like code (has an identifier, and is
// short). Prose-in-backticks (spaces, sentence-like) is excluded so we don't
// "confirm" on an English phrase. Stop-words guard against trivially-common
// tokens that would CONFIRM everything (e.g. a bare `if`/`return`).
const CODE_TOKEN = /`([^`\n]{1,80})`/g
const IDENTIFIER = /[A-Za-z_$][\w$]*/
const STOP_TOKENS = new Set([
  "if", "for", "while", "return", "true", "false", "null", "undefined",
  "const", "let", "var", "function", "this", "new", "await", "async",
])

/** Extract code-like tokens the finding cites in its headline/body. */
export function deriveTokens(finding: Pick<PrReviewFinding, "headline" | "body">): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const text of [finding.headline, finding.body]) {
    if (typeof text !== "string") continue
    for (const m of text.matchAll(CODE_TOKEN)) {
      const tok = (m[1] ?? "").trim()
      if (!tok || seen.has(tok)) continue
      // A checkable token is a single code span (no whitespace — a multi-word
      // backticked span is prose like `really bad`, and a substring `includes`
      // on prose would falsely CONFIRM; reject it), contains an identifier, and
      // isn't a bare common keyword that would match almost any line.
      if (/\s/.test(tok)) continue
      if (!IDENTIFIER.test(tok)) continue
      // Reject ~1-char tokens: `includes("x")` is a near-tautology that would
      // manufacture spurious CONFIRMEDs and depress the refutable-FP fraction
      // this experiment exists to measure (count identifier chars so `a.` etc.
      // can't sneak a 1-letter check past the punctuation).
      if (tok.replace(/[^A-Za-z0-9_$]/g, "").length < 2) continue
      if (STOP_TOKENS.has(tok.toLowerCase())) continue
      seen.add(tok)
      out.push(tok)
      if (out.length >= MAX_TOKENS) return out
    }
  }
  return out
}

/**
 * Verify one finding against the diff it was made about. Pure. The caller
 * decides what to do with the verdict (PR 1: telemetry only).
 */
export function verifyFinding(
  finding: Pick<PrReviewFinding, "path" | "line" | "headline" | "body">,
  addedLineIndex: ReadonlyMap<string, ReadonlyMap<number, string>>,
): VerificationResult {
  const tokens = deriveTokens(finding)
  if (tokens.length === 0) {
    return { verdict: "no-check", tokens }
  }

  const lineContent = addedLineIndex.get(finding.path)?.get(finding.line)
  if (lineContent === undefined) {
    // The cited line isn't an added line in this diff — nothing to check
    // worker-native (the worker only has the diff, not the full file). Fail-open.
    return {
      verdict: "inconclusive",
      tokens,
      check: {
        kind: "worker-token",
        descriptor: `token-at-line --path ${finding.path} --line ${finding.line} --tokens ${tokens.join(",")}`,
        status: "skipped",
        outputSnippet: "",
      },
    }
  }

  // Line-anchored: a token must appear ON the cited line — a match elsewhere in
  // the file must NOT confirm (that's the false-refutation trap DeepSeek flagged).
  const present = tokens.some((t) => lineContent.includes(t))
  return {
    verdict: present ? "confirmed" : "refuted",
    tokens,
    check: {
      kind: "worker-token",
      descriptor: `token-at-line --path ${finding.path} --line ${finding.line} --tokens ${tokens.join(",")}`,
      status: present ? "pass" : "fail",
      outputSnippet: lineContent.slice(0, SNIPPET_MAX),
    },
  }
}
