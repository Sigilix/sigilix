import { BADGE_GLYPH_PATHS, type BadgeGlyphPath } from "./badge-glyph-paths"
import {
  BADGE_GUTTER_PX,
  BADGE_RECT_RX,
  CATEGORY_BADGE_HEIGHT,
  PRIORITY_BADGE_HEIGHT,
  PRIORITY_BADGE_WIDTH,
  categoryBadgeWidth,
} from "./badge-geometry"

const BADGE_STYLES = {
  p0: {
    label: "P0",
    accent: "#B91C1C",
  },
  p1: {
    label: "P1",
    accent: "#F59E0B",
  },
  p2: {
    label: "P2",
    accent: "#84CC16",
  },
  p3: {
    label: "P3",
    accent: "#3B82F6",
  },
} as const

// SIG-184: runner-evidence trust pills (Kimi K2.6 spec, 2026-05-30). Rendered
// with the PRIORITY treatment — a SOLID bright fill + near-black glyph (a
// provenance signal, visually a sibling of the P0..P3 chips) — but at the
// variable CATEGORY width (the labels are words, not "P0"). `ariaLabel` carries
// the full descriptive text Kimi specified (the chip text alone reads as just
// "VERIFIED"). The `runner-absent` state renders NO badge, so it has no style.
const RUNNER_BADGE_STYLES = {
  "runner-verified": {
    label: "VERIFIED",
    accent: "#06B6D4", // cyan — "trust/provenance", distinct from every priority/category hue
    ariaLabel: "Runner verified: GitHub-signed receipt attests provenance",
  },
  "runner-pending": {
    label: "PENDING",
    // amber-600, intentionally NOT P1's #F59E0B — a pending-provenance signal
    // must not be confused with a P1 severity badge (Kimi, 2026-05-30).
    accent: "#D97706",
    ariaLabel: "Runner evidence pending: receipt expected",
  },
} as const

// SIG Trust Ledger v0: per-finding trust pills (Kimi spec, 2026-05-31). Same
// SVG-text-pill treatment as the runner pills. 2026-06-18 recolour: the
// original slate/gray honesty palette read as "boring/disabled" in prod, so
// the two model-side tiers now carry distinct hues while VERIFIED's saturated
// cyan stays the rare/premium top tier. Hierarchy by hue, not by greyness:
// emerald "GROUNDED" = evidence-exists, violet "MODEL" = model-only. The cyan
// "VERIFIED" runner pill is reserved for an actual runner receipt and is NOT
// duplicated here.
const TRUST_BADGE_STYLES = {
  "trust-grounded": {
    label: "GROUNDED",
    accent: "#34D399", // emerald — evidence exists (not a proof of exploitability)
    ariaLabel: "Grounded: cites real evidence (not a proof of exploitability)",
  },
  "trust-model": {
    label: "MODEL",
    accent: "#A78BFA", // violet — model-only, no stronger proof; claims no authority
    ariaLabel: "Model-only: no deterministic or runner evidence backs this",
  },
  // SIG-477 PR-5: the execution-reproduction pill (Kimi K2.7 spec, 2026-06-20). Sits
  // just below cyan VERIFIED (runner receipt) and above emerald GROUNDED in the
  // believability ladder — the sandbox RAN the cited code + the fix and observed them
  // diverge. Blue (not amber — that's P1 severity) reads as independently-replicated.
  "trust-reproduced": {
    label: "REPRODUCED",
    accent: "#2563EB", // blue — execution-reproduced; hue-distinct from cyan/emerald/violet/amber
    ariaLabel: "Execution reproduced: buggy code and proposed fix returned different values on a tested input",
  },
} as const

// SIG: per-category EXPLICIT bg + text pairs (Kimi K2.7 spec, 2026-06-19). The
// prior global-HSL treatment (S=0.12/L=0.18) collapsed all 9 hues to the same
// dark-grey chip — "they're all kinda the same, confusing" (founder). Each chip
// now carries a deep, recognizable shade of its own hue as the bg (`bg`) with
// the original pastel accent as the text (`accent`) — distinct at a glance,
// still subordinate to the solid-fill priority pills, AA-ish text contrast, and
// non-colliding with the priority red/amber/lime/blue + trust emerald/violet/cyan.
const CATEGORY_BADGE_STYLES = {
  logic: {
    label: "LOGIC",
    accent: "#7DD3FC",
    bg: "#0C4A6E",
  },
  security: {
    label: "SECURITY",
    accent: "#F0ABFC",
    bg: "#701A75",
  },
  performance: {
    label: "PERF",
    accent: "#FDBA74",
    bg: "#7C2D12",
  },
  "error-handling": {
    label: "ERROR",
    accent: "#FCA5A5",
    bg: "#7F1D1D",
  },
  testing: {
    label: "TESTING",
    accent: "#86EFAC",
    bg: "#14532D",
  },
  complexity: {
    label: "COMPLEXITY",
    accent: "#C4B5FD",
    bg: "#4C1D95",
  },
  style: {
    label: "STYLE",
    accent: "#93C5FD",
    bg: "#1E3A8A",
  },
  syntax: {
    label: "SYNTAX",
    accent: "#FDE68A",
    bg: "#713F12",
  },
  docs: {
    label: "DOCS",
    accent: "#CBD5E1",
    bg: "#334155",
  },
} as const

export type BadgeAssetName = keyof typeof BADGE_STYLES
export type CategoryBadgeAssetName = keyof typeof CATEGORY_BADGE_STYLES
export type RunnerBadgeAssetName = keyof typeof RUNNER_BADGE_STYLES
export type TrustBadgeAssetName = keyof typeof TRUST_BADGE_STYLES
export type ReviewBadgeAssetName = BadgeAssetName | CategoryBadgeAssetName | RunnerBadgeAssetName | TrustBadgeAssetName

// SIG-238 (2026-05-26 round-6 — THE ACTUAL FIX):
// host = `raw.githubusercontent.com/Sigilix/sigilix-glyphs`, a
// SEPARATE PUBLIC GitHub repo created tonight specifically to host
// the glyph SVGs. Tag-based versioning: each `BADGE_ASSET_VERSION`
// bump corresponds to a git tag in `Sigilix/sigilix-glyphs`, and the
// URL pulls the SVG from that immutable ref.
//
// Why this works when prior 5 iterations didn't:
//
//   1. **No Camo proxy.** GitHub's image renderer treats
//      `*.githubusercontent.com` hosts as same-origin and skips the
//      Camo proxy. Empirically verified via `gh api /markdown` —
//      raw.githubusercontent.com URLs render as bare `<img>` with
//      only responsive sizing, no `border-radius`, no
//      `background-color`. Camo-proxied URLs (workers.dev, sigilix.ai,
//      sigilix.github.io — all tested 2026-05-26) get
//      `data-canonical-src` wrapped + the `js-gh-image-fallback` JS
//      injects rounding at render time.
//   2. **No 404.** PR #192's first attempt pointed at
//      `Sigilix/sigilix/main` — the same repo, which is PRIVATE, so
//      raw.githubusercontent.com 404s for anonymous fetches.
//      `Sigilix/sigilix-glyphs` is intentionally **public** for
//      exactly this reason — the only thing in the repo is glyph
//      SVGs, no proprietary code.
//
// Prior failed attempts (all addressed by this approach):
//   1. SVG `rx=0` baked into the rect → js-gh-image-fallback overrode
//   2. `rx=0` + `shape-rendering="crispEdges"` → same
//   3. `BADGE_DISPLAY_SCALE = 1.6` → bloated, still rounded
//   4. Drop the `<a href>` anchor wrap → still rounded (the
//      js-gh-image-fallback class lives on the `<img>` directly)
//   5. raw.githubusercontent.com on the PRIVATE Sigilix/sigilix repo
//      → 404s, badges didn't load at all
//
// Build-time dependency: every `BADGE_ASSET_VERSION` bump requires
// mirroring the corresponding `assets/badges/<version>/*.svg` files
// to the public glyphs repo AND tagging that commit with the same
// version string. See `Sigilix/sigilix-glyphs` README for the
// upstream workflow.
export const PUBLIC_BADGE_BASE_URL = "https://raw.githubusercontent.com/Sigilix/sigilix-glyphs"

/**
 * SIG-238: kept as a back-compat anchor so the Worker keeps serving
 * older PR comments whose `<img src>` still points at the prior host.
 * The runtime `badgeAssetUrl()` ONLY emits raw.githubusercontent.com
 * URLs (the new pattern); this constant is purely for tests that
 * exercise the `handleBadgeAssetRoute(...)` self-serve path against
 * the original Workers route.
 */
export const LEGACY_WORKER_BADGE_BASE_URL = "https://sigilix.dan-martinezjulio.workers.dev/assets/badges"

// SIG-238 round-9 (2026-05-27): bumped v20260528-1 → v20260528-2 after
// the round-7 transparent-inset shipped sharp colored corners BUT
// exposed Primer's `background-color: var(--bgColor-muted)` rule
// painting through the inset margin — visible "bubble" frame around
// each badge. Round 8 reverted-to-rounded was rejected (founder vetoed
// rounded in r4). Round 9 = empirical pattern: viewBox=20×20, rect
// 19.512×19.512 with rx=1 (SVG owns the corner curve), and the bot
// emits `<a href="#"><img></a>` with NO explicit width/height. See
// `badge-geometry.ts:BADGE_PADDING_PX` docstring for the full
// r4-to-r9 history.
// SIG-184 (2026-05-30): v20260528-2 → v20260530-1 adds the runner-evidence
// trust pills (runner-verified / runner-pending). Every bump must mirror
// assets/badges/<version>/*.svg to the public Sigilix/sigilix-glyphs repo AND
// tag that commit with this exact string (see the PUBLIC_BADGE_BASE_URL note).
// SIG Trust Ledger v0 (2026-05-31): v20260530-1 → v20260531-1 adds the 2 Trust
// Ledger pills (trust-grounded / trust-model). 17 glyphs total; pushed + tagged
// at Sigilix/sigilix-glyphs@v20260531-1.
// Recolour (2026-06-18): v20260531-1 → v20260618-1 recolours trust-grounded
// (slate→emerald #34D399) and trust-model (gray→violet #A78BFA). Glyph PATHS are
// unchanged (labels identical) — only the rect fill differs, so no
// regenerate-badge-paths needed; re-run generate-static-badges + mirror/tag the
// new SVGs at Sigilix/sigilix-glyphs@v20260618-1 (same 17 glyphs).
// Recolour (2026-06-19): v20260618-1 → v20260619-1 recolours the 9 CATEGORY pills
// (Kimi K2.7 spec). The prior global-HSL treatment crushed all 9 hues to the same
// dark-grey chip ("all kinda the same, confusing" — founder); each now carries an
// explicit deep per-hue bg + the pastel accent as text, distinct at a glance.
// Glyph PATHS unchanged (labels identical) — only category rect fills differ, so
// no regenerate-badge-paths; re-run generate-static-badges + mirror/tag the new
// SVGs at Sigilix/sigilix-glyphs@v20260619-1 (same 17 glyphs).
// SIG-477 PR-5 (2026-06-20): v20260619-1 → v20260620-1 adds the `trust-reproduced`
// pill (REPRODUCED, blue #2563EB). New LABEL → re-run regenerate-badge-paths (bakes the
// "REPRODUCED" glyph) + generate-static-badges + mirror/tag the new SVGs at
// Sigilix/sigilix-glyphs@v20260620-1 (18 glyphs total).
export const BADGE_ASSET_VERSION = "v20260620-1"
const BADGE_PATH_RE = /^\/assets\/badges\/(?:v[0-9-]+\/)?([a-z0-9-]+)\.svg$/

// Priority badge geometry (PRIORITY_BADGE_WIDTH/HEIGHT, CATEGORY_BADGE_HEIGHT,
// categoryBadgeWidth) lives in `./badge-geometry` so the offline glyph-path
// generator (scripts/generate-badge-glyph-paths.ts) shares the same numbers.
// Glyph is path-baked (Geist Mono Medium @ 9.5px, frozen via opentype.js into
// src/lib/badge-glyph-paths.ts) so rendering is pixel-perfect regardless of
// the viewer's installed fonts. Category pill uses slightly more rounded
// corners (rx=2 vs priority's rx=1) to mark it as the secondary badge.

// Priority text color: near-black on bright accent fill (dark-on-bright for
// AA contrast across the P0..P3 palette). SIG-216 spec value (Kimi K2.6).
const PRIORITY_TEXT_COLOR = "#0A0A0A"

export function lookupGlyph(label: string): BadgeGlyphPath {
  const glyph = BADGE_GLYPH_PATHS[label]
  if (!glyph) {
    // Indicates a label was added to BADGE_STYLES / CATEGORY_BADGE_STYLES
    // without re-running `pnpm regenerate-badge-paths`. Fail loud at
    // construction time so the missing-glyph bug shows up in tests, not
    // in a deployed badge that silently renders an empty rect.
    throw new Error(`badge-assets: no baked glyph for label ${label} — run \`pnpm regenerate-badge-paths\``)
  }
  return glyph
}

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  // SIG-238 r9 pattern. viewBox stays at the intrinsic priority badge
  // dims; the colored rect is shrunk by BADGE_GUTTER_PX (sub-pixel
  // transparent gutter) and given rx=BADGE_RECT_RX so the SVG OWNS a
  // small intentional corner curve. No <g translate> wrap (the baked
  // Geist Mono glyph paths target the same 20×20 coord space).
  // `fill="none"` on the outer <svg> declares no implicit white
  // background. History + why this works in
  // `badge-geometry.ts:BADGE_PADDING_PX`.
  const glyph = lookupGlyph(style.label)
  const innerW = PRIORITY_BADGE_WIDTH - BADGE_GUTTER_PX
  const innerH = PRIORITY_BADGE_HEIGHT - BADGE_GUTTER_PX
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PRIORITY_BADGE_WIDTH} ${PRIORITY_BADGE_HEIGHT}" width="${PRIORITY_BADGE_WIDTH}" height="${PRIORITY_BADGE_HEIGHT}" fill="none" role="img" aria-label="${style.label}">
  <rect width="${innerW}" height="${innerH}" rx="${BADGE_RECT_RX}" fill="${style.accent}"/>
  <path d="${glyph.d}" fill="${PRIORITY_TEXT_COLOR}"/>
</svg>`
}

function renderCategoryBadgeSvg(style: (typeof CATEGORY_BADGE_STYLES)[CategoryBadgeAssetName]): string {
  // Same r9 pattern as `renderBadgeSvg` above, generalized for
  // variable-width category pills.
  const width = categoryBadgeWidth(style.label)
  // SIG (Kimi 2026-06-19): explicit per-category bg + the pastel accent as text,
  // replacing the global-HSL treatment that washed every hue to the same grey.
  const bg = style.bg
  const fg = style.accent
  const glyph = lookupGlyph(style.label)
  const innerW = width - BADGE_GUTTER_PX
  const innerH = CATEGORY_BADGE_HEIGHT - BADGE_GUTTER_PX
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${CATEGORY_BADGE_HEIGHT}" width="${width}" height="${CATEGORY_BADGE_HEIGHT}" fill="none" role="img" aria-label="${style.label}">
  <rect width="${innerW}" height="${innerH}" rx="${BADGE_RECT_RX}" fill="${bg}"/>
  <path d="${glyph.d}" fill="${fg}"/>
</svg>`
}

// SIG-184: the PRIORITY treatment (solid bright `accent` fill + near-black
// PRIORITY_TEXT_COLOR glyph) at the CATEGORY variable width — Kimi's runner
// pill. The SVG carries the descriptive `ariaLabel` (not the bare label) so a
// directly-consumed SVG is self-describing; the inline `<img alt>` mirrors it.
// The runner pill style + the SIG Trust Ledger pills share this shape (a
// word-label text pill with an accent) and the same r9 renderer.
function renderRunnerBadgeSvg(style: {
  readonly label: string
  readonly accent: string
  readonly ariaLabel: string
}): string {
  const width = categoryBadgeWidth(style.label)
  const glyph = lookupGlyph(style.label)
  const innerW = width - BADGE_GUTTER_PX
  const innerH = CATEGORY_BADGE_HEIGHT - BADGE_GUTTER_PX
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${CATEGORY_BADGE_HEIGHT}" width="${width}" height="${CATEGORY_BADGE_HEIGHT}" fill="none" role="img" aria-label="${style.ariaLabel}">
  <rect width="${innerW}" height="${innerH}" rx="${BADGE_RECT_RX}" fill="${style.accent}"/>
  <path d="${glyph.d}" fill="${PRIORITY_TEXT_COLOR}"/>
</svg>`
}

const BADGE_SVGS: Record<ReviewBadgeAssetName, string> = {
  p0: renderBadgeSvg(BADGE_STYLES.p0),
  p1: renderBadgeSvg(BADGE_STYLES.p1),
  p2: renderBadgeSvg(BADGE_STYLES.p2),
  p3: renderBadgeSvg(BADGE_STYLES.p3),
  logic: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.logic),
  security: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.security),
  performance: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.performance),
  "error-handling": renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES["error-handling"]),
  testing: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.testing),
  complexity: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.complexity),
  style: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.style),
  syntax: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.syntax),
  docs: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.docs),
  "runner-verified": renderRunnerBadgeSvg(RUNNER_BADGE_STYLES["runner-verified"]),
  "runner-pending": renderRunnerBadgeSvg(RUNNER_BADGE_STYLES["runner-pending"]),
  "trust-grounded": renderRunnerBadgeSvg(TRUST_BADGE_STYLES["trust-grounded"]),
  "trust-model": renderRunnerBadgeSvg(TRUST_BADGE_STYLES["trust-model"]),
  "trust-reproduced": renderRunnerBadgeSvg(TRUST_BADGE_STYLES["trust-reproduced"]),
}

export function badgeAssetUrl(name: ReviewBadgeAssetName): string {
  return `${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/${name}.svg`
}

// SIG-184: maps the consumer-facing runner-evidence discriminant
// (`verified` | `evidence-pending`) to its badge name. The third state,
// `runner-absent`, deliberately has NO badge — the caller renders nothing.
const RUNNER_EVIDENCE_BADGE_NAME: Record<"verified" | "evidence-pending", RunnerBadgeAssetName> = {
  verified: "runner-verified",
  "evidence-pending": "runner-pending",
}

/**
 * SIG-184: the inline `<img>` for a runner-evidence trust pill, used in the
 * check-run summary. Bare `<img>` (no `<a>` wrap) per Kimi's spec for this
 * surface: the raw.githubusercontent host dodges Camo and the SVG owns its
 * rx=1 corners. `alt` carries the full descriptive text (screen-reader + the
 * GitHub markdown→HTML pipeline preserves it). `runner-absent` has no badge,
 * so it is intentionally NOT a valid input — the caller omits the badge.
 */
export function runnerEvidenceBadgeImg(state: "verified" | "evidence-pending"): string {
  const name = RUNNER_EVIDENCE_BADGE_NAME[state]
  return `<img src="${badgeAssetUrl(name)}" alt="${RUNNER_BADGE_STYLES[name].ariaLabel}">`
}

export function badgeAssetSize(name: ReviewBadgeAssetName): { width: number; height: number } {
  // SIG-238 r9: returns the SVG's INTRINSIC viewBox dimensions (no
  // padding, no inset, native priority/category geometry). Callers
  // that DO emit `<img width height>` (none on the prod hot path
  // post-r9 — `badgeImg` in triage-pr-review.ts omits both attrs per
  // the Greptile pattern) will get back the exact same numbers the
  // SVG declares so there's no browser-side rescaling.
  if (name in BADGE_STYLES) {
    return { width: PRIORITY_BADGE_WIDTH, height: PRIORITY_BADGE_HEIGHT }
  }
  // Runner + trust pills share the category geometry (variable width, 20-tall)
  // but live in their own style tables, so resolve their label there.
  const label =
    name in RUNNER_BADGE_STYLES
      ? RUNNER_BADGE_STYLES[name as RunnerBadgeAssetName].label
      : name in TRUST_BADGE_STYLES
        ? TRUST_BADGE_STYLES[name as TrustBadgeAssetName].label
        : CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label
  return {
    width: categoryBadgeWidth(label),
    height: CATEGORY_BADGE_HEIGHT,
  }
}

export function badgeAssetLabel(name: ReviewBadgeAssetName): string {
  if (name in BADGE_STYLES) return BADGE_STYLES[name as BadgeAssetName].label
  if (name in RUNNER_BADGE_STYLES) return RUNNER_BADGE_STYLES[name as RunnerBadgeAssetName].label
  if (name in TRUST_BADGE_STYLES) return TRUST_BADGE_STYLES[name as TrustBadgeAssetName].label
  return CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label
}

export function getBadgeSvg(name: ReviewBadgeAssetName): string {
  return BADGE_SVGS[name]
}

/**
 * SIG-238 (CR catch): exhaustive list of badge names sourced from
 * `BADGE_SVGS` itself, so `scripts/generate-static-badges.ts` cannot
 * silently drift if a new badge is added to `BADGE_SVGS` without a
 * matching entry in the generator script. Keys are `ReviewBadgeAssetName`
 * by construction — the `Object.keys` typing is widened to `string[]`
 * at runtime, so we narrow it back via `as readonly ReviewBadgeAssetName[]`.
 */
export const ALL_BADGE_NAMES: readonly ReviewBadgeAssetName[] = Object.keys(
  BADGE_SVGS,
) as readonly ReviewBadgeAssetName[]

export function handleBadgeAssetRoute(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const { pathname } = new URL(request.url)
  const match = BADGE_PATH_RE.exec(pathname)
  if (!match) return null

  const name = match[1] as ReviewBadgeAssetName
  if (!Object.prototype.hasOwnProperty.call(BADGE_SVGS, name)) return null
  const svg = BADGE_SVGS[name]
  if (typeof svg !== "string" || !svg.trimStart().startsWith("<svg")) return null
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "image/svg+xml; charset=utf-8",
    "x-content-type-options": "nosniff",
  }
  return new Response(request.method === "HEAD" ? null : svg, { headers })
}
