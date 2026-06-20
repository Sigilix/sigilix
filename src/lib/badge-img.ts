// SIG-473 — the pure `<img>` badge emitter, extracted from the render layer
// (`finding-format.ts`) into this lib leaf so non-render leaves (the
// `overview-proof-update` job, `trust-ledger-render`) can render a trust pill
// WITHOUT importing the render layer (which the dependency rule forbids).
//
// Single source of truth for the badge `<img>` markup — both the inline-comment
// renderer (via `finding-format` re-export) and the receipt-driven pill PATCH
// path (`renderTrustPill`) compose this, so the GROUNDED→VERIFIED swap can match
// the exact bytes the original render emitted (no drift).
//
// Body byte-identical to its prior home in `finding-format.ts`.

import { badgeAssetLabel, badgeAssetUrl, type ReviewBadgeAssetName } from "@/src/lib/badge-assets"

export function badgeImg(file: ReviewBadgeAssetName): string {
  const label = badgeAssetLabel(file)
  // SIG-238 r9 pattern. Empirical: this combo defeats Primer's bubble
  // rule on github.com PR comments. Specifically:
  //   - `<a href="#">` WRAP (we used to drop this per r4; that
  //     diagnosis was wrong — the anchor is REQUIRED, not harmful).
  //   - `<img>` with `align="top"` and NO explicit width/height. The
  //     missing dimensions appear to suppress whichever Primer CSS
  //     rule paints `bgColor-muted` under the image (the "bubble"
  //     visible in r7).
  // Why this works: not fully understood — empirical. See
  // `badge-geometry.ts:BADGE_PADDING_PX` for r4-through-r9 history.
  return `<a href="#"><img alt="${label}" src="${badgeAssetUrl(file)}" align="top"></a>`
}
