export interface ReviewStatusAsciiFooter {
  id: string
  lines: readonly string[]
}

export const REVIEW_STATUS_ASCII_FOOTERS: readonly ReviewStatusAsciiFooter[] = [
  {
    id: "constellation-map",
    lines: ["      *        .        *", "  .      SIGILIX REVIEW      .", "      follow the changed stars"],
  },
  {
    id: "quiet-orbit",
    lines: ["        .- orbit -.        ", "   *  one signal, held steady  *", "        `- until proof -."],
  },
  {
    id: "deep-space-lamp",
    lines: ["    *        .", "       [ signal lamp ]", "  a small light can guide a long review"],
  },
  {
    id: "starfield-proof",
    lines: ["  .  proof before path  .", "*      path before verdict      *", "  .  verdict before ship  ."],
  },
  { id: "north-star", lines: ["        *", "       /|\\", "  SIGILIX keeps the north star in view"] },
  {
    id: "nebula-note",
    lines: [" .     *     .     *", "   every careful note becomes a clearer sky", " *     .     *     ."],
  },
  { id: "orbiting-diff", lines: ["     *  diff", "     /        \\", "  evidence -- review -- outcome"] },
  {
    id: "waiting-sky",
    lines: [
      "  *        waiting with the work        *",
      "       not idle, just listening",
      "  .        .        .        .",
    ],
  },
  { id: "star-thread", lines: ["*---*---*---*---*", "each thread of proof holds the sky", "*---*---*---*---*"] },
  {
    id: "small-satellite",
    lines: ["       .", "  [SIGILIX]---- changed lines", "       `---- looking for consequence"],
  },
  {
    id: "deep-recall",
    lines: ["  recall is the gravity", "  precision is the orbit", "  proof keeps both from drifting"],
  },
  {
    id: "cosmic-margin",
    lines: [
      "+------------------------------+",
      "| stars in the margin, facts in line |",
      "+------------------------------+",
    ],
  },
  {
    id: "night-watch",
    lines: ["       * night watch *", "  we keep the signal warm", "  until the review has a place to land"],
  },
  {
    id: "commit-comet",
    lines: ["    commit ---->", "        tail: tests, types, evidence", "  * destination: useful review"],
  },
  { id: "star-ledger", lines: ["  [ ] changed lines", "  [ ] retrieved context", "  [*] a brighter answer forming"] },
  { id: "orbit-check", lines: ["     .-------------.", "  *  | review orbit |  *", "     `-------------'"] },
  { id: "soft-signal", lines: ["  . signal sent", "  . context gathered", "  * care returned"] },
  { id: "moonless-sky", lines: ["  no loud light needed", "  just enough stars to keep the path", "  .  .  .  *"] },
  {
    id: "stellar-thread",
    lines: ["  SIGILIX threads the dark", "  one cited line at a time", "  *--- proof ---*--- patch ---*"],
  },
  { id: "patient-star", lines: ["       *", "  a patient star is still moving", "       ."] },
  {
    id: "signal-window",
    lines: ["+---- review window ----+", "| * queued light, steady hands |", "+-----------------------+"],
  },
  { id: "galaxy-floor", lines: ["  . files below", "  * context above", "  -------- review horizon --------"] },
  { id: "careful-vector", lines: ["  vector: changed behavior", "  magnitude: evidence", "  direction: ship clean *"] },
  { id: "asterism", lines: ["  * . * . *", "   not random: asterism", "  * . * . *"] },
  { id: "proof-orbit", lines: ["   * proof", "    /     \\", "  claim---risk---fix"] },
  { id: "launch-window", lines: ["  launch window open", "  checks aligning", "  * review soon"] },
  {
    id: "signal-arc",
    lines: ["  .---- signal arc ----.", "  | changed code -> consequence |", "  `--------------------'"],
  },
  { id: "kind-constellation", lines: ["  * one careful review", "  * one less hidden risk", "  * one kinder merge"] },
] as const

export function selectReviewStatusAsciiFooter(seed: string): ReviewStatusAsciiFooter {
  return REVIEW_STATUS_ASCII_FOOTERS[hashString(seed) % REVIEW_STATUS_ASCII_FOOTERS.length]!
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}
