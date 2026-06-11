// SIG-365 (PR 13) — the review-BODY render module (render layer).
//
// The posture body builders carved VERBATIM from triage-pr-review.ts:
// `renderApproveBody` / `renderCommentBody` / `renderRequestChangesBody`, the
// shared `renderFindingsReviewBody` assembler, the `RenderBodyArgs` shape, the
// header lines (`renderDeltaBadge` / `renderCoverageLine` /
// `renderStackParenthetical`), the Fix Plan renderers, the "Outside your changes"
// section, the compact footer, and the 65k GitHub caps. No policy decisions — the
// review-EVENT decision (`chooseRenderedEventWithOverride` etc.) lives in
// domain/verdict and is consumed by the submission/fallback modules, not here.
//
// Dependency rule: imports point inward only — the per-finding render leaf
// (`./finding-format`), the verdict domain (severity-label helpers are pulled in
// via the leaf), the finding/verdict domain types (`@/shared/domain/…`), and the
// pure lib leaves (trust-ledger-render, pr-stack, dismiss-reasons). It NEVER
// imports the orchestrator god-file or any app/adapter/submission module. The
// bodies are byte-identical to their HEAD form in triage-pr-review.ts; only the
// import paths and the wrapper are new.

import type { PrReviewFinding, PrReviewVerdict, CoverageRoles } from "@/src/shared/domain/pr-review-finding"
import { type StackContext } from "@/src/lib/pr-stack"
import { ALL_DISMISS_REASONS } from "@/src/lib/dismiss-reasons"
import { renderTrustSummary, renderOutsideDiffDropdown, renderPrLevelSection } from "@/src/lib/trust-ledger-render"
import { findingScope, stripAstMarkers, formatFindingCategory, type BodyFindingLinkContext } from "./finding-format"
import { renderBodyOnlyFindings } from "./finding-comment"

/**
 * ARC-281: per-Kimi spec the body now carries an explicit "**Changes:** +N
 * new · M likely-fixed" badge line under the heading instead of
 * prepending a "since last review" string into the summary. Caller
 * computes a `FindingDelta` via the existing `computeFindingDelta`
 * helper and passes the four counts through; `renderDeltaBadge`
 * formats them. Pure — exported for tests.
 *
 * Returns `null` when no signal is worth surfacing (all counts
 * zero), so the renderer can skip the line entirely rather than
 * print an empty "**Changes:**".
 *
 * 2026-05-23 rebrand: the Δ glyph (Greek capital delta, visually a
 * triangle) was removed from both the badge label and the heading
 * suffix per founder direction. Replaced with the literal word
 * "Changes" + "since last review" — same semantics, no triangle.
 */
export interface DeltaBadgeCounts {
  newCount: number
  stillOpenCount: number
  likelyFixedCount: number
  carriedOverCount: number
}

export function renderDeltaBadge(counts: DeltaBadgeCounts): string | null {
  const { newCount, stillOpenCount, likelyFixedCount, carriedOverCount } = counts
  const any = newCount > 0 || stillOpenCount > 0 || likelyFixedCount > 0 || carriedOverCount > 0
  if (!any) return null
  const parts: string[] = []
  if (newCount > 0) parts.push(`+${newCount} new`)
  if (stillOpenCount > 0) parts.push(`${stillOpenCount} still-open`)
  if (likelyFixedCount > 0) parts.push(`${likelyFixedCount} likely-fixed`)
  if (carriedOverCount > 0) parts.push(`${carriedOverCount} carried-over`)
  return `**Changes:** ${parts.join(" · ")}`
}

/**
 * ARC-281: build the **Coverage:** line per Kimi's spec. Three
 * shapes:
 *
 *   - Full coverage (`succeeded == dispatched`):
 *       "**Coverage:** logic · security · performance · tests"
 *
 *   - 1–2 roles missing (`dispatched - succeeded` is 1 or 2):
 *       "**Coverage:** logic · security · tests — _performance specialist unavailable_"
 *       "**Coverage:** logic · tests — _security, performance specialists unavailable_"
 *
 *   - 3+ roles missing OR unknown failure mode: caller renders a
 *     <details> block instead (see `renderCoverageDetails`).
 *
 * Returns `null` when `dispatched.length === 0` — no specialists
 * means no coverage signal to render (the bail-with-skip-notice
 * path runs).
 */
export function renderCoverageLine(roles: CoverageRoles): string | null {
  if (roles.dispatched.length === 0) return null
  const succeededSet = new Set(roles.succeeded)
  const succeeded = roles.dispatched.filter((r) => succeededSet.has(r))
  const missing = roles.dispatched.filter((r) => !succeededSet.has(r))
  const succeededLine = succeeded.length > 0 ? succeeded.join(" · ") : "_none_"
  if (missing.length === 0) {
    return `**Coverage:** ${succeededLine}`
  }
  if (missing.length <= 2) {
    const noun = missing.length === 1 ? "specialist" : "specialists"
    return `**Coverage:** ${succeededLine} — _${missing.join(", ")} ${noun} unavailable_`
  }
  // 3+ missing — the caller renders a <details> block instead of
  // this inline form per Kimi's spec.
  return `**Coverage:** ${succeededLine} — _${missing.length} specialists unavailable_`
}

/**
 * ARC-281: compress a `StackContext` into a one-line parenthetical
 * per Kimi's spec. Returns `null` when the PR isn't stacked OR the
 * parent walk degraded (no parent number to print).
 *
 *   `_(Stacked on #87)_`
 *
 * Multi-line stack-context blocks (current `renderStackContextSummary`
 * output) are deprecated by this redesign; the parenthetical replaces
 * them.
 */
export function renderStackParenthetical(stack: StackContext | undefined): string | null {
  if (!stack || !stack.isStacked) return null
  if (!stack.parent) return null
  return `_(Stacked on #${stack.parent.number})_`
}

const SIGILIX_REVIEW_MARKER = "<!-- sigilix:pr-review -->"
const BODY_ONLY_FINDINGS_HEADING = "### Review Body Findings"
// SIG-281 PR B (Rec 6 / Kimi K2.6): this section now holds only
// sub-blocker (score < 4) body-only findings — score >= 4 blockers are
// surfaced in the Fix Plan table + a collapsed evidence block above.
// SIG-281 PR C: copy now covers ALL three reasons a finding lands here —
// un-anchorable scope, inline-comment-cap overflow (Rec 3), AND
// confidence-tier (Rec 5) / grounding (Rec 4) demotion — closing the
// CodeRabbit accuracy gap from PR B.
const BODY_ONLY_FINDINGS_EXPLANATION =
  "<sub>These findings are shown in the review body because they could not be anchored to specific diff lines (file-level or PR-level scope), because the inline comment cap was exceeded, or because their confidence tier or grounding made them better suited for body-only review.</sub>"
// SIG-281 PR B (Rec 6 / Kimi K2.6): caption shown under the Fix Plan
// table only when it contains body-only blockers (rows with no inline
// thread), so a reviewer isn't confused by table rows that have no
// corresponding inline comment.
const FIX_PLAN_BODY_ONLY_CAPTION =
  "_Severity ≥ 4 only. Rows without a line number are file-level or PR-level findings that cannot be posted as inline review comments._"
const BODY_ONLY_BLOCKER_DETAILS_SUMMARY =
  "<summary><b>Evidence &amp; suggested changes for body-only blockers</b> (score ≥ 4)</summary>"

/**
 * ARC-281: shared args for both `renderApproveBody` and
 * `renderRequestChangesBody`. Mirrors the historical
 * `formatReviewBody` signature but adds two fields surfaced by
 * Kimi K2.6's spec:
 *
 *   - `coverage` — which specialists were dispatched vs returned;
 *     drives the new `**Coverage:**` line (full or degraded).
 *   - `delta` — finding delta vs the prior review's manifest;
 *     drives the `**Changes:** +N new · M likely-fixed` badge under the
 *     heading. `null` means no prior review or no signal.
 *
 * The new renderers do NOT consume `verdict.confidenceReason` —
 * Kimi flagged it as redundant with the summary (it routinely
 * echoes the same content) so the redesign drops it from the
 * customer-facing body. Per-finding inline comments still use it
 * via `formatFindingComment` (ARC-282 will revisit).
 */
export interface RenderBodyArgs {
  verdict: PrReviewVerdict
  /** Line-scoped findings that passed review but could not be anchored
   *  to a diff line. Non-line-scoped findings may remain in
   *  `verdict.findings`; the renderer routes them to the same body-only
   *  section. Default `[]`. */
  unanchored?: PrReviewFinding[]
  /** Specialist dispatch/success roster. When absent, the coverage
   *  line is omitted (back-compat shim for call sites that haven't
   *  plumbed coverage through yet — ensemble will always supply). */
  coverage?: CoverageRoles
  /** SIG-245: changed files that spilled past the per-call diff budget
   *  (or were individually too large) and so were NOT reviewed. When
   *  non-empty, the body renders a visible "files not reviewed" notice so
   *  a silently-dropped file is never invisible to the reader. */
  notReviewedFiles?: string[]
  /** Per-Kimi delta badge counts (already computed). `null` skips. */
  delta?: DeltaBadgeCounts | null
  /** Stack context. When `stack.isStacked === true && stack.parent`,
   *  a `_(Stacked on #N)_` parenthetical appends to the summary
   *  paragraph. */
  stack?: StackContext
  /** Provenance footer context (head SHA + nowMs override). When
   *  supplied, `capForGitHub` appends the `_Reviewed against
   *  \`{sha7}\` at {iso8601}._` footer. */
  prov?: ProvenanceCtx
  /**
   * SIG-101: 1-indexed sequence number for the per-PR review counter.
   * When supplied, `renderRequestChangesBody` appends a
   * `_Sigilix · Review #N for this PR · last rendered <iso>._`
   * footer line. APPROVE bodies stay marker-only (per SIG-94) and
   * ignore this field. Omitted → counter line not rendered.
   */
  reviewCounter?: number
  /**
   * SIG-101: URL to the PR (used as the click target of the
   * `[🔄 Re-run review](URL)` retrigger link). GitHub doesn't
   * support pre-filled comment bodies on existing PRs, so the
   * link lands the user on the PR page; an accompanying sub-line
   * tells them to comment `/sigilix review` to re-run. Omitted →
   * retrigger CTA not rendered.
   */
  retriggerUrl?: string
  /**
   * SIG-216: when present, body-only finding anchors render as
   * clickable `[path:line](https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<line>)`
   * markdown links instead of the back-compat inline-code shape
   * (`` `path:line` ``). Threaded through `renderBodyOnlyFindings`
   * → `formatBodyFindingAnchor`. Callers that haven't plumbed
   * owner/repo through (e.g. older unit tests) keep the
   * inline-code rendering.
   */
  linkContext?: BodyFindingLinkContext
  /**
   * SIG Trust Ledger v0: when true (OPENCLAW_TRUST_LEDGER=on), render the trust
   * layer — the per-review Trust Summary under the lead line + per-finding
   * VERIFIED/GROUNDED/MODEL pills on body rows. Off → body byte-identical to today.
   */
  trustLedger?: boolean
  /**
   * SIG-112: when true, render the collapsible evidence/provenance block for
   * each finding that carries an EvidenceRecord. Off → byte-identical.
   */
  showEvidence?: boolean
  /** Trust Ledger: the upstream hard-drop/suppressed count for the Summary's
   *  "Quiet" line (the renderer derives demoted-to-body itself from the body
   *  findings' demoteReason). Omitted → treated as 0. */
  trustLedgerSuppressed?: number
}

export interface ProvenanceCtx {
  /** Head SHA of the PR being reviewed (40-char hex). */
  headSha: string
  /** Override Date.now() for deterministic tests. */
  nowMs?: number
}

/**
 * ARC-281 / ARC-293 / SIG-94: APPROVE-posture body renderer.
 *
 * Shape (SIG-94 marker-only on every APPROVE):
 *   ```
 *   <!-- sigilix:pr-review -->
 *   ```
 *
 * Pure — exported for tests.
 */
/**
 * Outside your changes (founder ask + Kimi redesign): the informational section
 * for findings about code NOT modified in this PR (`outOfPrScope`). Flat — no
 * dropdown (the collapsed dropdown was exactly what confused the reader into
 * thinking a within-diff finding was mis-placed). FYI tone, reuses the body-only
 * row format. Empty when there are none.
 */
function renderOutsideYourChanges(
  findings: readonly PrReviewFinding[],
  linkContext?: BodyFindingLinkContext,
  trustLedger?: boolean,
  showEvidence?: boolean,
): string[] {
  if (findings.length === 0) return []
  return [
    "",
    "### Outside your changes",
    "",
    "_These relate to code **not modified in this PR** — shown for awareness only; they don't block the merge._",
    ...renderBodyOnlyFindings([...findings], linkContext, trustLedger, showEvidence),
  ]
}

export function renderApproveBody(args: RenderBodyArgs): string {
  // SIG-94: marker-only on a CLEAN approve — GitHub's native "approved these
  // changes" line is the entire signal. EXCEPTION (founder ask): when the approve
  // carries out-of-PR-scope findings (code not in this PR), POST them as an
  // "Outside your changes" note and reconcile the approval up top — so the reader
  // sees WHY a flagged item isn't blocking, instead of a silent approve hiding it
  // or a "Critical" row contradicting the green check (Kimi believability fix).
  // `unanchored` and `verdict.findings` are disjoint buckets in
  // validateForSubmission, but dedupe by (path,line,headline) defensively so a
  // future caller that passes overlapping lists can't double-render (Codex nit).
  const seenOutOfScope = new Set<string>()
  const outOfScope = [...(args.unanchored ?? []), ...args.verdict.findings].filter((f) => {
    if (!f.outOfPrScope) return false
    const key = `${f.path}:${f.line}:${f.headline}`
    if (seenOutOfScope.has(key)) return false
    seenOutOfScope.add(key)
    return true
  })
  if (outOfScope.length === 0) return `${SIGILIX_REVIEW_MARKER}\n`
  const n = outOfScope.length
  const lines: string[] = [
    SIGILIX_REVIEW_MARKER,
    "",
    `**Approved** — no issues in your changes. ${n} ${n === 1 ? "note" : "notes"} about code outside this PR below.`,
    ...renderOutsideYourChanges(outOfScope, args.linkContext, args.trustLedger, args.showEvidence),
  ]
  return `${lines.join("\n")}\n`
}

/**
 * SIG-161 PR 4a — COMMENT-posture body renderer.
 *
 * Posted when the gate decides at least one finding is in the
 * borderline band `[FLOOR_SUPPRESS, chosenThreshold)` but none cross
 * the threshold. GitHub event is `COMMENT` — comments post but no
 * verdict change.
 *
 * Body shape mirrors `renderRequestChangesBody` for the finding layout,
 * but uses non-blocking copy and omits REQUEST_CHANGES-only affordances
 * so borderline findings don't read as blocker framing.
 *
 * In PR 4a this function is UNREACHABLE in production — the legacy
 * `chooseReviewEvent`'s narrowed return excludes "COMMENT". PR 4b
 * wires the shadow-mode log path; PR 4c wires `enforce`.
 *
 * Pure — exported for tests.
 */
export function renderCommentBody(args: RenderBodyArgs): string {
  // Strip pattern: denylist-by-name via rest spread so any new
  // optional field added to RenderBodyArgs later (a stack hint, a
  // delta variant, etc.) flows through without an opt-in step. The
  // ONLY two fields we omit are REQUEST_CHANGES-specific affordances.
  const { reviewCounter: _rc, retriggerUrl: _rt, ...stripped } = args
  void _rc
  void _rt
  return renderFindingsReviewBody(stripped, "comment")
}

/**
 * ARC-281: REQUEST_CHANGES-posture body renderer per Kimi K2.6's
 * spec.
 *
 * Shape (delta variant — Kimi sample 2b):
 *   ```
 *   <!-- sigilix:pr-review -->
 *
 *   ## Sigilix: 2 findings · since last review
 *
 *   **Changes:** +2 new · 3 likely-fixed
 *
 *   **Coverage:** logic · security · performance · tests
 *
 *   <verdict.summary paragraph> _(Stacked on #87)_
 *
 *   ### Fix Plan
 *   ...
 *
 *   ### Review Body Findings
 *   ...
 *
 *   To dismiss this review, push new commits or comment `@sigilix dismiss` in a review thread.
 *
 *   _Reviewed against `c6fdc29` at 2026-05-18T05:41:45.506Z._
 *   ```
 *
 * Pure — exported for tests.
 */
export function renderRequestChangesBody(args: RenderBodyArgs): string {
  return renderFindingsReviewBody(args, "request_changes")
}

type FindingsReviewPosture = "request_changes" | "comment"

function renderFindingsReviewBody(args: RenderBodyArgs, posture: FindingsReviewPosture): string {
  // SIG (Kimi K2.6 r1, 2026-05-27): compact redesign. Founder feedback:
  // the prior shape (H2 "Sigilix: N findings" + H3 "Fix Plan" + bold
  // severity subheading + bullets + 4 separate footer lines) had ~10
  // lines of chrome around 1 line of content for a single-finding
  // review. The "N findings" count in the header also didn't match
  // the Fix Plan count (Fix Plan shows score>=4 only) — readers had
  // no idea where lower-severity findings went.
  //
  // New shape (Kimi spec):
  //   <!-- sigilix:pr-review -->
  //
  //   **N high-severity findings** [+ M lower-severity inline] · coverage: ...
  //
  //   <summary paragraph>
  //
  //   | Severity | Location | Issue |
  //   |:---|:---|:---|
  //   | **High (4)** | `path:line` | category: headline |
  //
  //   <sub>Dismiss: `@sigilix dismiss` · Re-run: `/sigilix review` · Review #N · `sha`</sub>
  //
  // The H2/H3 headings are gone (GitHub already shows "Bot requested
  // changes" at the comment top), the Fix Plan severity subheading is
  // collapsed into a table row, and all 4 footer lines merge into one
  // `<sub>`. Body-only findings still get a separate section because
  // their failure mode (no inline thread possible) needs the
  // explanation copy.
  const inlineFindings = args.verdict.findings.filter((f) => findingScope(f) === "line")
  const allBodyFindings = [
    ...(args.unanchored ?? []),
    ...args.verdict.findings.filter((f) => findingScope(f) !== "line"),
  ]
  // Outside your changes (founder ask, Codex-hardened): findings about code NOT
  // in this PR's changed files (`outOfPrScope`) render in their OWN informational
  // section and are EXCLUDED from the blocker counts / Fix Plan / in-scope body
  // sections — so a P1 about other code never shows as a "Critical" blocker on a
  // PR that (correctly) approved. (An inline finding anchored to a changed line,
  // so it's never out-of-scope; only body findings can be.)
  const outOfPrScopeFindings = allBodyFindings.filter((f) => f.outOfPrScope)
  const bodyOnlyFindings = allBodyFindings.filter((f) => !f.outOfPrScope)
  const totalFindings = inlineFindings.length + bodyOnlyFindings.length
  const zeroFindingBlocker = posture === "request_changes" && totalFindings === 0
  // CR Major (PR #200): high-severity count must include body-only
  // findings too — an unanchored critical finding was rendering as
  // "**1 finding**" instead of "**1 high-severity finding**", which
  // weakens the prioritization signal in the compact lead line. The
  // lower-severity-inline count stays scoped to inline only — body-
  // only findings already get an explicit "+ N body" segment in the
  // lead, so counting them here too would double-count.
  const highOrCriticalCount =
    inlineFindings.filter((f) => f.score >= 4).length + bodyOnlyFindings.filter((f) => f.score >= 4).length
  const lowerSeverityInlineCount = inlineFindings.filter((f) => f.score < 4).length

  const lines: string[] = [SIGILIX_REVIEW_MARKER, ""]

  // Lead line — compact, bold, with coverage inlined. Drops the H2
  // heading entirely (the comment-header above already says "Sigilix
  // Bot requested changes" — a second H2 was redundant).
  const deltaBadge = args.delta ? renderDeltaBadge(args.delta) : null
  const coverageLine = args.coverage ? renderCoverageLine(args.coverage) : null
  // Strip the `**Coverage:**` prefix from the coverage line so we can
  // inline-append it after the lead. `renderCoverageLine` always emits
  // `**Coverage:** <rest>`, so the prefix strip is a stable contract.
  const coverageInline = coverageLine ? coverageLine.replace(/^\*\*Coverage:\*\* /, "coverage: ") : null
  let lead: string
  if (zeroFindingBlocker) {
    lead = "**Approval pending**"
  } else {
    const postureCopy = posture === "comment" ? "non-blocking " : ""
    const findingNoun = (n: number): string => (n === 1 ? "finding" : "findings")
    if (highOrCriticalCount === 0 && lowerSeverityInlineCount === 0 && bodyOnlyFindings.length > 0) {
      // All findings are body-only AND lower-severity (the high-
      // severity body-only case falls into the next branch via
      // highOrCriticalCount > 0 — CR Major fold).
      lead = `**${bodyOnlyFindings.length} ${postureCopy}${findingNoun(bodyOnlyFindings.length)}**`
    } else if (highOrCriticalCount === 0) {
      // Lower-severity inline only (no Fix Plan table).
      lead = `**${lowerSeverityInlineCount} ${postureCopy}${findingNoun(lowerSeverityInlineCount)}** posted inline`
    } else {
      // High-severity tier — includes body-only criticals per CR
      // Major. The "+ M lower-severity inline" clause tells the
      // reader where the rest live; body-only findings already get
      // their own "### Review Body Findings" section below so we
      // don't double-count them in the lead.
      lead = `**${highOrCriticalCount} ${postureCopy}high-severity ${findingNoun(highOrCriticalCount)}**`
      if (lowerSeverityInlineCount > 0) {
        lead += ` + ${lowerSeverityInlineCount} lower-severity inline`
      }
    }
  }
  const leadParts: string[] = [lead]
  if (deltaBadge) leadParts.push(deltaBadge.replace(/^\*\*Changes:\*\* /, "since last review: "))
  if (coverageInline) leadParts.push(coverageInline)
  lines.push(leadParts.join(" · "))

  // SIG-245: never silently drop. If changed files spilled past the per-call
  // diff budget (or were individually too large), they were NOT reviewed —
  // surface a visible notice right under the headline so a dropped file is
  // never invisible. Believability: the bot must not post as if it analyzed
  // code it never saw.
  if (args.notReviewedFiles && args.notReviewedFiles.length > 0) {
    const n = args.notReviewedFiles.length
    const files = args.notReviewedFiles.map((p) => `\`${p}\``).join(", ")
    lines.push("")
    lines.push(
      `> ⚠️ **${n} file${n === 1 ? "" : "s"} not reviewed** — the diff exceeded this review's size budget, so ${n === 1 ? "it was" : "they were"} **not analyzed**: ${files}. Split the PR or re-run to cover ${n === 1 ? "it" : "them"}.`,
    )
  }

  // SIG Trust Ledger v0: the per-review Trust Summary, immediately under the lead
  // line (the believability headline). Vanishes (null) on a clean approve / no
  // trust activity. `demotedToBody` = the gate demotions (NOT outside-diff, which
  // is a location constraint); `suppressed` = the upstream hard-drops (threaded in).
  if (args.trustLedger) {
    const demotedToBody = bodyOnlyFindings.filter((f) => {
      const r = f.trust?.demoteReason
      return (
        r === "inline-grounding" ||
        r === "absence-grounding" ||
        r === "security-grounding" ||
        r === "security-usage" ||
        r === "security-evidence" ||
        r === "verification-refuted" ||
        r === "do-race" ||
        r === "tests-coverage" ||
        r === "refutation-survival"
      )
    }).length
    const trustLine = renderTrustSummary({
      inlineFindings,
      bodyFindings: bodyOnlyFindings,
      counts: { suppressed: args.trustLedgerSuppressed ?? 0, demotedToBody },
    })
    if (trustLine) {
      lines.push("")
      lines.push(trustLine)
    }
  }

  // Summary paragraph (with optional stack-context parenthetical).
  const stackParen = renderStackParenthetical(args.stack)
  const summary = stackParen ? `${args.verdict.summary.trimEnd()} ${stackParen}` : args.verdict.summary
  lines.push("")
  if (zeroFindingBlocker) {
    lines.push(
      "Approval is pending because Sigilix has an unresolved policy-level blocker, " +
        "but no line-specific findings were rendered in this review.",
    )
    lines.push("")
  }
  lines.push(summary)

  // SIG-281 PR B (Rec 6 / Kimi K2.6): the Fix Plan table is the HIGH-SEVERITY
  // (P0/P1, score >= 4) prominence surface — a body-only P0/P1 that can't anchor
  // inline still belongs there so the blocker isn't buried in the detail section.
  // Lower-severity (score < 4) body findings render in the "Other findings"
  // section below. NOTE: the SECTION is a presentation tier (by severity), NOT
  // the blocking decision — the founder verdict rule (`chooseReviewEventFor-
  // RenderedFindings`) blocks on ANY substantive finding regardless of which
  // section renders it; only a truly trivial style/docs nit is non-blocking.
  const bodyOnlyBlockers = bodyOnlyFindings.filter((f) => f.score >= 4)
  const bodyOnlyNonBlockers = bodyOnlyFindings.filter((f) => f.score < 4)

  const fixPlanTable = renderFixPlanTable([...inlineFindings, ...bodyOnlyBlockers])
  if (fixPlanTable) {
    lines.push("")
    lines.push(fixPlanTable)
    if (bodyOnlyBlockers.length > 0) {
      // Clarify the table can contain non-inline-anchored rows.
      lines.push("")
      lines.push(FIX_PLAN_BODY_ONLY_CAPTION)
      // Full evidence for body-only blockers, collapsed by default.
      lines.push("")
      lines.push("<details>")
      lines.push(BODY_ONLY_BLOCKER_DETAILS_SUMMARY)
      lines.push("")
      lines.push(...renderBodyOnlyFindings(bodyOnlyBlockers, args.linkContext, args.trustLedger, args.showEvidence))
      lines.push("")
      lines.push("</details>")
    }
  }

  // Phase-3 (founder ask): everything pushed up to HERE is the MUST-KEEP head
  // (lead + summary + Fix Plan table with every blocker row + body-only blocker
  // details). The low-severity non-blocker section below is the DROPPABLE tail
  // that the severity-aware 65k cap sheds first, so a body-scoped security P0/P1
  // is never the thing that gets sliced out of an oversized review body.
  const headLineCount = lines.length

  // Body-only findings BELOW the blocker floor (score < 4) — unanchored
  // or non-line-scoped or inline-cap overflow. The explanation copy is
  // load-bearing (these can't anchor to a diff line, or overflowed the
  // inline cap). Blockers were rendered above (table + collapsed
  // evidence) and are intentionally excluded here to avoid duplication.
  if (bodyOnlyNonBlockers.length > 0) {
    if (args.trustLedger) {
      // SIG Trust Ledger v0 (PR3b): restructure the body-only (non-blocker)
      // findings by WHY they're in the body. A genuinely PR-scoped finding
      // (no-test / architectural, `findingScope === "pr"`) gets the **PR-level**
      // mini-section; findings in this PR that couldn't be anchored to a line
      // (demoteReason "outside-diff") collapse into a dropdown — note these are
      // IN the PR; genuinely-out-of-PR findings already split to "Outside your
      // changes" via outOfPrScope; EVERYTHING ELSE (gate-demoted-from-inline + file/line-scoped
      // body-routed findings) renders through the normal body-row helper, keeping
      // its canonical severity/path sort + the pills. The old generic disclaimer
      // is dropped — the structure now communicates the semantics. (CR #269:
      // PR-level must be strictly pr-scoped, not "everything without a gate reason".)
      const unanchorableFindings = bodyOnlyNonBlockers.filter((f) => f.trust?.demoteReason === "outside-diff")
      const prLevel = bodyOnlyNonBlockers.filter(
        (f) => f.trust?.demoteReason !== "outside-diff" && findingScope(f) === "pr",
      )
      const flat = bodyOnlyNonBlockers.filter(
        (f) => f.trust?.demoteReason !== "outside-diff" && findingScope(f) !== "pr",
      )
      // Per-finding row formatter for the PR-level + dropdown sections.
      const renderRow = (f: PrReviewFinding): string =>
        renderBodyOnlyFindings([f], args.linkContext, args.trustLedger, args.showEvidence).join("\n").trimStart()
      lines.push("")
      lines.push(BODY_ONLY_FINDINGS_HEADING)
      if (flat.length > 0) {
        lines.push(...renderBodyOnlyFindings(flat, args.linkContext, args.trustLedger, args.showEvidence))
      }
      const prSection = renderPrLevelSection(prLevel, renderRow)
      if (prSection) {
        lines.push("")
        lines.push(prSection)
      }
      const odDropdown = renderOutsideDiffDropdown(unanchorableFindings, renderRow)
      if (odDropdown) {
        lines.push("")
        lines.push(odDropdown)
      }
    } else {
      lines.push("")
      lines.push(BODY_ONLY_FINDINGS_HEADING)
      lines.push("")
      lines.push(BODY_ONLY_FINDINGS_EXPLANATION)
      lines.push(...renderBodyOnlyFindings(bodyOnlyNonBlockers, args.linkContext, args.trustLedger, args.showEvidence))
    }
  }

  // Outside your changes (founder ask): the informational section for findings
  // about code NOT in this PR's changes — below the in-scope findings, so it
  // reads as a postscript, not a directive. It's in the droppable tail (after
  // the headLineCount snapshot) so the 65k cap sheds it before any blocker.
  lines.push(...renderOutsideYourChanges(outOfPrScopeFindings, args.linkContext, args.trustLedger, args.showEvidence))

  // Single-line footer (replaces the four separate metadata lines).
  // Built separately from `lines` so the 65k cap can truncate the
  // body content without slicing through the footer's `<sub>` and
  // losing the SHA (Sigilix-bot HIGH + CR MINOR on PR #200 —
  // provenance invariant).
  const headShort = args.prov?.headSha ? args.prov.headSha.slice(0, 7) : null
  const footer = renderCompactReviewFooter({
    posture,
    reviewCounter: args.reviewCounter,
    headShort,
  })

  // Phase-3 (founder ask): severity-aware cap — shed the low-severity
  // non-blocker tail first so an oversized body never slices out a security
  // (or any) blocker. `headLineCount` was snapshotted right before the
  // non-blocker section was appended.
  const headStr = lines.slice(0, headLineCount).join("\n")
  const tailStr = lines.slice(headLineCount).join("\n")
  return capForGitHubPrioritized({
    head: headStr,
    droppable: tailStr,
    droppedCountIfOmitted: bodyOnlyNonBlockers.length,
    footer,
  })
}

/**
 * SIG (Kimi K2.6 r1): one-line footer that merges what used to be FOUR
 * separate metadata lines at the bottom of the review body — dismiss
 * hint, re-run hint, Review #N counter, "Reviewed against SHA at
 * TIMESTAMP" provenance. One `<sub>` block keeps the body lightweight
 * while preserving every piece of info the prior multi-line shape
 * provided.
 *
 * The timestamp is dropped because the GitHub comment header already
 * shows the "N minutes ago" timestamp at the top of the rendered
 * comment — two timestamps in the body for the same event was
 * redundant. The SHA stays because it's the only piece of info NOT
 * available from GitHub's chrome.
 */
// SIG-306: the canonical dismiss reasons (minus the `unlabeled` default), listed
// in the dismiss hint so reviewers SUPPLY a label — an unlabeled dismissal can't
// be classified hard-vs-soft on the FP-rate ruler. Derived from
// ALL_DISMISS_REASONS so the nudge can never drift from the parser's accepted
// set. `<reason>` stays inside backticks so GitHub renders it literally (not as
// an HTML tag). (Wording: Kimi.)
const DISMISS_REASON_HINT = ALL_DISMISS_REASONS.filter((r) => r !== "unlabeled").join("|")

function renderCompactReviewFooter(args: {
  posture: FindingsReviewPosture
  reviewCounter: number | undefined
  headShort: string | null
}): string {
  const parts: string[] = []
  if (args.posture === "request_changes") {
    parts.push(`Dismiss: \`@sigilix dismiss <reason>\` in thread (${DISMISS_REASON_HINT})`)
  }
  parts.push("Re-run: `/sigilix review`")
  if (typeof args.reviewCounter === "number" && args.reviewCounter > 0) {
    parts.push(`Review #${args.reviewCounter}`)
  }
  if (args.headShort) {
    parts.push(`\`${args.headShort}\``)
  }
  return `<sub>${parts.join(" · ")}</sub>`
}

// ARC-184: provenance footer + writer-side 65k cap.
//
// GitHub PR review bodies and issue comments are capped at 65,535
// chars. Sigilix's bodies almost never approach this (typical 2-8 KB),
// so the cap here is defense-in-depth — it preserves the footer
// exactly so the manifest's reviewed-at SHA always appears, and
// truncates the body content above with a marker that links the
// reader to the full review history.
const GH_BODY_CAP = 65000

function capForGitHub(body: string, footer: string): string {
  // SIG Kimi K2.6 r1 + Sigilix HIGH (PR #200): the compact footer
  // carries the SHA (the provenance invariant). It MUST survive the
  // 65k truncation — a naive tail-cut would slice through the `<sub>`
  // and break the invariant. So we cap by truncating BODY CONTENT
  // and re-appending the footer afterwards, the same shape the
  // pre-r1 renderProvenanceFooter / capForGitHub pair used.
  const joined = `${body}\n\n${footer}`
  if (joined.length <= GH_BODY_CAP) return joined
  const TRUNC = "\n\n_[summary truncated to fit GitHub's 65535 limit]_"
  const overhead = TRUNC.length + footer.length + 4 // "\n\n" between body & footer + a hair
  const room = GH_BODY_CAP - overhead
  const truncated = body.slice(0, Math.max(0, room))
  return `${truncated}${TRUNC}\n\n${footer}`
}

// Phase-3 (founder ask): SEVERITY-AWARE 65k cap. A blind tail-cut slices
// whatever renders LAST — the low-severity body-only findings, but also a
// body-scoped security P0/P1's evidence if the review is large enough — which
// is a PRESENTATION false-negative (a real blocker the partner never sees).
//
// `head` is the MUST-KEEP prefix: the lead, summary, the Fix Plan table (every
// score>=4 blocker row, security included), and the body-only BLOCKER details.
// `droppable` is the low-severity body-only non-blocker section. When the body
// overflows, we drop the DROPPABLE tail first — cleanly, with a count — so the
// head (every blocker) always survives intact. Only if the head ALONE still
// overflows (pathological — a single huge blocker) do we fall back to the blind
// content cut, which now can only ever truncate a blocker's tail, never silently
// vanish one whose row was already shown.
export function capForGitHubPrioritized(args: {
  head: string
  droppable: string
  droppedCountIfOmitted: number
  footer: string
}): string {
  const { head, droppable, footer } = args
  // `droppable` is `lines.slice(headLineCount)` joined — it already carries its
  // own leading blank line, so rejoin with a single "\n" to reproduce the exact
  // original `lines.join("\n")` shape.
  const full = droppable.length > 0 ? `${head}\n${droppable}` : head
  const joined = `${full}\n\n${footer}`
  if (joined.length <= GH_BODY_CAP) return joined

  // Drop the low-severity tail and tell the reader exactly what was omitted.
  const omitted =
    args.droppedCountIfOmitted > 0
      ? `\n\n_${args.droppedCountIfOmitted} lower-severity body ${args.droppedCountIfOmitted === 1 ? "finding" : "findings"} omitted to meet GitHub's 65,535-character limit — every blocker is shown above._`
      : "\n\n_[lower-severity detail omitted to meet GitHub's 65,535-character limit]_"
  const headFirst = `${head}${omitted}\n\n${footer}`
  if (headFirst.length <= GH_BODY_CAP) return headFirst

  // Pathological: the head (blockers) alone overflows. Fall back to the blind
  // cut on the head — but a blocker's ROW is in the Fix Plan table near the top,
  // so it survives; only trailing blocker EVIDENCE is trimmed. (DeepSeek: in the
  // theoretical extreme of HUNDREDS of blocker rows whose table alone exceeds 65k
  // — a single row is <200 chars, so 65k holds thousands — the table's last rows
  // could trim; that review is beyond any realistic size, and the outcome is
  // still strictly better than the old blind cut silently losing a blocker.)
  return capForGitHub(head, footer)
}

/**
 * ARC-180: render the "Fix Plan" section listing score >= 4 findings
 * (high or critical) as a prioritized repair queue. Returns the
 * Markdown string ready to drop into the review body, or null when
 * there are no findings at that severity (in which case the section
 * is omitted entirely — no empty headers).
 *
 * Format:
 *   ### Fix Plan
 *
 *   **Critical (score 5)**
 *   - \`src/foo.ts:42\` — \`logic\`: Headline
 *   - \`src/bar.ts:88\` — \`security\`: Headline
 *
 *   **High (score 4)**
 *   - \`src/baz.ts:15\` — \`error-handling\`: Headline
 *
 * Within each severity, ordered by path then line so the queue stays
 * stable across runs (a reviewer working top-to-bottom can re-run
 * /sigilix review and the queue won't shuffle on them).
 *
 * Pure — exported for tests.
 */
export function renderFixPlan(findings: PrReviewFinding[]): string | null {
  const critical: PrReviewFinding[] = []
  const high: PrReviewFinding[] = []
  for (const f of findings) {
    if (f.score >= 5) critical.push(f)
    else if (f.score >= 4) high.push(f)
  }
  if (critical.length === 0 && high.length === 0) return null

  const sortByLocation = (a: PrReviewFinding, b: PrReviewFinding): number => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.line - b.line
  }
  critical.sort(sortByLocation)
  high.sort(sortByLocation)

  const lines: string[] = ["### Fix Plan"]
  if (critical.length > 0) {
    lines.push("")
    lines.push(`**Critical (score 5)** — ${critical.length} ${critical.length === 1 ? "finding" : "findings"}`)
    for (const f of critical) lines.push(formatFixPlanRow(f))
  }
  if (high.length > 0) {
    lines.push("")
    lines.push(`**High (score 4)** — ${high.length} ${high.length === 1 ? "finding" : "findings"}`)
    for (const f of high) lines.push(formatFixPlanRow(f))
  }
  return lines.join("\n")
}

/**
 * SIG (Kimi K2.6 r1): Fix Plan in compact table form. Replaces the
 * H3 heading + per-severity subheading + bullet list shape with a
 * single markdown table. ~50% less vertical space per row.
 *
 * Critical (score 5) and High (score 4) findings only — same filter
 * as `renderFixPlan`. Lower-severity findings are referenced in the
 * lead-line "+ N lower-severity inline" copy so the reader knows
 * where they went without surfacing them in the table.
 *
 * Pure — exported for tests.
 */
export function renderFixPlanTable(findings: PrReviewFinding[]): string | null {
  const eligible = findings
    .filter((f) => f.score >= 4)
    .sort((a, b) => {
      // Critical first, then high. Within each severity, sort by
      // path/line so the table is stable across runs.
      if (a.score !== b.score) return b.score - a.score
      if (a.path !== b.path) return a.path < b.path ? -1 : 1
      return a.line - b.line
    })
  if (eligible.length === 0) return null

  const lines: string[] = ["| Severity | Location | Issue |", "|:---|:---|:---|"]
  for (const f of eligible) {
    // SIG-281 PR B (Rec 6 / Kimi Q3): the table can now contain body-only
    // blockers (file-level / PR-level scope) that have no specific diff
    // line. For those, show the path with NO `:line` suffix (the absence
    // of a line is the visual signal that the row isn't diff-anchored);
    // an empty path (pure PR-level) renders as "PR-level". Line- and
    // comment-scoped findings keep the `path:line` (or range) form.
    const scope = findingScope(f)
    const range =
      scope === "pr" || scope === "file"
        ? f.path.trim().length > 0
          ? f.path
          : "PR-level"
        : f.startLine != null && f.startLine !== f.line
          ? `${f.path}:${f.startLine}-${f.line}`
          : `${f.path}:${f.line}`
    const cleanHeadline = stripAstMarkers(f.headline)
    // Escape the pipe in headlines so a finding that says "use a | b"
    // doesn't collapse the table. Hand the reader a safer message and
    // a slightly longer truncation budget since each row is only one
    // line tall (vs prior bullet that could wrap visually).
    const safeHeadline = cleanHeadline.replace(/\|/g, "\\|")
    const headline = safeHeadline.length > 160 ? `${safeHeadline.slice(0, 157)}…` : safeHeadline
    const severityLabel = f.score >= 5 ? "**Critical (5)**" : "**High (4)**"
    lines.push(`| ${severityLabel} | \`${range}\` | \`${formatFindingCategory(f)}\`: ${headline} |`)
  }
  return lines.join("\n")
}

function formatFixPlanRow(f: PrReviewFinding): string {
  const range =
    f.startLine != null && f.startLine !== f.line ? `${f.path}:${f.startLine}-${f.line}` : `${f.path}:${f.line}`
  // Headline only — the inline comment carries the body. Truncate
  // defensively so an over-long headline can't break the bullet list.
  const cleanHeadline = stripAstMarkers(f.headline)
  const headline = cleanHeadline.length > 140 ? `${cleanHeadline.slice(0, 137)}…` : cleanHeadline
  return `- \`${range}\` — \`${formatFindingCategory(f)}\`: ${headline}`
}
