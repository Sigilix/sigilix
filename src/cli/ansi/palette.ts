// SIG-304 (review CLI) Phase 1b — the CLI color palette. The severity / trust /
// category hexes MIRROR the canonical badge-assets.ts style tables, but are
// RE-DECLARED here (not imported) on purpose: importing badge-assets.ts builds
// the baked-glyph SVG table at module load and throws if a glyph is missing —
// unsafe to drag into the CLI runtime. `palette.test.ts` asserts every hex below
// still equals the badge SVG, so this copy can never silently drift.

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
  bg: "#0d0d12",
  red: "#ef4444",
  redHi: "#f87171",
  redDeep: "#7f1d1d",
  text: "#e2e8f0",
  dim: "#8b95a7",
  white: "#f8fafc",
  diffMinus: "#f87171", // standard diff deletion (red)
  diffPlus: "#4ade80", // standard diff addition (green)
  star: "#39414f",
  star2: "#5b6479",
  starHi: "#c2cad8",
} as const
