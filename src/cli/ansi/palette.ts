// SIG-304 (review CLI) Phase 1b — the CLI color palette. The severity / trust /
// category hexes MIRROR the canonical badge-assets.ts style tables, but are
// RE-DECLARED here (not imported) on purpose: importing badge-assets.ts builds
// the baked-glyph SVG table at module load and throws if a glyph is missing —
// unsafe to drag into the CLI runtime. `palette.test.ts` drift-guards the
// SEVERITY / TRUST / CATEGORY hexes against the badge SVGs (and locks
// CATEGORY_FALLBACK to CATEGORY_HEX.docs). THEME is CLI-original (the approved
// red splash/panel theme) with no badge-assets counterpart, so it is not guarded.

import type { FindingView } from "@/src/cli/render/finding-view"

type Severity = FindingView["severity"]
type Trust = FindingView["trust"]

/** P0..P3 accent hexes — mirror BADGE_STYLES in badge-assets.ts. */
export const SEVERITY_HEX: Record<Severity, string> = {
  P0: "#B91C1C",
  P1: "#F59E0B",
  P2: "#84CC16",
  P3: "#3B82F6",
}

/** Trust-tier accent hexes — mirror RUNNER_BADGE_STYLES (VERIFIED) + TRUST_BADGE_STYLES. */
export const TRUST_HEX: Record<Trust, string> = {
  VERIFIED: "#06B6D4",
  REPRODUCED: "#2563EB",
  GROUNDED: "#34D399",
  MODEL: "#A78BFA",
}

/** Per-category {bg,fg} hex pairs — mirror CATEGORY_BADGE_STYLES (bg = rect, fg = text/accent). */
export const CATEGORY_HEX: Record<string, { bg: string; fg: string }> = {
  logic: { bg: "#0C4A6E", fg: "#7DD3FC" },
  security: { bg: "#701A75", fg: "#F0ABFC" },
  performance: { bg: "#7C2D12", fg: "#FDBA74" },
  "error-handling": { bg: "#7F1D1D", fg: "#FCA5A5" },
  testing: { bg: "#14532D", fg: "#86EFAC" },
  complexity: { bg: "#4C1D95", fg: "#C4B5FD" },
  style: { bg: "#1E3A8A", fg: "#93C5FD" },
  syntax: { bg: "#713F12", fg: "#FDE68A" },
  docs: { bg: "#334155", fg: "#CBD5E1" },
}

/** Fallback for an unknown/empty category string (keeps the pill renderable). */
export const CATEGORY_FALLBACK = { bg: "#334155", fg: "#CBD5E1" } as const

/**
 * Approved RED-theme palette (founder sign-off 2026-06-21) — shared by the rich
 * review panel and the animated splash so they stay one source of truth.
 */
export const THEME = {
  bg: "#0D0D12",
  red: "#EF4444",
  redHi: "#F87171",
  redDeep: "#7F1D1D",
  text: "#E2E8F0",
  dim: "#8B95A7",
  white: "#F8FAFC",
  diffMinus: "#F87171", // standard diff deletion (red)
  diffPlus: "#4ADE80", // standard diff addition (green)
  star: "#39414F",
  star2: "#5B6479",
  starHi: "#C2CAD8",
} as const
