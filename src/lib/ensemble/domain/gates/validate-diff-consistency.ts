// SIG-602 v1: diff-consistency gate — demote a finding whose OWN claim is
// DETERMINISTICALLY CONTRADICTED by the PR diff or by the finding's own body.
//
// This is the soundness companion to the two grounding gates it sits beside:
//   - inline-grounding (SIG-281) asks "is this weak nit anchored to changed code?"
//   - absence-grounding (SIG-290) asks "could the bot have SEEN the evidence for
//     this absence-claim?" (out-of-window ⇒ guess ⇒ demote)
//   - THIS gate asks the sharper question: "is the evidence right here in the diff,
//     and does it FLATLY CONTRADICT the claim?" It fires only on a provable
//     contradiction, never on mere weak grounding.
//
// Motivated by a real over-fire batch (a user reported 13/15 inline findings
// were false positives a deterministic pass would have caught): a test file
// reported missing though it was in the PR; an unexported Go function described
// as exported; a title that contradicted its own explanation. Three of those
// classes are deterministically checkable against the diff + the finding's own
// text; this gate implements exactly those three, each with keep-on-ambiguity
// guards. The guards are strong but NOT infallible (natural-language claims
// have edge cases), so the gate ships `off`, is measured in `shadow` against a
// human-labeled false-positive audit, and only then flips to `enforce`.
// Known residual (accepted, audited in shadow): a bare-basename "missing
// `foo.go`" whose ONE diff match is at a different directory could still fire.
//
//   (1) self-contradiction        — the HEADLINE asserts an absence while the
//                                    BODY affirms the SAME token is present.
//   (2) claimed-missing-file-present — the finding says a specific FILE is
//                                    missing/absent, but that file IS in the
//                                    PR's reviewable diff.
//   (3) export-status-contradicted — a Go finding calls a symbol "exported"
//                                    (resp. "unexported") but the identifier's
//                                    Go capitalization says the opposite.
//
// FALSE-POSITIVE SAFETY (biases HARD toward KEEP — recall-safety is a hard rule):
//   - Every check requires a PROVABLE contradiction; any ambiguity keeps.
//   - Self-contradiction keeps the moment the BODY itself mentions an absence
//     (a nuanced "present on the happy path but missing on the error branch"
//     is a REAL finding, never suppressed).
//   - claimed-missing-file-present keeps when the file token is a LOCATION
//     ("missing null check in `foo.go`", foo.go in the PR) rather than the
//     missing thing itself.
//   - export-status-contradicted is scoped to `.go` findings, to the
//     unambiguous Go terms "exported"/"unexported" (never the overloaded
//     "public"/"private"), and — when the diff is wired — to identifiers that
//     actually appear in the changed lines.
//   - No diff/paths wired ⇒ the file/identifier checks no-op (back-compat).
//
// The classes NOT implemented here are deliberate: guard-presence (already
// covered for logic misreads by window-blindness, SIG) and any check needing a
// Go AST (mutex-scope, negative-slice-index semantics) — the ast-rules engine
// is JS/TS-only, so those need new infrastructure and are a separate track.
//
// SHADOW-FIRST: the demotion is gated behind
//   `SIGILIX_DIFF_CONSISTENCY_VALIDATOR_MODE` (off | shadow | enforce, default
//   off) at the call site. `off` ⇒ the gate never runs; `shadow` ⇒ counts /
//   telemeters what WOULD be demoted but keeps every finding inline (zero
//   behavior change); only `enforce` demotes. This module is pure and
//   mode-agnostic.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

/**
 * Validator mode. `off` (default): the gate doesn't run. `shadow`:
 * telemeter what WOULD be demoted but keep every finding inline. `enforce`:
 * demote contradicted findings to the review body. Three-state with `off`
 * as the cautious default — matches the off|shadow|enforce idiom of
 * `parseAbsenceClaimValidatorMode` / `parseWindowBlindnessValidatorMode`.
 */
export type DiffConsistencyValidatorMode = "off" | "shadow" | "enforce"

/**
 * Parse `SIGILIX_DIFF_CONSISTENCY_VALIDATOR_MODE`. Case-insensitive,
 * whitespace-tolerant; any unknown / missing value resolves to `off` — the
 * cautious default that disables the gate entirely.
 */
export function parseDiffConsistencyValidatorMode(raw: string | undefined): DiffConsistencyValidatorMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/** The three provable-contradiction shapes this gate detects. */
export type DiffConsistencyDropReason =
  | "self-contradiction"
  | "claimed-missing-file-present"
  | "export-status-contradicted"

export type DiffConsistencyDecision = { keep: true } | { keep: false; reason: DiffConsistencyDropReason }

export interface DiffConsistencyContext {
  /** Paths present in the PR's reviewable diff (changed-file set) — the
   *  ground truth the "missing file" claim is checked against. */
  reviewablePaths: ReadonlySet<string>
  /**
   * Per-file new-side added-line text (the same map inline-grounding uses:
   * `buildAddedLineTextByLine` output — inner map keyed by line number,
   * values are the added line text with the leading "+" stripped). Used to
   * confirm an export-claim's identifier is a real token in the changed
   * code. Undefined when the diff isn't wired (back-compat) — then the
   * export check keeps.
   */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
}

// --- Small pure helpers -----------------------------------------------

/** Escape a string for literal use inside a RegExp (file tokens carry
 *  `.` `/` `-`; identifiers are clean but escaping them is harmless). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Backticked `code` spans in a single string, trimmed and de-duplicated. */
function backtickTokensIn(text: string): string[] {
  const out: string[] = []
  const re = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tok = (m[1] ?? "").trim()
    if (tok.length > 0) out.push(tok)
  }
  return [...new Set(out)]
}

/** basename of a slash-path token. */
function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

// An absence assertion anywhere in a string ("missing", "lacks", "no null
// check", "is not defined", "does not exist"). Kept deliberately broad — it
// is used BOTH to detect a headline absence-claim AND, for self-
// contradiction, to KEEP the moment the body also concedes an absence.
const ABSENCE_MARKER =
  /\b(?:missing|lacks?|lacking|absent|without|(?:is|are|was|were)\s+(?:not|never)\s+(?:present|defined|declared|added|handled|checked|guarded|initialized)|(?:does|do)\s+not\s+exist|doesn'?t\s+exist|no\s+(?:\w+\s+){0,3}(?:check|guard|validation|test|coverage|handling|nil\s*check|null\s*check))\b/i

// A nuance / qualifier / negation anywhere in the body ⇒ the body is making a
// PARTIAL or CONDITIONAL statement ("defined but never called", "included but
// not set", "present only on the happy path"), not conceding the headline is
// simply wrong. The self-contradiction keep-guard must be a SUPERSET of the
// presence verbs (code-reviewer FP-3): a "defined-but-not-invoked" or
// "present-but-not-set" bug is real and must never be demoted. Bias to KEEP.
const NUANCE_MARKER =
  /\b(?:but|however|although|though|except|unless|only|not|never|n't|no\s+longer|fails?\s+to|doesn'?t|does\s+not|isn'?t|aren'?t|wasn'?t|weren'?t)\b/i

// A presence affirmation about a specific identifier T (built per-token). The
// identifier sits next to an "is/are/already/does + present/defined/exists…"
// clause, in either order, within a short same-sentence window.
function presenceAffirmationRegex(token: string): RegExp {
  const t = escapeRegExp(token)
  const PRESENT = "(?:present|defined|declared|exists?|added|initialized|handled|guarded|checked|set|there|included)"
  return new RegExp(
    // "`T` is/are/was/already/does … present/defined/…"
    `\`?\\b${t}\\b\`?[^\`.!?\\n]{0,60}?\\b(?:is|are|was|were|already|does|do|indeed|has|have)\\b[^\`.!?\\n]{0,25}?\\b${PRESENT}\\b` +
      // …or the reverse: "already defines/adds/includes the `T`"
      `|\\b(?:already|indeed)\\b[^\`.!?\\n]{0,25}?\\b(?:${PRESENT}|defines?|adds?|includes?|declares?)\\b[^\`.!?\\n]{0,60}?\`?\\b${t}\\b\`?`,
    "i",
  )
}

// --- Check 1: self-contradiction --------------------------------------
//
// The HEADLINE asserts an absence about identifier T; the BODY affirms that
// SAME T is present — and the BODY does NOT itself assert any absence. That
// last guard is what makes it FP-safe: a real, nuanced finding whose body
// says "the guard is present on the happy path but MISSING on the error
// branch" trips the body-absence guard and is KEPT.
function evaluateSelfContradiction(finding: PrReviewFinding): DiffConsistencyDecision {
  const headline = finding.headline ?? ""
  const body = finding.body ?? ""
  if (!ABSENCE_MARKER.test(headline)) return { keep: true } // no absence claim in the title
  if (ABSENCE_MARKER.test(body)) return { keep: true } // body concedes an absence ⇒ nuanced, keep
  if (NUANCE_MARKER.test(body)) return { keep: true } // body is qualified/negated ⇒ too subtle to call a flat contradiction

  const headlineIdents = backtickTokensIn(headline).filter((t) => t.length >= 2 && /^[A-Za-z_$][\w$.]*$/.test(t))
  for (const t of headlineIdents) {
    if (presenceAffirmationRegex(t).test(body)) {
      return { keep: false, reason: "self-contradiction" }
    }
  }
  return { keep: true }
}

// --- Check 2: claimed-missing-file-present ----------------------------
//
// The finding says a specific FILE is missing/absent, but that file is in the
// PR's reviewable diff. FP-safe: the absence marker must attach to the file
// TOKEN itself (within a few words), and the file must NOT be introduced by a
// locational preposition ("in/of/within `foo.go`" — there the file is where a
// DIFFERENT thing is missing, not the missing thing).
const FILE_TOKEN = /^[\w./@-]+\.[A-Za-z0-9]{1,8}$/ // has an extension
// A preposition immediately before the file token (allowing an opening
// quote/backtick between) that makes the file the REFERENT, not the missing
// thing: "missing null check in `foo.go`" (location) or "missing test FOR
// `foo.go`" / "no coverage COVERING `foo.go`" (the test is missing, the file
// is present). `for|to|covering` are essential — the tests-specialist's most
// common shape names a present file as the subject of a missing test.
const LOCATIONAL_BEFORE = /\b(?:in|of|within|from|at|inside|into|on|for|to|covering)\s+[`"']?$/i

function fileIsInDiff(token: string, reviewablePaths: ReadonlySet<string>): boolean {
  if (reviewablePaths.has(token)) return true
  // Token carries a directory ⇒ require a path-suffix match (a real path
  // fragment), never a loose basename hop.
  if (token.includes("/")) {
    for (const p of reviewablePaths) {
      if (p === token || p.endsWith(`/${token}`)) return true
    }
    return false
  }
  // Bare basename ⇒ only when EXACTLY ONE reviewable path has it. A basename
  // shared by multiple paths (`types.go`, `index.ts`) is ambiguous — we can't
  // prove the claimed-missing file is the present one, so KEEP (FP-safe).
  const base = token
  let matches = 0
  for (const p of reviewablePaths) {
    if (basename(p) === base && ++matches > 1) return false
  }
  return matches === 1
}

// A test/coverage ARTIFACT noun (not "file"). When one of these sits between
// the absence marker and the file token ("without tests `foo.ts`"), the missing
// thing is the TESTS/COVERAGE *for* a present source file — not the file — so we
// KEEP. The `file` carve-out preserves "missing test FILE `foo_test.go`" (there
// the file itself is the missing artifact) → that still demotes. (SIG-602 audit.)
const TEST_ARTIFACT = /\b(?:tests?|coverage|specs?|assertions?|untested)\b/i

function evaluateMissingFileInSegment(seg: string, reviewablePaths: ReadonlySet<string>): DiffConsistencyDecision {
  const fileTokens = backtickTokensIn(seg).filter((t) => FILE_TOKEN.test(t))
  for (const f of fileTokens) {
    if (!fileIsInDiff(f, reviewablePaths)) continue
    const fe = escapeRegExp(f)
    // Absence marker attached to THIS file token (0-4 words before it). Bare
    // "no" is deliberately excluded ("no changes to `foo.go`" = leave it alone,
    // the opposite of missing); the real "file is missing" phrasings are below.
    const absenceOfFile = new RegExp(
      `\\b(?:missing|absent|lacks?|lacking|without|needs?|need\\s+to\\s+add|should\\s+add|add\\s+a|create\\s+a)\\b(?:\\s+\\w+){0,4}?\\s+[\`"']?${fe}`,
      "i",
    )
    const match = absenceOfFile.exec(seg)
    if (!match) continue
    const idx = seg.indexOf(f, match.index)
    // Locational: "missing null check in `foo.go`" — the file is a location.
    if (LOCATIONAL_BEFORE.test(seg.slice(0, idx))) continue
    // Test/coverage-subject: "without tests `foo.ts`" — tests are missing, not
    // the file (unless the phrase names it as the missing FILE).
    const span = seg.slice(match.index, idx)
    if (TEST_ARTIFACT.test(span) && !/\bfile\b/i.test(span)) continue
    return { keep: false, reason: "claimed-missing-file-present" }
  }
  return { keep: true }
}

function evaluateMissingFilePresent(
  finding: PrReviewFinding,
  reviewablePaths: ReadonlySet<string>,
): DiffConsistencyDecision {
  if (reviewablePaths.size === 0) return { keep: true } // diff not wired ⇒ no ground truth
  // Evaluate headline and body SEPARATELY: an absence claim in the headline
  // ("... ships without tests") must NOT bind to a filename that merely leads
  // the body ("`server/auth.ts` is a new module") — the SIG-602 audit FP where
  // a real, correct "no tests for a present file" finding was demoted.
  for (const seg of [finding.headline ?? "", finding.body ?? ""]) {
    const decision = evaluateMissingFileInSegment(seg, reviewablePaths)
    if (!decision.keep) return decision
  }
  return { keep: true }
}

// --- Check 3: export-status-contradicted (Go) -------------------------
//
// A `.go` finding calls a backticked identifier "exported" when Go's
// capitalization rule (leading upper-case ⇒ exported) says it is NOT — or
// vice versa. Scoped to the unambiguous Go terms only; "public"/"private" are
// deliberately excluded (overloaded: "public API", HTTP-public, …). When the
// diff is wired, the identifier must also appear in the changed lines, so a
// stray English word can't masquerade as a symbol.
function identifierInChangedLines(
  ident: string,
  path: string,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined,
): boolean {
  if (addedLineTextByLine === undefined) return true // not wired ⇒ don't require it
  const lineMap = addedLineTextByLine.get(path)
  if (!lineMap || lineMap.size === 0) return false
  const wordRe = new RegExp(`\\b${escapeRegExp(ident)}\\b`)
  for (const lineText of lineMap.values()) {
    if (wordRe.test(lineText)) return true
  }
  return false
}

function evaluateExportStatus(finding: PrReviewFinding, ctx: DiffConsistencyContext): DiffConsistencyDecision {
  if (!finding.path.endsWith(".go")) return { keep: true }
  const text = `${finding.headline ?? ""} ${finding.body ?? ""}`
  if (!/\b(?:un-?exported|exported)\b/i.test(text)) return { keep: true }

  const idents = backtickTokensIn(text).filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))
  for (const ident of idents) {
    const t = escapeRegExp(ident)
    // "not exported" / "isn't exported" / "un-exported" / "unexported" ⇒ an
    // UNEXPORTED claim; a bare "exported" near the token ⇒ an EXPORTED claim.
    const unexportedClaim = new RegExp(
      `\`?\\b${t}\\b\`?[^\`.!?\\n]{0,30}?\\b(?:un-?exported|not\\s+exported|isn'?t\\s+exported)\\b` +
        `|\\b(?:un-?exported|not\\s+exported)\\b[^\`.!?\\n]{0,30}?\`?\\b${t}\\b\`?`,
      "i",
    )
    const exportedClaim = new RegExp(
      `\`?\\b${t}\\b\`?[^\`.!?\\n]{0,30}?\\b(?:is|as|being|marked)\\b[^\`.!?\\n]{0,15}?\\bexported\\b` +
        `|\\bexported\\b[^\`.!?\\n]{0,20}?\`?\\b${t}\\b\`?`,
      "i",
    )
    const isExportedByCase = /^[A-Z]/.test(ident)
    const claimsUnexported = unexportedClaim.test(text)
    const claimsExported = !claimsUnexported && exportedClaim.test(text)
    if (!claimsUnexported && !claimsExported) continue
    const contradicted = claimsExported ? !isExportedByCase : isExportedByCase
    if (!contradicted) continue
    if (!identifierInChangedLines(ident, finding.path, ctx.addedLineTextByLine)) continue
    return { keep: false, reason: "export-status-contradicted" }
  }
  return { keep: true }
}

/**
 * Pure decision for ONE finding. Mode-agnostic — the orchestrator gates the
 * demotion behind off/shadow/enforce. Never throws, no I/O. Each check is
 * independent and biases toward KEEP; the first provable contradiction wins.
 */
export function evaluateDiffConsistency(
  finding: PrReviewFinding,
  ctx: DiffConsistencyContext,
): DiffConsistencyDecision {
  const self = evaluateSelfContradiction(finding)
  if (!self.keep) return self

  const file = evaluateMissingFilePresent(finding, ctx.reviewablePaths)
  if (!file.keep) return file

  return evaluateExportStatus(finding, ctx)
}

// SIG-602 shadow-first; a brand-new gate ships `off` and is measured in
// `shadow` against the dismissal corpus before any `enforce`.
