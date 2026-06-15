// CI-failure triage → review-synth (grounded inline). PR 1: pure core only.
//
// Today CI triage (`triage-ci.ts`) makes an UNGROUNDED glm-5.1 call and posts a
// standalone sticky with no grounding gate — it can post a confidently-wrong
// root cause (the #24 "syntax error"). This module folds CI triage into the
// review synth + grounding stack so a CI-derived diagnosis lands as a grounded
// inline review finding, inheriting the same believability gates.
//
// Mirrors `ci-suggestions.ts`'s pure/IO split: THIS file is the pure core
// (flag parse, synth user-message builder, the two stacked gates, the
// disposition rule, the dedup predicate, the presentation renderer). The IO —
// the `runSynthesizer` call, `prepareReviewSubmissionFindings`, the GitHub
// reads/writes, and the wiring into `runCiTriage` — is PR 2. The whole feature
// is dark in PR 1: `OPENCLAW_CI_TRIAGE_SYNTH_MODE` defaults to "off" and
// nothing here is called from the handler yet.
//
// The KEY gate is the log-grounding check (`isLogGrounded`): each CI finding
// must quote a verbatim excerpt from the fetched failure log, and we
// substring-verify it (whitespace-normalized) against the real log. Combined
// with diff-anchoring (PR 2, via `prepareReviewSubmissionFindings`) this closes
// the #24 hole — a fabrication can't quote a log line that doesn't exist.

/**
 * CI-triage synth rollout mode. Mirrors the `off | shadow | enforce` idiom
 * used by the per-validator knobs (e.g. `parseInvariantLensMode`).
 *
 *   - "off"     — the legacy standalone CI-triage path runs unchanged
 *                 (default; the reversible fallback). PR 1 ships here.
 *   - "shadow"  — run the synth + ground + dedup pass and telemeter it, post
 *                 nothing new. (Wired in PR 2.)
 *   - "enforce" — post the grounded inline findings; suppress the legacy
 *                 sticky + SIG-333 suggestions. (Wired in PR 2.)
 */
export type CiTriageSynthMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_CI_TRIAGE_SYNTH_MODE`. Anything other than the literal
 * "shadow" or "enforce" (trimmed, case-insensitive) resolves to "off" — the
 * safe default for a dark-shipped, staged rollout. Mirrors
 * `parseCiSuggestionsMode` (ci-suggestions.ts:28): unknown token → safer
 * default. Default OFF means PR 1 has zero production behavior change.
 */
export function parseCiTriageSynthMode(raw: string | undefined): CiTriageSynthMode {
  const token = (raw ?? "").trim().toLowerCase()
  if (token === "enforce") return "enforce"
  if (token === "shadow") return "shadow"
  return "off"
}

/**
 * Marker stamped on the CI-triage-synth review so a re-delivery of the same
 * failed run can detect it already posted and skip (idempotency, PR 2). Scoped
 * by `(headSha, runId)` at the call site so a LATER distinct failed run on the
 * same head is NOT suppressed. Distinct from `<!-- sigilix:ci-triage -->`
 * (the legacy sticky) and `<!-- sigilix:ci-suggestion -->` (SIG-333).
 */
export const CI_REVIEW_MARKER = "<!-- sigilix:ci-review -->"

// ───────────────────────────── synth user message ──────────────────────────

/** One source file's current contents, threaded into the synth evidence. */
export interface CiFileContext {
  path: string
  content: string
}

export interface CiSynthEvidence {
  /** The fetched failure log (concatenated failed-job logs). */
  ciLog: string
  /** The PR's unified diff — the synth needs it to anchor findings. */
  diff: string
  /** Current contents of the files the log named. */
  fileContexts: readonly CiFileContext[]
}

/**
 * Build the synth USER message from the CI evidence (pure). Threads the diff so
 * the synth can anchor findings to changed lines, labels the failure log so the
 * CI preamble's grounding contract applies, and instructs grounded,
 * diff-anchored findings each carrying a verbatim `logExcerpt`.
 *
 * Section labels match the CI preamble (`CI_SYNTH_PREAMBLE`, ci-synth.ts) and
 * the legacy CI prompt (`[FAILED CI LOG]`, triage-ci.ts:522) so the model sees
 * a consistent frame. Truncation/token-capping is applied by the caller (PR 2)
 * before this is sent — this builder is pure shaping only.
 */
export function buildCiSynthUserMessage(evidence: CiSynthEvidence): string {
  const sections: string[] = [
    "A CI workflow failed on this pull request. Diagnose the failure(s) and emit grounded, diff-anchored findings.",
    "Each finding MUST carry a verbatim `logExcerpt` copied character-for-character from the [FAILED CI LOG] below, and its path/line MUST anchor to a line this PR's diff changed.",
    "",
    "[PR DIFF]",
    evidence.diff,
    "",
    "[FAILED CI LOG]",
    evidence.ciLog,
  ]

  if (evidence.fileContexts.length > 0) {
    sections.push("", "[AFFECTED FILE CONTEXT]")
    for (const file of evidence.fileContexts) {
      sections.push(`--- ${file.path} ---`, file.content, "")
    }
  }

  return sections.join("\n").trimEnd()
}

// ─────────────────────────── log-grounding gate ────────────────────────────

/**
 * Collapse all whitespace runs to a single space and trim, so an excerpt's
 * leading indentation / trailing newline / internal column alignment doesn't
 * defeat the substring check. (The model commonly re-indents a copied log
 * line.) Lowercase is intentionally NOT applied — log error codes are
 * case-meaningful ("TS2339" vs "ts2339").
 */
function normalizeForLogMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * The KEY gate (pure): is `logExcerpt` a verbatim span of the CI log? Both the
 * excerpt and the log are whitespace-normalized, then we substring-check the
 * excerpt against the log. An empty/whitespace-only excerpt is NOT grounded (a
 * finding that quotes nothing can't be corroborated). A genuine finding — the
 * model was handed the real log — quotes a real line and corroborates; a
 * fabrication can't quote a log that doesn't contain it.
 *
 * Exported for tests + the PR 2 disposition step.
 */
export function isLogGrounded(logExcerpt: string, ciLog: string): boolean {
  const needle = normalizeForLogMatch(logExcerpt)
  if (needle.length === 0) return false
  return normalizeForLogMatch(ciLog).includes(needle)
}

// ───────────────────────── two-stack disposition ───────────────────────────

/**
 * Where a CI finding lands after the two stacked gates run.
 *
 *   - "inline-clean"  — anchored AND log-corroborated → stated as fact inline.
 *   - "inline-hedged" — anchored but NOT corroborated → inline with one honest
 *                       hedge line (recall-safety: surfaced, not dropped).
 *   - "withhold"      — not anchorable → can't be an inline comment (GitHub
 *                       422s a non-diff anchor) → withheld.
 */
export type CiFindingDisposition = "inline-clean" | "inline-hedged" | "withhold"

export interface CiDispositionInput {
  /** Did `prepareReviewSubmissionFindings` keep this as an inline (RIGHT-anchored) finding? */
  anchored: boolean
  /** Did `isLogGrounded` corroborate the finding's `logExcerpt` against the log? */
  logCorroborated: boolean
  /**
   * When true, the anchored-but-uncorroborated bucket is HARD-WITHHELD instead
   * of hedged (Codex's stricter "enforce"). DEFAULT false: uncorroborated is
   * hedged, not dropped, by default (DeepSeek recall-safety). The shadow window
   * decides whether to flip this from the bucket's true/false rate.
   */
  hardWithholdUncorroborated: boolean
}

/**
 * The two-stack disposition rule (pure). Anchoring proves "this line is in the
 * PR," NOT "this line caused the failure" — so corroboration governs CONFIDENCE
 * (clean vs hedged), while anchoring governs PLACEMENT (inline vs withheld):
 *
 *   anchored + corroborated   → inline-clean
 *   anchored + uncorroborated → inline-hedged   (DEFAULT — recall-safe)
 *                             → withhold         (only when hard-withhold set)
 *   not anchored              → withhold         (off-diff: flaky / infra)
 *
 * Exported for tests + the PR 2 disposition step.
 */
export function disposeCiFinding(input: CiDispositionInput): CiFindingDisposition {
  if (!input.anchored) return "withhold"
  if (input.logCorroborated) return "inline-clean"
  return input.hardWithholdUncorroborated ? "withhold" : "inline-hedged"
}

// ───────────────────────────── dedup predicate ─────────────────────────────

/**
 * A CI finding reduced to the fields the dedup predicate needs. The caller
 * (PR 2) computes `contentFingerprint` via `computeContentFingerprint`
 * (review-withdrawal-store.ts:87) BEFORE rendering the comment (so the
 * `sigilix:fingerprint:` marker is emitted), and `coarseKey` via
 * `ciFindingCoarseKey` below.
 */
export interface CiDedupCandidate {
  /** 64-hex `computeContentFingerprint(category, path, body)`, or undefined. */
  contentFingerprint?: string
  /** Normalized `path|headline` coarse key (see `ciFindingCoarseKey`). */
  coarseKey: string
}

/**
 * The existing review's already-posted findings, as the dedup predicate sees
 * them. `fingerprints` comes from parsing `sigilix:fingerprint:` markers off
 * the PR's inline comments (fingerprint-exact); `coarseKeys` from the review
 * manifest's `(path, headline)` keys (coarse). Both are sets for O(1) lookup.
 */
export interface ExistingReviewFindings {
  /** 64-hex content fingerprints parsed off posted inline comments. */
  fingerprints: ReadonlySet<string>
  /** Coarse `path|headline` keys from the review manifest. */
  coarseKeys: ReadonlySet<string>
}

/**
 * Compute the coarse dedup key for a CI finding (pure). Mirrors the
 * normalization in `computeFindingKey` (`@/src/lib/ensemble/domain/findings`) —
 * lowercased path, lowercased + whitespace-collapsed + trailing-punctuation-
 * stripped headline — but WITHOUT the SHA (this is a SECONDARY hint compared
 * cheaply against the manifest's normalized keys; the manifest stores the SHA,
 * so PR 2 hashes this string before comparison, or compares the normalized form
 * directly). Kept pure + synchronous so the predicate stays in the domain.
 */
export function ciFindingCoarseKey(path: string, headline: string): string {
  const normalizedHeadline = headline
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
  return `${path.toLowerCase()}|${normalizedHeadline}`
}

/**
 * The dedup predicate (pure): should this CI finding be DROPPED because the
 * review already posted it?
 *
 *   - An exact `contentFingerprint` match against a posted inline comment is a
 *     HARD DROP — fingerprint-exact, line-tolerant (the fingerprint excludes
 *     `line`), so the SAME finding posted by the review is recognized even if
 *     its anchor drifted.
 *   - The coarse `path|headline` key match is a SECONDARY HINT only — it's a
 *     normalized title match, which can collide across genuinely different
 *     findings on the same file, so it does NOT hard-drop on its own here. The
 *     caller treats a coarse-only hit as a hint (PR 2 telemeters it); only the
 *     fingerprint match suppresses. Recall-safety: a genuinely-new CI finding
 *     must not be over-suppressed by a loose key.
 *
 * Returns true iff the finding's fingerprint is present in the existing set.
 * Exported for tests + the PR 2 dedup step.
 */
export function isDuplicateOfExistingReview(candidate: CiDedupCandidate, existing: ExistingReviewFindings): boolean {
  if (candidate.contentFingerprint && existing.fingerprints.has(candidate.contentFingerprint)) {
    return true
  }
  return false
}

/**
 * Coarse-key HINT check (pure, separate from the hard-drop predicate): does the
 * finding's coarse `path|headline` key match a manifest key? A true result is a
 * SECONDARY signal (PR 2 telemeters it as `dedup-coarse-hint`) — it does NOT by
 * itself drop the finding, per recall-safety. Exported for tests + telemetry.
 */
export function matchesExistingCoarseKey(candidate: CiDedupCandidate, existing: ExistingReviewFindings): boolean {
  return existing.coarseKeys.has(candidate.coarseKey)
}

// ─────────────────────────── presentation renderer ─────────────────────────

/** The fields a posted CI finding renders from (pure presentation input). */
export interface CiFindingPresentation {
  /** The customer-facing statement (the finding headline/body, one block). */
  statement: string
  /** Optional concrete fix; the `Likely fix:` block is omitted when absent. */
  fix?: string
  /** The failed workflow run id, for the provenance line. */
  runId: number
  /** The failed workflow run URL, for the provenance link. */
  runUrl: string
}

/** The honest one-liner prepended to a hedged (uncorroborated) CI finding. */
export const CI_HEDGE_LINE = "Couldn't corroborate this against the CI log — verify before acting."

/**
 * Render a CI finding's comment body (pure) — Kimi's template VERBATIM, NO
 * emojis, model + confidence dropped:
 *
 *   {statement}
 *
 *   Likely fix:
 *   {fix}
 *
 *   Surfaced from failed CI run [{runId}]({runUrl}).
 *
 * The `Likely fix:` block is omitted when there's no fix. For the hedged
 * (inline-hedged) disposition, one honest hedge line is prepended above
 * everything. Pure — exported for tests + the PR 2 posting step.
 */
export function renderCiFindingComment(presentation: CiFindingPresentation, hedged: boolean): string {
  const blocks: string[] = []
  if (hedged) blocks.push(CI_HEDGE_LINE)
  blocks.push(presentation.statement)
  const fix = presentation.fix?.trim()
  if (fix) blocks.push(`Likely fix:\n${fix}`)
  blocks.push(`Surfaced from failed CI run [${presentation.runId}](${presentation.runUrl}).`)
  return blocks.join("\n\n")
}

// ─────────────────────────── anchor remap (SIG-433) ─────────────────────────
//
// THE CATCH PROBLEM (SIG-431 measured it): the grounded CI synth diagnoses the
// failure ~100% correctly with 0% hallucination, but it anchors the finding to a
// line that only WITNESSES the bug — the enclosing function header / a blank
// context line / an interface-field declaration — instead of the exact changed
// SOURCE statement that PRODUCES it (e.g. the `const dedupeKey = …` line). When
// the witnessed line is off-diff the finding is correctly withheld (catch lost);
// when it's a poor-but-reviewable changed line it posts on the WRONG line (still
// not a catch). Prompt-tuning the model toward the cause line plateaued.
//
// The fix is a DETERMINISTIC, default-OFF remap: when the finding's text names a
// specific identifier and there is exactly ONE changed RIGHT-side NON-test source
// line that ASSIGNS/RETURNS/sets that identifier, move the anchor to that line.
// This NEVER fabricates — it only re-homes the anchor among real `+`-lines of the
// diff — and it is biased HARD toward leaving the finding untouched: any ambiguity
// (no strong candidate, two-or-more equally-strong candidates, only a generic
// identifier, the original anchor already a good substantive statement) is a no-op.
// Codex signed off on this contract (single unique strong candidate, else
// withhold; require log-grounding first; stop-list generic identifiers; same-file
// for non-test source anchors; never target a test / structural / context line).

/**
 * Parse `OPENCLAW_CI_TRIAGE_ANCHOR_REMAP`. Only the literal "on" (trimmed,
 * case-insensitive) enables it; everything else — unset, "off", "true", garbage
 * — is OFF. Default OFF is mandatory: CI-triage enforce is LIVE, so the remap
 * must not change posted anchors until the eval proves the catch lift.
 */
export function parseCiTriageAnchorRemap(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "on"
}

/**
 * Generic identifiers that, ALONE, can never qualify as the "strong" symbol that
 * licenses a remap — they collide across unrelated changed lines and would let
 * the remap match a coincidental token. A finding must name a NON-generic
 * identifier (e.g. `dedupeKey`, `attemptKind`) for the remap to fire; a
 * generic-only finding is a no-op. (Codex sign-off point 3.)
 */
const GENERIC_SYMBOL_STOPLIST: ReadonlySet<string> = new Set([
  "data",
  "value",
  "result",
  "key",
  "id",
  "type",
  "name",
  "error",
  "err",
  "payload",
  "body",
  "config",
  "options",
  "opts",
  "state",
  "props",
  "item",
  "items",
  "args",
  "arg",
  "obj",
  "res",
  "req",
  "ctx",
  "fn",
  "cb",
  "tmp",
  "out",
  "input",
  "output",
])

/**
 * Extract the candidate identifier symbols a finding NAMES (pure). Pulls
 * backtick-quoted spans and bare JS identifiers from `headline`+`body`, keeps
 * only well-formed identifiers (`[A-Za-z_$][\w$]*`), drops the generic stop-list,
 * and — to bias toward SPECIFIC names — keeps only identifiers that are NOT
 * all-lowercase-single-word unless they're clearly compound (contain `_`) OR are
 * camelCase/contain an uppercase letter. So `dedupeKey`, `attemptKind`,
 * `snake_case_thing` qualify; a bare `parse`/`length`/`expected` does not. Case
 * is preserved (identifier matching downstream is case-sensitive).
 */
export function extractFindingSymbols(headline: string, body: string): string[] {
  const text = `${headline}\n${body}`
  const found = new Set<string>()
  // Backtick-quoted spans first (the model's own emphasis), then bare identifiers.
  const backtickSpans = text.match(/`[^`]+`/g) ?? []
  const haystacks = [...backtickSpans.map((s) => s.slice(1, -1)), text]
  for (const hay of haystacks) {
    const idents = hay.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []
    for (const ident of idents) {
      if (ident.length < 3) continue
      if (GENERIC_SYMBOL_STOPLIST.has(ident.toLowerCase())) continue
      if (isSpecificIdentifier(ident)) found.add(ident)
    }
  }
  return [...found]
}

/**
 * A SPECIFIC code identifier (not a capitalized English sentence word). True for
 * camelCase (`dedupeKey`), snake_case (`max_retries`), `$`-bearing (`$ref`), a
 * digit-bearing token (`utf8Len`, `TS2339`), or an ALL-CAPS constant
 * (`MAX_LEN`/`TS2339`). FALSE for a leading-capital single English word like
 * `The`/`Property`/`Name` — those slip in at sentence start and are not
 * identifiers. Conservative: when in doubt it's NOT specific (bias to no-op).
 */
function isSpecificIdentifier(ident: string): boolean {
  if (ident.includes("_") || ident.includes("$")) return true
  if (/\d/.test(ident)) return true
  // camelCase: a lowercase letter somewhere BEFORE an uppercase letter.
  if (/[a-z].*[A-Z]/.test(ident)) return true
  // ALL-CAPS constant (>=2 letters, no lowercase) — e.g. an error-code-like token.
  if (ident.length >= 2 && ident === ident.toUpperCase() && /[A-Z]/.test(ident)) return true
  return false
}

/**
 * Is `path` a TEST file (pure)? A test line WITNESSES a bug; it is never the
 * cause, so the remap excludes test files as targets and won't pull a finding off
 * a test line. Matches the repo's standard test-path shape (the AST rules'
 * `SKIP_PATH`): `*.test.*` / `*.spec.*` / a `tests`/`__tests__` directory
 * segment. Exported so the call site and tests share ONE definition.
 */
export function isCiTestPath(path: string): boolean {
  return /(\.test\.|\.spec\.|(^|\/)(__tests__|tests?)\/)/.test(path)
}

/**
 * Word-boundary, CASE-SENSITIVE presence of `symbol` as a whole JS identifier.
 * `symbol` is `escapeRegExp`-sanitized before interpolation (defense in depth —
 * the extractor already restricts it to `[A-Za-z_$][\w$]*`), so no regex
 * metacharacter can reach the pattern.
 */
function lineMentionsSymbol(lineText: string, symbol: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`)
  return re.test(lineText)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * How a changed line relates to a named symbol (pure, deterministic):
 *
 *   - "strong"     — the line ASSIGNS or RETURNS the symbol as a VALUE:
 *                    `const sym = …` / `let sym = …` / `sym = …` / `this.sym = …`
 *                    (a real `=` assignment, NOT a comparison) or `return …sym…`.
 *                    This is the cause line a one-line fix would edit.
 *   - "ineligible" — the line is NEVER a remap target: a brace/blank/structural
 *                    line, an import, a TYPE/INTERFACE field declaration
 *                    (`readonly sym: T` / `sym: T`), a function / class / type /
 *                    interface HEADER, or a line that doesn't mention the symbol.
 *   - "weak"       — mentions the symbol but is neither a `=` assignment nor a
 *                    return of it (a read / use / comparison / a `sym: expr`
 *                    property whose colon form is AMBIGUOUS with a type field).
 *                    Not strong enough to license a remap on its own.
 *
 * DELIBERATELY conservative (Codex + code-review sign-off): a `sym:`-colon line is
 * NEVER strong (it's indistinguishable from a type/interface field on one line —
 * both can carry a trailing `,`), and an EQUALITY (`==`/`===`/`!=`/`<=`/`>=`) is
 * NOT an assignment. Both omissions bias toward no-op, never toward a wrong anchor.
 */
export type ChangedLineSymbolTier = "strong" | "weak" | "ineligible"

/**
 * Is `trimmed` a colon-form field line for `symbol` — `readonly sym: T` /
 * `sym?: T` / `sym: expr,` — with NO real `=`? Such a line is AMBIGUOUS between a
 * type/interface field and an object-literal property, so it is NEVER a strong
 * cause site AND is a poor original anchor. ONE definition shared by
 * `classifyChangedLineForSymbol` (→ ineligible) and `isLowQualityAnchorLine`
 * (→ low-quality) so the two can't diverge (code-review sign-off). `trimmed` must
 * already be `.trim()`-ed.
 */
function isColonFieldLineForSymbol(trimmed: string, symbol: string): boolean {
  const sym = escapeRegExp(symbol)
  return new RegExp(`^(readonly\\s+)?${sym}\\??\\s*:`).test(trimmed) && !/=/.test(trimmed)
}

export function classifyChangedLineForSymbol(lineText: string, symbol: string): ChangedLineSymbolTier {
  const trimmed = lineText.trim()
  if (!lineMentionsSymbol(lineText, symbol)) return "ineligible"
  // Structural / never-a-cause lines.
  if (isStructuralOrDeclarationLine(trimmed)) return "ineligible"
  const sym = escapeRegExp(symbol)
  // A colon-form line (`readonly sym: T` / `sym?: T` / `sym: expr,`) is AMBIGUOUS:
  // it's either a type/interface field (shape, ineligible) OR an object-literal
  // property value. We can't tell from one line, so a colon-form WITHOUT a real
  // `=` is never strong (it falls through to "weak" at most, and a leading
  // type-field shape is rejected as ineligible) — bias to withhold.
  if (isColonFieldLineForSymbol(trimmed, symbol)) return "ineligible"
  // Assignment of the symbol: `const sym =`, `let sym =`, `sym =`, `this.sym =`,
  // optionally with a type annotation (`sym: T = …`). The `=` must be a REAL
  // assignment operator: not part of `==`/`===` (lookahead `(?!=)`) and not the
  // tail of `!=`/`<=`/`>=`/a compound op (negative lookbehind on the char before).
  const isAssignment = new RegExp(
    `(^|[^A-Za-z0-9_$])(const\\s+|let\\s+|var\\s+|this\\.)?${sym}\\s*(:\\s*[^=<>!]+?)?\\s*(?<![=<>!+\\-*/%&|^])=(?!=)`,
  ).test(trimmed)
  // Returned/computed with the symbol in it.
  const isReturnOfSymbol = /^return\b/.test(trimmed) && lineMentionsSymbol(trimmed, symbol)
  if (isAssignment || isReturnOfSymbol) return "strong"
  return "weak"
}

/**
 * Lines that are NEVER a remap target regardless of symbol: a bare brace / blank,
 * an import/export-from, or a function / class / type / interface / enum HEADER.
 * (Codex: no structural-line target, no header target.)
 */
function isStructuralOrDeclarationLine(trimmed: string): boolean {
  if (trimmed.length === 0) return true
  if (/^[{}()[\];,]+$/.test(trimmed)) return true
  if (/^import\b/.test(trimmed) || /^export\s+(\{|\*|type\b|default\b)/.test(trimmed)) return true
  // A declaration HEADER (the container, not a statement inside it).
  if (/^(export\s+)?(async\s+)?function\b/.test(trimmed)) return true
  if (/^(export\s+)?(abstract\s+)?class\b/.test(trimmed)) return true
  if (/^(export\s+)?(interface|type|enum|namespace)\b/.test(trimmed)) return true
  return false
}

/**
 * Is the finding's ORIGINAL anchored line a poor anchor worth moving FROM (pure)?
 * We only remap an already-reviewable finding when its current line is clearly
 * low-quality — a structural/blank/import line, a header, a type-field
 * declaration, or a line the finding's symbol merely passes through. We do NOT
 * move a finding already sitting on a substantive statement (Codex sign-off
 * point 1). When the original line text is unknown (off-diff: no `+`-line text),
 * the finding wasn't reviewable anyway, so it's always eligible to remap.
 */
export function isLowQualityAnchorLine(originalLineText: string | undefined, symbols: readonly string[]): boolean {
  if (originalLineText === undefined) return true // off-diff / not a known added line
  const trimmed = originalLineText.trim()
  if (isStructuralOrDeclarationLine(trimmed)) return true
  // An ambiguous colon-form field line for a named symbol is a poor anchor — the
  // SAME predicate `classifyChangedLineForSymbol` uses to mark it ineligible, so a
  // line that is never a strong TARGET is also never wrongly KEPT as a good anchor.
  for (const sym of symbols) {
    if (isColonFieldLineForSymbol(trimmed, sym)) return true
  }
  // Otherwise it's a substantive statement — leave it where it is.
  return false
}

/** Inputs the pure remap needs about ONE finding + the diff geometry. */
export interface CiAnchorRemapInput {
  /** The finding's current anchor path. */
  path: string
  /** The finding's current anchor line (new-side). */
  line: number
  /** The finding's headline (symbol source). */
  headline: string
  /** The finding's body (symbol source). */
  body: string
  /**
   * Whether the finding is ALREADY RIGHT-anchored to its current line. When true
   * we only remap if the current line is low-quality; when false (off-diff) the
   * finding is currently withheld and any confident remap is a strict gain.
   */
  currentlyAnchored: boolean
  /**
   * Per-path map of changed `+`-line NUMBER → its added TEXT, from
   * `buildAddedLineTextByLine(diff)`. The ONLY lines a remap may target (so the
   * target is provably a real changed RIGHT-side line, never a context line).
   */
  addedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>
  /** True iff `path` is a TEST file (a test line witnesses, never causes). */
  isTestPath: (path: string) => boolean
}

/** A confident remap decision (the new anchor + why), or null = leave as-is. */
export interface CiAnchorRemap {
  path: string
  line: number
  /** The matched symbol + tier, for telemetry (never customer-facing). */
  reason: string
}

/**
 * The deterministic anchor remap (pure). Returns a new `{path, line}` ONLY when
 * exactly one changed RIGHT-side NON-test source line is the STRONG (assignment/
 * return/property) site of a SPECIFIC identifier the finding names; otherwise
 * null (leave the finding exactly as it is). Guardrails, all enforced here:
 *
 *   - target is always a real `+`-line from `addedLineTextByPath` (never a
 *     context line, never invented);
 *   - test files are excluded as targets, and a finding ALREADY anchored to a
 *     test line is not pulled off it (we just return null);
 *   - for a finding currently anchored to a NON-test source line, the search is
 *     restricted to that SAME file (cross-file remap only re-homes a finding
 *     whose original anchor is a test file or off-diff — Codex's extra guard);
 *   - an already-substantive original anchor is never moved;
 *   - generic-only / no-symbol findings are a no-op (stop-list);
 *   - TWO-OR-MORE equally-strong candidates → ambiguous → no-op.
 *
 * Log-grounding is enforced by the CALLER (it must pass `isLogGrounded` before
 * invoking this) — keeping that gate at the call site keeps catch a strict subset
 * of grounded findings and this function single-purpose.
 */
export function remapCiFindingAnchor(input: CiAnchorRemapInput): CiAnchorRemap | null {
  // A finding already anchored to a TEST line is left alone (don't pull a
  // genuinely-in-test defect off its real line).
  if (input.currentlyAnchored && input.isTestPath(input.path)) return null

  const symbols = extractFindingSymbols(input.headline, input.body)
  if (symbols.length === 0) return null

  // Only move an already-anchored finding off a LOW-QUALITY line.
  if (input.currentlyAnchored) {
    const originalText = input.addedLineTextByPath.get(input.path)?.get(input.line)
    if (!isLowQualityAnchorLine(originalText, symbols)) return null
  }

  // Candidate target files: NON-test files. For a non-test, currently-anchored
  // source finding, restrict to its OWN file; otherwise (test-anchored or
  // off-diff) any non-test changed file is fair game.
  const sameFileOnly = input.currentlyAnchored && !input.isTestPath(input.path)
  const candidateFiles: string[] = []
  for (const path of input.addedLineTextByPath.keys()) {
    if (input.isTestPath(path)) continue
    if (sameFileOnly && path !== input.path) continue
    candidateFiles.push(path)
  }
  if (candidateFiles.length === 0) return null

  // Collect every STRONG (path,line) site across the candidate files, keyed by the
  // target line so the same line being strong for >1 symbol is ONE target (not an
  // ambiguity). The first symbol that proves a line strong labels it (telemetry).
  interface StrongTarget {
    path: string
    line: number
    symbol: string
  }
  const distinctTargets = new Map<string, StrongTarget>()
  for (const path of candidateFiles) {
    const byLine = input.addedLineTextByPath.get(path)
    if (!byLine) continue
    for (const [line, text] of byLine) {
      for (const symbol of symbols) {
        if (classifyChangedLineForSymbol(text, symbol) !== "strong") continue
        const key = `${path}:${line}`
        if (!distinctTargets.has(key)) distinctTargets.set(key, { path, line, symbol })
        break // this line is already a target; other symbols don't add a new one
      }
    }
  }
  const targets = [...distinctTargets.values()]

  // EXACTLY ONE strong target → confident remap. Zero → nothing to anchor; two or
  // more → ambiguous: no-op (bias to withhold; never guess between two plausible
  // cause lines).
  if (targets.length !== 1) return null
  const target = targets[0]
  if (!target) return null

  // Don't "remap" a finding onto the line it's already on.
  if (target.path === input.path && target.line === input.line) return null

  return { path: target.path, line: target.line, reason: `strong:${target.symbol}` }
}
