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

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

export type VerificationVerdict = "confirmed" | "refuted" | "inconclusive" | "no-check"

export interface VerificationCheck {
  /** v1 = worker-native token-at-line (verify-finding.ts). `receipt-join` =
   *  SIG-285 v2 PR1, joining the finding to the SIG-184 runner receipt's HEAD
   *  SARIF (verify-finding-receipt.ts). Both deterministic, never executed. */
  kind: "worker-token" | "receipt-join"
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
  "if",
  "for",
  "while",
  "return",
  "true",
  "false",
  "null",
  "undefined",
  "const",
  "let",
  "var",
  "function",
  "this",
  "new",
  "await",
  "async",
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
 * Is `token` present at `line` as a WHOLE token, not a substring? A bare
 * `includes` would falsely CONFIRM `id` inside `userId` / `valid` (CR). For an
 * identifier-like token, enforce lexical boundaries; for a symbolic/code-shape
 * token (e.g. `db.query`), the punctuation already makes a substring specific
 * (and `\b` is ill-defined around dots/parens), so an exact substring is right.
 */
export function tokenPresentAtLine(line: string, token: string): boolean {
  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`).test(line)
  }
  return line.includes(token)
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
  const present = tokens.some((t) => tokenPresentAtLine(lineContent, t))
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

/** The finding shape `selectRefutedInlineDemotions` needs (a verifiable finding
 *  plus the eligibility fields). `startLine` gates the range fail-open below. */
type DemotableFinding = Pick<
  PrReviewFinding,
  "path" | "line" | "headline" | "body" | "score" | "category" | "startLine" | "anchorSide"
>

/**
 * SIG-285 PR 4: of the currently-INLINE findings, which are demotable — i.e. a
 * score>=4 logic/security finding whose cited token is REFUTED (mis-anchored)?
 * Pure + side-effect-free so the demote decision is unit-testable in isolation;
 * the ensemble applies the move (inline -> body) only in `enforce`. Body-only
 * findings are never passed here (they're already in the body). The eligibility
 * (score>=4, logic/security) matches the verdict-telemetry filter, so the demote
 * set is exactly the REFUTED subset of what the metrics already count.
 *
 * FAIL-OPEN on RANGE findings (Codex #257): `verifyFinding` only checks the cited
 * END line (`finding.line`), so a multi-line finding (`startLine < line`) whose
 * token sits on an earlier line of the range would FALSE-refute. Never demote a
 * range finding — FN-cost >> FP-cost, so an unverifiable range stays inline.
 */
export function selectRefutedInlineDemotions<T extends DemotableFinding>(
  inlineFindings: ReadonlyArray<T>,
  addedLineIndex: ReadonlyMap<string, ReadonlyMap<number, string>>,
): T[] {
  return inlineFindings.filter(
    (f) =>
      f.score >= 4 &&
      (f.category === "logic" || f.category === "security") &&
      (f.startLine === undefined || f.startLine === f.line) && // single-line only
      // SIG-463: a LEFT (deleted-line) anchor points at REMOVED code; `verifyFinding`
      // checks the ADDED-line index and would FALSE-refute it (the colliding new-line
      // content lacks the deleted token) → wrong body-demote. Exempt it (FN-safe; the
      // anchor was already content-matched to the unique deleted line).
      f.anchorSide !== "LEFT" &&
      verifyFinding(f, addedLineIndex).verdict === "refuted",
  )
}

/**
 * SIG-285 PR 4: apply the inline->body demotion, keeping the per-finding
 * `markers` array index-aligned to the kept inline findings. The review builder
 * indexes findingMarkers by the inline finding's ORIGINAL verdict.findings
 * position (SIG-127), so removing a finding from the inline array WITHOUT
 * removing its marker in lockstep would attach the wrong finding's dismissal
 * marker to every later inline comment — silently corrupting the cross-PR
 * review-memory corpus. Pure: returns the new arrays; the caller assigns them.
 */
export function applyRefutedDemotion<T>(
  inlineFindings: ReadonlyArray<T>,
  markers: ReadonlyArray<string | null>,
  toDemote: ReadonlySet<T>,
): { keptFindings: T[]; keptMarkers: Array<string | null>; demoted: T[] } {
  const keptFindings: T[] = []
  const keptMarkers: Array<string | null> = []
  const demoted: T[] = []
  for (let i = 0; i < inlineFindings.length; i++) {
    const f = inlineFindings[i] as T
    if (toDemote.has(f)) {
      demoted.push(f)
      continue
    }
    keptFindings.push(f)
    keptMarkers.push(markers[i] ?? null)
  }
  return { keptFindings, keptMarkers, demoted }
}

/** SIG-285 re-anchor (inline-first): where a refuted finding's cited tokens
 *  actually live in the same file's added lines. */
export type ReanchorDecision =
  /** Exactly one added line (≠ the cited line) holds ALL cited tokens — the
   *  unambiguous re-anchor target. The inline-first fix: move the comment here
   *  instead of body-demoting it. (The "from" is the finding's current `line`,
   *  known at the call site — not duplicated here.) */
  | { kind: "reanchor"; toLine: number; tokens: string[] }
  /** >1 added line holds all tokens — don't guess; fall back to body-demote. */
  | { kind: "ambiguous"; candidateLines: number[]; tokens: string[] }
  /** No same-file added line holds all tokens — outside-the-diff or a
   *  hallucination; fall back to body-demote. */
  | { kind: "no-match"; tokens: string[] }

/**
 * SIG-285 (Trust Ledger / inline-first): for a finding ALREADY KNOWN to be
 * REFUTED + eligible (the caller filters via `selectRefutedInlineDemotions`),
 * decide whether it can be RE-ANCHORED to the correct added line rather than
 * body-demoted. Pure + side-effect-free.
 *
 * Safety boundary (Codex #257): a candidate added line qualifies only if it
 * holds ALL of the finding's cited tokens (stricter than `verifyFinding`'s
 * any-token rule), and ONLY the unambiguous "exactly one same-file line" case
 * re-anchors. Ambiguous (>1) / no-match → the caller keeps PR4's body-demote.
 * Same-file only in v0 (no cross-file re-anchor).
 *
 * The "refuted + single-line + score>=4 logic/security" precondition is a CALLER
 * contract (`selectRefutedInlineDemotions`), an optimization — not a safety
 * requirement: this function is SAFE on any input (a range / off-line / multi-line
 * finding simply yields `ambiguous` or `no-match`, never a wrong re-anchor), so
 * there's no throwing assert — a throw in the review path would be an FN risk
 * (CodeRabbit #259).
 *
 * TODO (mutation PR): before actually moving an inline comment to `toLine`,
 * re-run the SIG-127 structural-substantive check on it — `toLine` could be a
 * non-substantive added line (e.g. a bare `}`) that GitHub renders awkwardly;
 * fall back to body-demote in that case. This shadow measurement does not move
 * anything, so the guard isn't needed yet.
 */
export function planReanchor(
  finding: Pick<PrReviewFinding, "path" | "line" | "headline" | "body">,
  addedLineIndex: ReadonlyMap<string, ReadonlyMap<number, string>>,
): ReanchorDecision {
  const tokens = deriveTokens(finding)
  if (tokens.length === 0) return { kind: "no-match", tokens } // no checkable token (shouldn't happen for refuted)
  const fileLines = addedLineIndex.get(finding.path)
  if (fileLines === undefined) return { kind: "no-match", tokens }
  const candidates: number[] = []
  for (const [line, text] of fileLines) {
    if (line === finding.line) continue // the cited line is where it's ABSENT (that's the refutation)
    if (tokens.every((t) => tokenPresentAtLine(text, t))) candidates.push(line)
  }
  if (candidates.length === 1) return { kind: "reanchor", toLine: candidates[0] as number, tokens }
  if (candidates.length > 1) return { kind: "ambiguous", candidateLines: candidates.sort((a, b) => a - b), tokens }
  return { kind: "no-match", tokens }
}

/** One applied re-anchor (for telemetry). */
export interface ReanchorApplied {
  index: number
  path: string
  fromLine: number
  toLine: number
}

/**
 * SIG-285 re-anchor ENFORCE (inline-first mutation): for each refuted inline
 * finding that has an UNAMBIGUOUS re-anchor target, MOVE it to the correct line
 * — IN PLACE — keeping the marker source aligned. Mutates BOTH `inlineFindings[i]`
 * (the inline render source) AND `markerSourceFindings[i]` (the marker fid is
 * built from this, and the fid includes `line`; they're index-aligned, so both
 * must move or the cross-PR dismissal corpus would key the finding on a stale
 * line). Returns the applied moves for telemetry. Callers MUST invoke this BEFORE
 * marker generation so the markers are built from the post-move line.
 *
 * Same eligibility + safety as `selectRefutedInlineDemotions` + `planReanchor`
 * (refuted, single-line, score>=4 logic/security, exactly one same-file line with
 * ALL cited tokens), PLUS a SIG-127 structural-substantive guard on the target
 * line (`isSubstantive`, injected) — never move a comment onto a bare `}`/blank
 * line. Anything that doesn't qualify is left untouched (the caller's PR4
 * body-demote then handles the still-refuted findings).
 */
export function applyReanchors<T extends DemotableFinding>(
  inlineFindings: T[],
  markerSourceFindings: ReadonlyArray<{ line: number } | undefined>,
  addedLineIndex: ReadonlyMap<string, ReadonlyMap<number, string>>,
  isSubstantive: (text: string | undefined) => boolean,
): ReanchorApplied[] {
  const applied: ReanchorApplied[] = []
  for (let i = 0; i < inlineFindings.length; i++) {
    const f = inlineFindings[i]
    if (f === undefined) continue
    // SIG-463: never re-anchor a LEFT (deleted-line) anchor onto a RIGHT added line
    // — it intentionally points at REMOVED code (same exemption as the refute-demote
    // selector; verifyFinding would FALSE-refute it against the added-line index).
    if (f.anchorSide === "LEFT") continue
    // Eligibility = the selectRefutedInlineDemotions contract (refuted subset).
    if (f.score < 4) continue
    if (f.category !== "logic" && f.category !== "security") continue
    if (f.startLine !== undefined && f.startLine !== f.line) continue
    if (verifyFinding(f, addedLineIndex).verdict !== "refuted") continue
    const plan = planReanchor(f, addedLineIndex)
    if (plan.kind !== "reanchor") continue
    // SIG-127: don't move the inline comment onto a non-substantive target line.
    if (!isSubstantive(addedLineIndex.get(f.path)?.get(plan.toLine))) continue
    const fromLine = f.line
    f.line = plan.toLine // move the render source
    // Keep a single-line finding single-line at the new position. Eligibility
    // already requires startLine===undefined || startLine===line, so an explicit
    // startLine equals the OLD line; leaving it stale would turn the finding into
    // a bogus range (old startLine → new line) that GitHub renders as a multi-line
    // comment (Codex #260).
    if (f.startLine !== undefined) f.startLine = plan.toLine
    const ms = markerSourceFindings[i]
    if (ms !== undefined) ms.line = plan.toLine // move the marker source, in lockstep
    applied.push({ index: i, path: f.path, fromLine, toLine: plan.toLine })
  }
  return applied
}
