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
 *   - "enforce" — post the grounded inline findings and suppress ONLY the legacy
 *                 ungrounded sticky, while STILL running the SIG-333 inline
 *                 committable suggestions (SIG-434). (Wired in PR 2.)
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
