export const MAX_OVERVIEW_WAITING_ART_WIDTH = 78
export const MAX_OVERVIEW_WAITING_ART_HEIGHT = 26

export interface PrOverviewWaitingArt {
  id: string
  title: string
  lines: readonly string[]
}

function art(raw: string): readonly string[] {
  const withoutLeadingBlank = raw.startsWith("\n") ? raw.slice(1) : raw
  return withoutLeadingBlank.trimEnd().split("\n")
}

export const PR_OVERVIEW_WAITING_ARTS: readonly PrOverviewWaitingArt[] = [
  {
    id: "unfinished-constellation",
    title: "unfinished constellation",
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
  return PR_OVERVIEW_WAITING_ARTS[value % PR_OVERVIEW_WAITING_ARTS.length]!
}

export function renderPrOverviewWaitingArt(seed: string | undefined): string {
  const art = selectPrOverviewWaitingArt(seed)
  return ["```text", `== ${art.title} ==`, ...art.lines, "```"].join("\n")
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
