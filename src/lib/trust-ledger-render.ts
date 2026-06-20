// SIG Trust Ledger v0 — proof-carrying reviews: render the believability of a
// review VISIBLE. Per-review Trust Summary + a collapsed "outside your changes"
// dropdown + a per-finding trust pill. Design by Kimi (approved); pure markdown
// emitters here, wired + data-threaded by the ensemble + flag-gated.
//
// HONESTY rule (Kimi): "VERIFIED" only for a runner receipt; "GROUNDED" = the
// cited evidence exists, NOT "the bug is proven"; "MODEL" (muted) refuses to
// invent authority. The colour discipline lives in the glyph specs (badge-assets).

// SIG-365 (PR 13): the finding/trust types come from their canonical shared/domain
// leaf — not the god-file shim — so the render layer (finding-format → review-body)
// can value-import this module's emitters without a `render → trust-ledger-render →
// triage-pr-review → render` cycle.
import type { PrReviewFinding, FindingTrust } from "@/src/shared/domain/pr-review-finding"
import type { ReviewBadgeAssetName } from "./badge-assets"
import { badgeImg } from "./badge-img"

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

/**
 * SIG-473: render a trust pill from a bare tier, using the SAME `badgeImg`
 * emitter the inline-comment renderer composes. This is the single source the
 * `overview-proof-update` job uses to compute both the GROUNDED `oldPill` and the
 * VERIFIED `newPill` for the in-place comment-body swap — rendering it any other
 * way would risk byte drift against what was originally posted.
 */
export function renderTrustPill(tier: FindingTrust["tier"]): string {
  return trustPill({ tier }, badgeImg)
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

// SIG-440 removed `renderOutsideDiffDropdown` + `renderPrLevelSection`: the
// "everything inline" render rewrite folded all non-inline findings into the
// single `renderNonInlineFindingsDropdown` in `review-body.ts`, so these standalone
// section emitters had no remaining caller.
