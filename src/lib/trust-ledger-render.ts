// SIG Trust Ledger v0 — proof-carrying reviews: render the believability of a
// review VISIBLE. Per-review Trust Summary + a collapsed "outside your changes"
// dropdown + a per-finding trust pill. Design by Kimi (approved); pure markdown
// emitters here, wired + data-threaded by the ensemble + flag-gated.
//
// HONESTY rule (Kimi): "VERIFIED" only for a runner receipt; "GROUNDED" = the
// cited evidence exists, NOT "the bug is proven"; "MODEL" (muted) refuses to
// invent authority. The colour discipline lives in the glyph specs (badge-assets).

import type { PrReviewFinding, FindingTrust } from "./triage-pr-review"
import type { ReviewBadgeAssetName } from "./badge-assets"

/** Inject the ensemble's `badgeImg` so this module needs no value import from
 *  triage-pr-review (avoids a cycle) + stays unit-testable with a stub. */
type BadgeImg = (file: ReviewBadgeAssetName) => string

type Finding = Pick<PrReviewFinding, "trust">

/** Tier → trust glyph. VERIFIED is reserved for an actual runner receipt. */
function trustGlyphName(trust: FindingTrust | undefined): ReviewBadgeAssetName {
  switch (trust?.tier) {
    case "runner-confirmed":
      return "runner-verified" // VERIFIED — cyan; the existing runner pill
    case "deterministic-grounded":
    case "worker-token-confirmed":
    case "grounded-model":
      return "trust-grounded" // GROUNDED — slate; evidence exists, not "proven"
    default:
      return "trust-model" // MODEL — muted gray; body-only-ungrounded / no trust
  }
}

/** Tier → terse `<sub>` suffix (no glyph). */
function trustWord(trust: FindingTrust | undefined): "VERIFIED" | "GROUNDED" | "MODEL" {
  switch (trust?.tier) {
    case "runner-confirmed":
      return "VERIFIED"
    case "deterministic-grounded":
    case "worker-token-confirmed":
    case "grounded-model":
      return "GROUNDED"
    default:
      return "MODEL"
  }
}

/** Per-finding trust pill (inline glyph) — append after the category glyph. */
export function trustPill(trust: FindingTrust | undefined, badgeImg: BadgeImg): string {
  return badgeImg(trustGlyphName(trust))
}

/** Per-finding trust suffix for a body row's `<sub>` line. */
export function trustSubTag(trust: FindingTrust | undefined): string {
  return ` · ${trustWord(trust)}`
}

/**
 * Per-review Trust Summary — one bold middle-dot line under the marker, above
 * the severity table. Collapses zero segments; returns null (render nothing) on
 * a clean approve / all-zero so an approve stays pristine. `inlineFindings` =
 * the posted inline set, `bodyFindings` = the body-only set; `counts` = the
 * anti-noise totals the ensemble computes (suppressed / demoted-to-body).
 */
export function renderTrustSummary(args: {
  inlineFindings: ReadonlyArray<Finding>
  bodyFindings: ReadonlyArray<Finding>
  counts: { suppressed: number; demotedToBody: number }
}): string | null {
  const inline = args.inlineFindings.length
  const outsideDiff = args.bodyFindings.filter((f) => f.trust?.demoteReason === "outside-diff").length
  const prLevel = args.bodyFindings.length - outsideDiff
  const total = inline + args.bodyFindings.length
  const { suppressed, demotedToBody } = args.counts

  if (total === 0 && suppressed === 0 && demotedToBody === 0) return null

  const all = [...args.inlineFindings, ...args.bodyFindings]
  const tally = (pred: (f: Finding) => boolean): number => all.filter(pred).length
  const runnerVerified = tally((f) => f.trust?.tier === "runner-confirmed")
  const grounded = tally(
    (f) =>
      f.trust?.tier === "deterministic-grounded" ||
      f.trust?.tier === "worker-token-confirmed" ||
      f.trust?.tier === "grounded-model",
  )

  const seg: string[] = [`**${total} finding${total === 1 ? "" : "s"}**`]
  if (inline > 0) seg.push(`${inline} inline`)
  if (outsideDiff > 0) seg.push(`${outsideDiff} outside diff`)
  if (prLevel > 0) seg.push(`${prLevel} PR-level`)

  const proof: string[] = []
  if (runnerVerified > 0) proof.push(`${runnerVerified} runner-verified`)
  if (grounded > 0) proof.push(`${grounded} grounded`)
  if (proof.length > 0) seg.push(`**Proof**: ${proof.join(" · ")}`)

  const quiet: string[] = []
  if (suppressed > 0) quiet.push(`${suppressed} suppressed`)
  if (demotedToBody > 0) quiet.push(`${demotedToBody} demoted to body`)
  if (quiet.length > 0) seg.push(`**Quiet**: ${quiet.join(" · ")}`)

  return seg.join(" · ")
}

/**
 * The collapsed "outside your changes" `<details>` — findings about code OUTSIDE
 * this PR's diff, tucked away so they don't clutter a PR they're not about. Uses
 * the caller's `renderRow` to render each finding (so the existing body-row
 * format + the trust sub-tag stay one source of truth). Null if empty.
 */
export function renderOutsideDiffDropdown<T>(
  outsideDiffFindings: ReadonlyArray<T>,
  renderRow: (f: T) => string,
): string | null {
  if (outsideDiffFindings.length === 0) return null
  const n = outsideDiffFindings.length
  // Blank-line-separate rows: each row ends with a multi-line body (which can itself
  // contain blank lines + a nested <details>), so a single \n would make the next
  // bullet render as loose continuation of the previous list item (GFM), not a sibling.
  const rows = outsideDiffFindings.map(renderRow).join("\n\n")
  return `<details>\n<summary><b>${n} finding${n === 1 ? "" : "s"}</b> about code outside this PR's diff</summary>\n\n${rows}\n\n</details>`
}

/** The non-collapsed **PR-level** mini-section (no-test / architectural). Null if empty. */
export function renderPrLevelSection<T>(
  prLevelFindings: ReadonlyArray<T>,
  renderRow: (f: T) => string,
): string | null {
  if (prLevelFindings.length === 0) return null
  // Blank-line-separate rows (see renderOutsideDiffDropdown) so multi-line body rows
  // render as sibling list items, not loose continuations.
  return `**PR-level**\n\n${prLevelFindings.map(renderRow).join("\n\n")}`
}
