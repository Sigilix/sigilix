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
  {
    id: "steady-constellation",
    lines: ["  * steady constellation *", "  small signals become a map", "  every cited line matters"],
  },
  {
    id: "horizon-pulse",
    lines: ["  . horizon pulse .", "  the diff is quiet, the checks are awake", "  * care travels first"],
  },
  {
    id: "starlit-queue",
    lines: ["  queued beneath starlight", "  context warming in the dark", "  * a review is taking shape"],
  },
  {
    id: "orbital-handoff",
    lines: ["  orbit one: gather", "  orbit two: reason", "  orbit three: return with proof *"],
  },
  {
    id: "vacuum-note",
    lines: ["  * no sound in the vacuum", "  but the signal still arrives", "  line by line, with care"],
  },
  {
    id: "dusk-telescope",
    lines: ["      *", "  dusk telescope open", "  looking for the bug hiding in plain light"],
  },
  {
    id: "midnight-index",
    lines: ["  midnight index", "  * current ref, live lines", "  no stale stars in the answer"],
  },
  {
    id: "gravity-well",
    lines: ["  * risk has gravity", "  evidence gives it shape", "  the fix finds its orbit"],
  },
  {
    id: "comet-letter",
    lines: ["  comet note ---->", "  tail made of tests and citations", "  * sent back with care"],
  },
  {
    id: "quiet-supernova",
    lines: ["  * quiet supernova", "  a small finding can save a release", "  let the light arrive gently"],
  },
  {
    id: "beacon-array",
    lines: ["  *   *   *   beacon array", "  every specialist keeps a light", "  the final signal is shared"],
  },
  {
    id: "home-star",
    lines: ["        * home star", "  code changes, people depend on it", "  review with the lights on"],
  },
  {
    id: "love-letter-orbit",
    lines: ["  * love letter in orbit", "  every changed line gets a reply", "  signed: patience, proof, and care"],
  },
  {
    id: "heart-constellation",
    lines: ["  . heart constellation .", "  small lights hold each other", "  until the review finds its way home"],
  },
  {
    id: "dear-diff",
    lines: ["  dear diff,", "  we are reading you by starlight", "  * no line waits alone"],
  },
  {
    id: "devotion-star",
    lines: ["        * devotion star", "  not fast at the cost of truth", "  not quiet at the cost of care"],
  },
  {
    id: "beloved-signal",
    lines: ["  beloved signal,", "  cross the dark with context", "  * arrive as something useful"],
  },
  {
    id: "vow-at-dawn",
    lines: ["  vow at dawn *", "  cite what we touch", "  protect what people trust"],
  },
  {
    id: "orbiting-heart",
    lines: ["     .- heart in orbit -.", "  love is attention, line by line", "     `- proof brings it home -'"],
  },
  {
    id: "quiet-love-poem",
    lines: ["  * quiet love poem", "  to the work not yet reviewed", "  we will meet you with care"],
  },
  {
    id: "starlight-vow",
    lines: ["  starlight vow .", "  if a risk is hiding, we will name it", "  if it is safe, we will say why *"],
  },
  {
    id: "heartfelt-reentry",
    lines: ["  heartfelt reentry", "  from orbit back to merge", "  * carrying proof, not noise"],
  },
  {
    id: "telos-love-star",
    lines: [
      "  * telos under a quiet sky",
      "  love gives the waiting a direction",
      "  care keeps the light from drifting",
    ],
  },
  {
    id: "ethos-window",
    lines: ["  . ethos in the window", "  speak with warmth, even when alone", "  human care is part of the room"],
  },
  {
    id: "wonder-door",
    lines: [
      "  * wonder keeps the door open",
      "  a tired heart can still be met gently",
      "  the stars wait without judgment",
    ],
  },
  {
    id: "catharsis-exhale",
    lines: [
      "  . catharsis is the soft exhale",
      "  after holding too much by yourself",
      "  care returns like starlight",
    ],
  },
  {
    id: "recognition-lantern",
    lines: ["  * recognition lantern", "  to be seen is a kind of shelter", "  your effort has a place here"],
  },
  {
    id: "reversal-at-dusk",
    lines: ["  . reversal at dusk", "  even the hard turn can become mercy", "  stay close to the light"],
  },
  {
    id: "golden-mean-heart",
    lines: ["  * golden mean, steady heart", "  not too hard on yourself tonight", "  not too quick to let care go"],
  },
  {
    id: "contemplation-porch",
    lines: ["  . contemplation on the porch", "  no one has to rush the dawn", "  human hands can rest a moment"],
  },
  {
    id: "friendship-orbit",
    lines: ["  * friendship has an orbit", "  near enough to warm the silence", "  far enough to let you breathe"],
  },
  {
    id: "telos-homecoming",
    lines: ["  . telos as homecoming", "  every long path wants a warm door", "  care is already lighting it"],
  },
  {
    id: "ethos-soft-hands",
    lines: ["  * ethos in soft hands", "  hold the unfinished thing gently", "  it is human to need more time"],
  },
  {
    id: "wonder-after-midnight",
    lines: ["  . wonder after midnight", "  the sky is still making room", "  so are we, with care"],
  },
  {
    id: "catharsis-tide",
    lines: ["  * catharsis like a tide", "  what was heavy can still move", "  stay until the shore appears"],
  },
  {
    id: "recognition-of-you",
    lines: ["  . recognition of you", "  not just the work, not just the wait", "  the human behind the glow"],
  },
  {
    id: "reversal-kind-plot",
    lines: ["  * reversal can be kind", "  the story turns toward better light", "  care writes the next line"],
  },
  {
    id: "golden-mean-promise",
    lines: ["  . golden mean promise", "  enough courage, enough tenderness", "  a star between both"],
  },
  {
    id: "contemplation-heartbeat",
    lines: ["  * contemplation heartbeat", "  slow attention is still devotion", "  the sky understands slow things"],
  },
  {
    id: "friendship-starlit-bench",
    lines: ["  . friendship on a starlit bench", "  no fixing first, just presence", "  care sits beside the wait"],
  },
  {
    id: "telos-small-flame",
    lines: ["  * telos as a small flame", "  the reason you began is not gone", "  love keeps it visible"],
  },
  {
    id: "ethos-aftercare",
    lines: ["  . ethos as aftercare", "  what we leave behind should be gentle", "  even in the margins"],
  },
  {
    id: "wonder-human-room",
    lines: ["  * wonder makes a human room", "  where nobody is only output", "  and care is not an extra"],
  },
  {
    id: "catharsis-blue-hour",
    lines: ["  . catharsis at blue hour", "  a held breath finds the stars", "  a tired heart finds care"],
  },
  {
    id: "recognition-without-noise",
    lines: ["  * recognition without noise", "  a quiet yes for the effort", "  a kind light for the wait"],
  },
  {
    id: "reversal-soft-landing",
    lines: ["  . reversal, soft landing", "  not every turn has to bruise", "  care can change the descent"],
  },
  {
    id: "golden-mean-rest",
    lines: ["  * golden mean of rest", "  enough striving, enough sleep", "  human hearts need both"],
  },
  {
    id: "contemplation-signal-fire",
    lines: ["  . contemplation signal fire", "  not idle, not empty", "  care thinking under stars"],
  },
  {
    id: "friendship-long-night",
    lines: [
      "  * friendship through the long night",
      "  stay if you can, rest if you need",
      "  the light will remember you",
    ],
  },
  {
    id: "telos-of-kindness",
    lines: ["  . telos of kindness", "  the end is not only to be right", "  but to leave someone less alone"],
  },
  {
    id: "ethos-quiet-table",
    lines: ["  * ethos at the quiet table", "  there is room for doubt here", "  and room for care"],
  },
  {
    id: "wonder-as-welcome",
    lines: ["  . wonder as welcome", "  the unknown knocks softly", "  human kindness opens the door"],
  },
  {
    id: "catharsis-in-the-stars",
    lines: ["  * catharsis in the stars", "  the ache becomes a pattern", "  the pattern becomes peace"],
  },
  {
    id: "recognition-warm-mirror",
    lines: ["  . recognition, warm mirror", "  not larger than life, not smaller", "  just human, held in care"],
  },
  {
    id: "reversal-gentle-plot",
    lines: ["  * reversal in a gentle plot", "  what surprised you may still serve you", "  stay near the meaning"],
  },
  {
    id: "golden-mean-kind-sky",
    lines: ["  . golden mean under a kind sky", "  enough fire to move", "  enough care to return whole"],
  },
  {
    id: "contemplation-vow",
    lines: ["  * contemplation vow", "  look slowly, answer honestly", "  keep the human in the light"],
  },
  {
    id: "friendship-background-stars",
    lines: [
      "  . friendship as background stars",
      "  always there, not always loud",
      "  care does not need a spotlight",
    ],
  },
  {
    id: "dear-night-sky",
    lines: ["  dear night sky .", "  keep this person gently", "  until the waiting becomes morning"],
  },
  {
    id: "beloved-quiet",
    lines: ["  * beloved quiet", "  no need to earn the stars tonight", "  just breathe where you are"],
  },
  {
    id: "promise-of-dawn",
    lines: ["  . promise of dawn", "  the dark is not a verdict", "  care is already on its way"],
  },
  {
    id: "human-constellation",
    lines: ["  * human constellation", "  every person is more than the task", "  every wait deserves warmth"],
  },
  {
    id: "tender-orbit",
    lines: ["  . tender orbit", "  come close enough to be comforted", "  keep enough space to breathe"],
  },
  {
    id: "hands-full-of-stars",
    lines: ["  * hands full of stars", "  carrying what today was heavy with", "  setting it down with care"],
  },
  {
    id: "stay-for-the-light",
    lines: ["  . stay for the light", "  not because you must be strong", "  because morning is still coming"],
  },
  {
    id: "heart-under-nebula",
    lines: ["  * heart under nebula", "  even scattered things can glow", "  care gathers them softly"],
  },
  {
    id: "love-without-noise",
    lines: ["  . love without noise", "  a small lamp in a wide dark", "  enough to find your way"],
  },
  {
    id: "kind-background",
    lines: ["  * kind background", "  not every comfort needs a name", "  some stars simply stay"],
  },
  {
    id: "homeward-comet",
    lines: ["  . homeward comet", "  bright from the travel", "  carrying care back to earth"],
  },
  {
    id: "dear-tired-heart",
    lines: ["  * dear tired heart", "  you are allowed to be unfinished", "  the sky has room for that"],
  },
  {
    id: "vow-of-softness",
    lines: ["  . vow of softness", "  be precise, but not cold", "  be clear, but stay kind"],
  },
  {
    id: "devotion-in-the-dark",
    lines: ["  * devotion in the dark", "  what matters is still being held", "  even before anyone sees it"],
  },
  {
    id: "beloved-horizon",
    lines: ["  . beloved horizon", "  far does not mean unreachable", "  care walks there slowly"],
  },
  {
    id: "human-skyline",
    lines: ["  * human skyline", "  windows lit by ordinary hope", "  each one worth protecting"],
  },
  {
    id: "tender-star-map",
    lines: ["  . tender star map", "  not directions for perfection", "  directions back to yourself"],
  },
  {
    id: "hands-at-rest",
    lines: ["  * hands at rest", "  the work can wait with you", "  care is not wasted time"],
  },
  {
    id: "stay-gentle",
    lines: ["  . stay gentle", "  even when the night asks for armor", "  the stars know another way"],
  },
  {
    id: "heart-in-the-margin",
    lines: ["  * heart in the margin", "  a small note can hold a person", "  care fits in narrow places"],
  },
  {
    id: "love-as-background-light",
    lines: ["  . love as background light", "  not demanding the center", "  making the whole room visible"],
  },
  {
    id: "kindness-asterism",
    lines: ["  * kindness asterism", "  separate lights choosing a shape", "  care is how they connect"],
  },
  {
    id: "home-star-for-humans",
    lines: ["  . home star for humans", "  a place to return after trying", "  warm enough for the truth"],
  },
  {
    id: "promise-kept-in-stars",
    lines: ["  * promise kept in stars", "  you are not only what you finish", "  care knows the rest of you"],
  },
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
