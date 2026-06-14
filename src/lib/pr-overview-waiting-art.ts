export const MAX_OVERVIEW_WAITING_ART_WIDTH = 78
export const MAX_OVERVIEW_WAITING_ART_HEIGHT = 26

export interface PrOverviewWaitingArt {
  id: string
  title: string
  poem: readonly [string, string]
  lines: readonly string[]
}

function art(raw: string): readonly string[] {
  const withoutLeadingBlank = raw.startsWith("\n") ? raw.slice(1) : raw
  return withoutLeadingBlank.trimEnd().split("\n")
}

export const PR_OVERVIEW_WAITING_ARTS: readonly [PrOverviewWaitingArt, ...PrOverviewWaitingArt[]] = [
  {
    id: "unfinished-constellation",
    title: "unfinished constellation",
    poem: ["the last star waits for its name", "we trace it gently before the dawn"],
    lines: art(String.raw`
        .             *                    .              *
   *         .                    .                .              .
             .-----.        .-------.        .----.
      .     /  .   \______/   *     \______/  .   \      .
           /      .      /          .      \        \
      *   *------*------*-----*------------*---------*     *
             \        .'       \        .'       .  /
        .     \  .  .'    .     \  .  .'          /
               *--*             *--*        .     *
          .       \       all proofs return to light
    .              \____       one star still unnamed       .
           *            \___.--------.____
      .                      \   .   /        *        .
                 .            \_____/              .
        *                  .             .                 *
    `),
  },
  {
    id: "accretion-vow",
    title: "accretion vow",
    poem: ["what gathers here is not hurried", "care has gravity enough to stay"],
    lines: art(String.raw`
  .            .        .----====~~~~====----.             .
       *            .-~~  .   .       *       ~~-.      *
                 .-~     .-----.   .-----.       ~-.
      .        .~      .~   .   ~.~   *   ~.        ~.
              /      .~       .-===-.       ~.        \
    *        ;      /       ./  .*.  \.       \        ;       *
             |     |      .-|  (   )  |-.      |       |
        .    |     |        \.  '-'  ./        |       |   .
             ;      \         '-===-'         /        ;
              \      ~.    gravity keeps    .~        /
       *       ~.      ~.   every promise  .~       .~      .
                 ~-.     '----.     .----'      .-~
     .              '---...___ ~~~~ ___...---'          *
          .                       '                     .
    `),
  },
  {
    id: "quiet-observatory",
    title: "quiet observatory",
    poem: ["a quiet lens keeps watch tonight", "your question crosses every pane"],
    lines: art(String.raw`
        .       *              .              *        .
   .                 .     .---------.                 .
           *              /  .  *  .  \        .
                         / .   . .   . \
        .          .----'-------------'----.
                 .'      /   /  |  \   \    '.      *
          *     /       /___/___|___\___\     \
               ;          .   . | .   .        ;
      .        |     _________  |              |      .
               |    / ____  /|  |   listening |   *
           *   |   /_/___/ /_|  |     kindly  |
                \     /   /     |             /
      .          '.  /___/______|          .'
                    '----._____.----.____.'
            .              \  \       \  \       *
                      ______\__\_______\__\__
    `),
  },
  {
    id: "orbital-letter",
    title: "orbital letter",
    poem: ["i tied a note to patient light", "it circles back with what it learned"],
    lines: art(String.raw`
   *                    .                         .        *
             .                 .----.       .-.
       .          .-----------'      '-----.'   '.      .
                .'      .        *          \     \
        *      /       .-----.        .      \     \
              ;       /  ___  \              ;      ;
      .       |      |  /   \  |   .         |      |       .
              |      |  \___/  |       .     |      |
          .   ;       \       /              ;      ;   *
               \       '-----'     care     /      /
       *        '.        keeps orbit     .'    .'
                  '----.__________.------'_.--'
             .           . . . . . . . .          .
                  message sent, review returning      *
       .                 .            .                 .
    `),
  },
  {
    id: "cartographers-window",
    title: "cartographer's window",
    poem: ["each branch becomes a little sky", "we map the risk before the road"],
    lines: art(String.raw`
     .--------------------------------------------------.
    /  o      o      o      o      o      o      o      \
   |------------------------------------------------------|
   |   .       *          .--------.          *       .   |
   |        .            /  branch \              .       |
   |   *          .-----*----*-----*----.             *   |
   |             /       \    \     \    \                |
   |      .     *----*----*----*-----*----*      .        |
   |             \        \    \     \    /               |
   |   .          '----*---*----*---*----'        *       |
   |        *          \        .       /                 |
   |   map what changed, keep what matters        .       |
   |------------------------------------------------------|
    \__o______o______o______o______o______o______o_____/
          .              .           *              .
    `),
  },
  {
    id: "lighthouse-nebula",
    title: "lighthouse nebula",
    poem: ["a beam can love the dark it scans", "and still ask every shadow why"],
    lines: art(String.raw`
           .       .          .          .        .
      *              .        /\        .              *
              .              /  \             .
        .        .          / || \       .            .
                    .      /  ||  \              *
       *                  /___||___\                  .
              .             __||__         .     .
    .                 ____.'  ||  '.____              *
             *      .'        ||        '.      .
                   /   .      ||     .    \
        .         ;           ||          ;       .
                  |  nebula   ||  listens |
             .    ;      .    ||      .   ;    *
                   \        __||__       /
       *            '.____.'  ||  '.____.'          .
                        /_____|_____\          .
              .        /_/__/_|\__\_\    *
    `),
  },
  {
    id: "peripatetic-garden",
    title: "peripatetic garden",
    poem: ["we walk the rows between extremes", "the middle path is tended, not found"],
    lines: art(String.raw`
        .        *             .             *        .
     .      .------------------------------------------------.     .
           /  ^  ^  ^  ^  ^  ^  ^  ^  ^  ^  ^  ^  ^  ^  ^  \
      *   |      .       .----.        .       .       *      |
          |   ^     .---'      '---.       ^              .   |
     .    |        /    .--.        \             .           |
          |   ^   ;    /    \   o    ;   ^   walk the mean   |
      *   |        \   \____/       /             .       ^   |
          |     .   '---.      .---'      ^                 |
     .    |   ^          '----'      .         .       ^     |
           \__^__^__^__^__^__^__^__^__^__^__^__^__^__^__/
               .        rows of thought, roots of care     *
                    .        the question keeps walking
          *             .             .             .
    `),
  },
  {
    id: "rings-of-care",
    title: "rings of care",
    poem: ["patience is a ring around the flame", "it keeps the bright work from burning"],
    lines: art(String.raw`
     .             .               .               .
          *              .-----------------.             *
                   .---'       .   .       '---.
              .---'       .----.     .----.     '---.
      .    .-'        .--'      '---'      '--.      '-.    .
          /        .-'     .       *       .    '-.      \
         ;       .'      .----.         .----.     '.     ;
    *    |      /      .'      '.     .'      '.      \    |    *
         |     ;      ;    *    ;   ;    .     ;      ;   |
         ;      \      '.      .'   '.        .'      /    ;
          \      '-.     '----'  .   '----'     .-.'     /
      .    '-.       '--.      patience      .--'     .-'   .
              '---.       '----.     .----'      .---'
                   '---.         '-'        .---'      *
          *             '-----------------'        .
    `),
  },
  {
    id: "photonic-bottle",
    title: "photonic bottle",
    poem: ["a folded star keeps your message warm", "it crosses the wait without spilling"],
    lines: art(String.raw`
        .        *           .              .        *
             .          .---.                     .
       ~ ~ ~ ~ ~ ~ ~   /  _  \    ~ ~ ~ ~ ~ ~ ~
        ~ ~ ~ ~ ~ ~   /  / \  \      ~ ~ ~ ~ ~
     .       ~ ~ ~   /__/___\__\        ~ ~        .
              ~ ~    |  .---.  |    folded star
       *      ~ ~    | /  *  \ |       inside       *
              ~ ~    | \_._./ |                 .
        .      ~     |   | |  |     light crosses
               ~ ~   |   | |  |        the wait
       ~ ~ ~ ~ ~ ~   |  _|_|_ |   ~ ~ ~ ~ ~ ~
        ~ ~ ~ ~ ~    |.'_____'|     ~ ~ ~ ~
     *       ~ ~ ~    '-------'        ~ ~ ~       .
            .                .              *
    `),
  },
  {
    id: "four-causes-garden",
    title: "four causes garden",
    poem: ["root, form, work, and end awake", "a careful crop becomes an answer"],
    lines: art(String.raw`
       .          *             .             *          .
          +------------+------------+------------+------------+
          |  soil      |  seed      |  stem      |  bloom     |
      .   | . . . . .  |    .       |  . . .     |  *  *  *   |   .
          | . . . . .  |   .|.      |  . | .     | * ** ** *  |
      *   | . . . . .  |    |       |    |       |  *  |  *   |   *
          |    .       |    |       |   /|\      |     |      |
          +------------+------------+------------+------------+
                 root       form        work        end
            .          cause becomes crop, not slogan       .
      *            .             .             .             *
          +------------+------------+------------+------------+
          | . . . . .  |   .|.      |  . | .     |  *  |  *   |
          +------------+------------+------------+------------+
    `),
  },
  {
    id: "listener-array",
    title: "listener array",
    poem: ["we heard the signal under the static", "and held it close enough to answer"],
    lines: art(String.raw`
      .          *           .             *          .
                    .                 .
          .                  ---*---                  .
      *             .          \|/          .             *
                              \ | /
               .               \|/               .
                         _______|_______
        *              .'      /|\      '.              *
                      /       / | \       \
          .          ;       /  |  \       ;          .
                     |      /   |   \      |
                     |     /____|____\     |
          .          ;      we heard you   ;       .
                      \      and stayed   /
        *              '._______________.'       *
              .             \  \ /  /        .
    `),
  },
  {
    id: "mean-arbor",
    title: "mean arbor",
    poem: ["virtue grows where both sides are pruned", "a garden learns by being tended"],
    lines: art(String.raw`
        .             *              .              *
              .        /\      /\      /\       .
      *               /__\____/__\____/__\             *
             .        |  |    |  |    |  |        .
                      |  |    |  |    |  |
        .          ___|__|____|__|____|__|___          .
                  /   <     prune both sides   >\
      *          /________________________________\          *
                / ; ; ; ; ; ; ; ; ; ; ; ; ; ; ; ; \
           .   / ; ; ; ; ; ;   .   ; ; ; ; ; ; ; ; \   .
              / ; ; ; ; ; ;   /|\   ; ; ; ; ; ; ; ; \
             /_________________|______________________\
        .              virtue grows by tending             .
             *              .              .              *
    `),
  },
  {
    id: "star-harbor",
    title: "star harbor",
    poem: ["every small ship returns with light", "some carry warnings, some carry peace"],
    lines: art(String.raw`
       .           *              .              *
                 .        __..----..__       .
         *             .-'   .  .     '-.
                    .-'   *       .       '-.
      .            /   .      .------.       \          .
                  ;          /  dock  \       ;
           .      |     *   /__________\  .   |    *
                  |        /|  []  [] |\      |
      *           ;       /_|__________|_\     ;
                   \        .  .  .  .        /
         .          '-.  every ship returns .-'      .
                       '-.  with a signal .-'
              *           '--..____..--'        *
       .                .              .              .
    `),
  },
] as const

export function selectPrOverviewWaitingArt(seed: string | undefined): PrOverviewWaitingArt {
  const value = hashString(seed ?? "sigilix")
  const index = normalizeWaitingArtIndex(value, PR_OVERVIEW_WAITING_ARTS.length)
  // Keep a runtime fallback even though the catalog is statically non-empty.
  return PR_OVERVIEW_WAITING_ARTS[index] ?? PR_OVERVIEW_WAITING_ARTS[0]
}

export function renderPrOverviewWaitingArt(seed: string | undefined): string {
  const art = selectPrOverviewWaitingArt(seed)
  return ["```text", `== ${art.title} ==`, ...art.lines, "", ...art.poem, "```"].join("\n")
}

function hashString(value: string): number {
  // 32-bit FNV-1a: tiny, deterministic, and well-distributed for art rotation.
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function normalizeWaitingArtIndex(value: number, length: number): number {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError("waiting art catalog length must be positive")
  const remainder = value % length
  return remainder < 0 ? remainder + length : remainder
}

export const _testOnlyNormalizeWaitingArtIndex = normalizeWaitingArtIndex
