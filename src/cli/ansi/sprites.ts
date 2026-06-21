// SIG-304 (review CLI) Phase 1b — splash sprite data (founder-approved v7). The
// rocket + Earth are glm-5.2 half-block pixel grids; the SIGILIX wordmark is a
// 5×5 block-letter map. Rendered by splash.ts via the half-block technique
// (▀ = top px fg / bottom px bg). Legends map a grid char → hex; "." is
// transparent. Pure data — no imports.

/** 5×5 block glyphs for the SIGILIX wordmark. */
export const LETT: Record<string, string[]> = {
  S: ["█████", "█    ", "█████", "    █", "█████"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  G: ["█████", "█    ", "█  ██", "█   █", "█████"],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  X: ["█   █", " █ █ ", "  █  ", " █ █ ", "█   █"],
}

/** Filled cells of the wordmark "SIGILIX" (letters joined by a 3-space gap). */
export function logoCells(): { fills: Set<string>; w: number; h: number } {
  const rows = ["", "", "", "", ""]
  for (let r = 0; r < 5; r++) {
    rows[r] = "SIGILIX"
      .split("")
      .map((ch) => LETT[ch]![r]!)
      .join("   ")
  }
  const fills = new Set<string>()
  rows.forEach((row, r) => [...row].forEach((ch, c) => ch === "█" && fills.add(`${r},${c}`)))
  return { fills, w: rows[0]!.length, h: 5 }
}

/** Vertical red gradient for the wordmark rows (bright top → deep bottom). */
export const LOGO_GRAD = ["#fca5a5", "#f87171", "#ef4444", "#dc2626", "#b91c1c"]

// ── glm-5.2 rocket sprites (legend GLM_LEG) ──────────────────────────────
export const GLM_LEG: Record<string, string> = {
  ".": "#0d0d12",
  L: "#cbd5e1",
  M: "#94a3b8",
  D: "#475569",
  R: "#ef4444",
  C: "#22d3ee",
  A: "#fcd34d",
  F: "#fb923c",
  B: "#3b82f6",
  G: "#22c55e",
  H: "#e0f2fe",
  T: "#1e3a8a",
}

export const GLM_FLYING = [
  "....................LR",
  "..................LLRR",
  "AA..............LLMRRR",
  "FAA.............LLMRRR",
  "FFAA.........DMMMLCMRR",
  "FFFAA.......DMMMDLLMRR",
  "FFFAA......DMMMDLLLMRR",
  "FFAA.........DMMMLCMRR",
  "FAA.............LLMRRR",
  "AA..............LLMRRR",
  "..................LLRR",
  "....................LR",
]

export const GLM_45 = [
  ".......RR...",
  "......RMMR..",
  ".....RMMLL..",
  "....RMMLLL..",
  "...RMMCLLL..",
  "..DMMCMLLL..",
  "..DMMMMLLL..",
  ".DDMMMMLL...",
  "..DDMMMLL...",
  "...DDMMLL...",
  "....DDLL....",
  ".....DDL....",
]

export const GLM_VERTICAL = [
  ".....RR.....",
  "....RRRR....",
  "...RRRRRR...",
  "..RRRRRRRR..",
  ".RRMMMMMMRR.",
  ".RMMMMMMMMR.",
  ".LMMMMMMMML.",
  ".LMMMCMMMML.",
  ".LMMMMMMMML.",
  ".LMMMMMMMML.",
  ".LMMMMMMMML.",
  ".LMMMMMMMML.",
  ".DDMMMMMMDD.",
  ".DDMMMMMMDD.",
  "..DMMMMMMD..",
  "...DDDDDD...",
]

export const GLM_TOUCHDOWN = [
  ".....RR.....",
  "....RRRR....",
  "...RRRRRR...",
  "..RRRRRRRR..",
  ".RRMMMMMMRR.",
  ".RMMMMMMMMR.",
  ".LMMMMMMMML.",
  ".LMMMCMMMML.",
  ".LMMMMMMMML.",
  ".LMMMMMMMML.",
  ".LMMMMMMMML.",
  ".LMMMMMMMML.",
  ".D.MMMMMM.D.",
  "D...MMMM...D",
  "D...DDDD...D",
  "DD.D....D.DD",
]

export const GLM_FLAME_LONG = ["...FFFFFF...", "...FFAAFF...", "...FAHAAF...", "....AAAA....", ".....AA....."]
export const GLM_FLAME_SHORT = ["...FFFFFF...", "...FAAAAF...", "....AAAA...."]
export const GLM_DUST = ["H..AA...AA..H", ".M.AA...AA.M.", "..M.A...A.M.."]

// ── glm-5.2 realistic Earth (own legend — letters differ from the rocket's) ──
export const GLM_PLANET_LEG: Record<string, string> = {
  ".": "#0d0d12",
  A: "#67e8f9",
  H: "#e0f2fe",
  W: "#f8fafc",
  B: "#3b82f6",
  T: "#1e3a8a",
  D: "#0c1a4d",
  G: "#22c55e",
  N: "#166534",
  M: "#854d0e",
}

export const GLM_PLANET = [
  "........................",
  "........AAWWWWW.........",
  "......AAWWWWWWWWWW......",
  ".....AAWWWWWWWWHHHH.....",
  "...AHWWBGGGMGGBGGBBTT....",
  "...AHGBGGMGGGGBGBBTTD...",
  "..AHGGBBGGGMGGBGGBTTDD..",
  "..AHGBBGGBWWGGMGBBTDDD..",
  "..AHGNGBGGBGGMGBBTTDDD..",
  ".AHGGNGBWWGGGMGBBTTDDDD.",
  ".AHGNGBBBGGMGGBBTTDDDDD.",
  ".AHGNBBBBGGMGBBTTDDDDDD.",
  ".AHBGBBBWWBBGBBTTDDDDDD.",
  ".HBBWBBBBBBBBTTTDDDDDDDD.",
  ".HBBWWBBBBBBTTTDDDDDDDDD.",
  "..BBBBBBBBBTTTTDDDDDDD..",
  "..BBBBBBTTTTTDDDDDDDDD..",
  "..BBBBTTTTTTDDDDDDDDDD..",
  "...BBBTTTTTTDDDDDDDDD....",
  "...BBBWWWWWWWTDDDDDDD....",
  ".....BBWWWWWWWWWTDDD.....",
  "......BWWWWWWWWWTDD......",
  "........TWWWWWT..........",
  "........................",
]
