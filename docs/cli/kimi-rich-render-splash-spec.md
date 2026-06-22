# Sigilix `review` CLI — Terminal Render Spec

---

## 1. RICH FINDING LINE LAYOUT

### Visual mockup (single finding)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  P1  logic  GROUNDED   Heap allocation in hot loop silently fails          │
│  src/engine/buffer.c:247                                                   │
│                                                                            │
│     The realloc() result is assigned directly to `buf`, so a failed        │
│     allocation leaks the old buffer and breaks downstream reads.             │
│     Treat this as a logic bug with security/error-handling overlap.          │
│                                                                            │
│     Suggested replacement:                                                 │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │  void *tmp = realloc(buf, new_size);                            │    │
│     │  if (!tmp) { /* preserve buf, propagate error */ }              │    │
│     │  buf = tmp;                                                     │    │
│     └─────────────────────────────────────────────────────────────────┘    │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Exact row construction (one logical finding = one multi-row block)

Render each row with explicit leading/trailing spaces. Use full-width block characters only if the terminal supports it; otherwise fall back to plain text.

| Token | ANSI bg | ANSI fg | Text |
|---|---|---|---|
| `P1` | `41;38;2;245;158;11m` bg | `38;2;0;0;0m` fg | ` P1 ` |
| `logic` | `48;2;125;211;252m` bg | `38;2;0;0;0m` fg | ` logic ` |
| `GROUNDED` | `48;2;52;211;153m` bg | `38;2;0;0;0m` fg | ` GROUNDED ` |
| headline | none | `38;2;255;255;255m` + bold | text |
| path:line | none | `38;2;148;163;184m` | `  src/engine/buffer.c:247` |

### ANSI helpers (Node)

```js
const ESC = '\x1b[';
const SGR = (codes) => `${ESC}${codes}m`;
const RESET = SGR('0');

function fg(r,g,b) { return SGR(`38;2;${r};${g};${b}`); }
function bg(r,g,b) { return SGR(`48;2;${r};${g};${b}`); }
function bold()    { return SGR('1'); }
function dim()     { return SGR('2'); }

const PILL = (label, bgColor, fgColor = [0,0,0]) =>
  `${bg(...bgColor)}${fg(...fgColor)} ${label} ${RESET}`;
```

### Exact pill renderer

```js
const SEV = {
  P0: { bg: [185, 28, 28],  fg: [255,255,255] },
  P1: { bg: [245, 158, 11], fg: [0,0,0] },
  P2: { bg: [132, 204, 22], fg: [0,0,0] },
  P3: { bg: [59, 130, 246], fg: [255,255,255] },
};

const TRUST = {
  VERIFIED:  { bg: [6, 182, 212],  fg: [0,0,0] },
  REPRODUCED:{ bg: [37, 99, 235],  fg: [255,255,255] },
  GROUNDED:  { bg: [52, 211, 153], fg: [0,0,0] },
  MODEL:     { bg: [167, 139, 250], fg: [0,0,0], dim: true },
};

const CAT = {
  logic:         [125, 211, 252],
  security:      [240, 171, 252],
  performance:   [253, 186, 116],
  'error-handling':[252, 165, 165],
  testing:       [134, 239, 172],
  complexity:    [196, 181, 253],
  style:         [147, 197, 253],
  syntax:        [253, 230, 138],
  docs:          [203, 213, 225],
};
```

### Full finding render function

```js
function renderFinding(f) {
  const sevKey = scoreToSev(f.score);          // 5->P0, 4->P1, 3->P2, <=2->P3
  const sev = SEV[sevKey];
  const cat = CAT[f.category];
  const trust = TRUST[f.trustTier];
  const trustDim = trust.dim ? dim() : '';

  const top =
    PILL(sevKey, sev.bg, sev.fg) +
    ' ' +
    PILL(f.category, cat) +
    ' ' +
    trustDim + PILL(f.trustTier, trust.bg, trust.fg) +
    ' ' +
    bold() + fg(255,255,255) + f.headline + RESET;

  const loc = '  ' + dim() + fg(148,163,184) + `${f.path}:${f.line}` + RESET;

  const bodyLines = wrap(f.body, Math.min(process.stdout.columns - 6, 94));
  const body = bodyLines.map(l =>
    '     ' + fg(226,232,240) + l + RESET
  ).join('\n');

  let out = `\n${top}\n${loc}\n${body}`;

  if (f.suggestedReplacement) {
    const sug = f.suggestedReplacement.split('\n');
    const max = Math.max(...sug.map(s => stripAnsi(s).length));
    const pad = n => ' ' + n + ' '.repeat(max - stripAnsi(n).length + 1);
    const boxTop  = '     ' + fg(148,163,184) + '┌' + '─'.repeat(max + 2) + '┐' + RESET;
    const boxMid  = sug.map(line =>
      '     ' + fg(148,163,184) + '│' + RESET +
      fg(250,204,21) + pad(line) + RESET +
      fg(148,163,184) + '│' + RESET
    ).join('\n');
    const boxBot  = '     ' + fg(148,163,184) + '└' + '─'.repeat(max + 2) + '┘' + RESET;
    out += `\n     ${dim()}${fg(203,213,225)}Suggested replacement:${RESET}\n${boxTop}\n${boxMid}\n${boxBot}`;
  }

  return out;
}
```

**Spacing rule:** two blank lines between findings, zero blank lines inside a finding block.

---

## 2. OVERVIEW BLOCK LAYOUT

### Visual mockup

```
SIGILIX REVIEW OVERVIEW
  7 findings · 5 grounded · 2 reproduced · 0 verified · 0 model-only
  Trust check: 100 % grounded or better · 0 hallucinated

FIX PLAN
  P0  security      src/auth/token.c:88   Rotate leaked secret immediately
  P1  logic         src/engine/buffer.c:247 Fix realloc error path
  P2  performance   src/loop.c:12           Cache repeated lookup
  P3  style         src/main.c:4            Remove trailing whitespace

TRUST SUMMARY
  VERIFIED   0  ▓▓░░░░░░░░  0 %
  REPRODUCED 2  ▓▓▓▓░░░░░░  40 %
  GROUNDED   5  ▓▓▓▓▓▓▓▓▓▓ 100 %
  MODEL      0  ░░░░░░░░░░   0 %
```

### Render function

```js
function renderOverview(overview) {
  const { grounded, reproduced, verified, model, total, hallucinated, plan } = overview;

  const proof =
    `${bold()}${fg(255,255,255)}SIGILIX REVIEW OVERVIEW${RESET}\n` +
    `  ${fg(148,163,184)}${total} findings · ` +
    `${fg(52,211,153)}${grounded} grounded${fg(148,163,184)} · ` +
    `${fg(37,99,235)}${reproduced} reproduced${fg(148,163,184)} · ` +
    `${fg(6,182,212)}${verified} verified${fg(148,163,184)} · ` +
    `${fg(167,139,250)}${model} model-only${RESET}\n` +
    `  ${fg(148,163,184)}Trust check: ` +
    `${fg(52,211,153)}${Math.round(((grounded+reproduced+verified)/total)*100)} % grounded or better` +
    `${fg(148,163,184)} · ${hallucinated} hallucinated${RESET}`;

  const fixHeader = `\n${bold()}${fg(255,255,255)}FIX PLAN${RESET}`;
  const fixRows = plan.map(p => {
    const sev = SEV[p.sevKey];
    return '  ' +
      PILL(p.sevKey, sev.bg, sev.fg) + ' ' +
      PILL(p.category, CAT[p.category]) + ' ' +
      dim() + fg(148,163,184) + padRight(`${p.path}:${p.line}`, 28) + RESET + ' ' +
      fg(226,232,240) + p.headline + RESET;
  }).join('\n');

  const trustHeader = `\n${bold()}${fg(255,255,255)}TRUST SUMMARY${RESET}`;
  const bars = [
    ['VERIFIED',   verified,   [6,182,212]],
    ['REPRODUCED', reproduced, [37,99,235]],
    ['GROUNDED',   grounded,   [52,211,153]],
    ['MODEL',      model,      [167,139,250]],
  ].map(([label, count, color]) => {
    const pct = total ? Math.round((count/total)*100) : 0;
    const filled = Math.round((count/total)*10) || 0;
    const bar = fg(...color) + '▓'.repeat(filled) + dim() + '░'.repeat(10-filled) + RESET;
    return `  ${bold()}${fg(...color)}${padRight(label,10)}${RESET} ${padLeft(String(count),2)}  ${bar}  ${pct} %`;
  }).join('\n');

  return `${proof}${fixHeader}\n${fixRows}\n${trustHeader}\n${bars}\n`;
}
```

---

## 3. ANIMATED STARTUP SPLASH

### Rendering technique

- **Half-block characters**: `▀` (upper half, foreground color = top pixel) and `▄` (lower half, foreground color = bottom pixel). Each terminal cell represents a 1×2 vertical pixel stack.
- **Truecolor**: set upper pixel via `38;2` and lower pixel via `48;2` on the same character.
- **Frame loop**: 12–18 fps; recommended 16 fps (~62 ms).
- **Redraw**: write frame, then `ESC[H` (cursor home) or `ansiEscapes.cursorTo(0,0)`; do NOT clear screen (avoids flicker). On exit, print a final blank frame + `ESC[0m` and release cursor.
- **Canvas size**: fixed 80×24 character cells → 80×48 logical pixels.

### Frame/timing design

```
Frame pipeline (every ~62 ms):
  1. Compute star positions (drift left; wrap).
  2. Compute ship bob offset = round(sin(frame * 0.18) * 1).
  3. Composite logo (static), stars, ship, subtitle into 80×48 pixel buffer.
  4. Encode to half-block rows.
  5. Write to stdout; cursor home.
```

Star field:
- 60 stars.
- Each star: `{x, y, speed, brightness }`.
- x decreases by speed each frame; wrap to right edge.
- Brightness 120–255, twinkle via `brightness += random(-8,8)` clamped.

Ship:
- Base position: row 34, col 66 (in cells).
- Bob ±1 row via `Math.sin(frame * 0.18)`.
- Subtitle below ship: "reviewing the changes" in dim slate.

Logo:
- "SIGILIX" in 7-segment-ish block letters, 5×3 cell glyphs, centered at cell row 8, col 26.
- Static. Color gradient: left letter #7DD3FC → right letter #C4B5FD.

### Library choice

```js
import chalk from 'chalk';
import ansiEscapes from 'ansi-escapes';
import { stdin, stdout } from 'node:process';
import { ReadStream } from 'node:tty';
```

**No ink / blessed / react-blessed.** Hand-roll the canvas-to-half-block encoder.

### TTY detection & fallback

```js
import { isatty } from 'node:tty';

const useAnimation = isatty(stdout.fd) && !process.env.CI && process.env.SIGILIX_NO_ANIMATION !== '1';

if (!useAnimation) {
  console.log(renderStaticSplash());
  return;
}
```

Static fallback frame:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                         ░░░░░░░░░░░░░░░░░░░░░░                             │
│                         ░░  S I G I L I X  ░░                              │
│                         ░░░░░░░░░░░░░░░░░░░░░░                             │
│                                                                            │
│                         reviewing the changes                              │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Literal sample: logo glyph map + ship sprite

#### Logo: SIGILIX block glyphs

Each letter is a 5-wide × 3-tall cell grid. A cell is filled (`#`) or empty (`.`).

```js
const LETTERS = {
  S: [
    ' ### ',
    ' ##  ',
    ' ### ',
  ],
  I: [
    ' ### ',
    '  #  ',
    ' ### ',
  ],
  G: [
    ' ### ',
    '#  ##',
    ' ### ',
  ],
  L: [
    '#    ',
    '#    ',
    '#### ',
  ],
  X: [
    '#   #',
    '  #  ',
    '#   #',
  ],
};
// SIGILIX = S I G I L I X
```

Render into pixel buffer by mapping each `#` to a pixel at 2× vertical resolution.

#### Ship sprite (8×6 pixels)

```js
const SHIP = [
  '   ▄██▄   ',
  '  ▄████▄  ',
  ' ▄██████▄ ',
  '██████████',
  '  ██  ██  ',
  ' ▀▀    ▀▀ ',
];
```

For half-block composition, convert to a monochrome pixel mask and draw in the buffer with ship color `#FDBA74` + engine glow `#F59E0B` at the rear two pixels.

#### Half-block encoder core

```js
function encodeFrame(buf, W, H) {
  // buf[y][x] = [r,g,b] or null
  let out = ansiEscapes.cursorTo(0, 0);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x++) {
      const top = buf[y]?.[x] ?? [0,0,0];
      const bot = buf[y + 1]?.[x] ?? [0,0,0];
      out += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m` +
             `\x1b[48;2;${bot[0]};${bot[1]};${bot[2]}m▀`;
    }
    out += '\x1b[0m\n';
  }
  return out;
}
```

Background: deep navy `#0F172A` as default fill.

### Startup lifecycle

```js
async function playSplash(durationMs = 2200) {
  setupRawStdin(); // allow Ctrl-C to exit cleanly

  const W = 80, H = 48;
  const stars = initStars(60, W, H);
  let frame = 0;
  const start = Date.now();

  const timer = setInterval(() => {
    const elapsed = Date.now() - start;
    const buf = blankBuffer(W, H, [15,23,42]); // #0F172A

    drawStars(buf, stars, W, H);
    drawLogo(buf, W, H, frame);
    drawShip(buf, W, H, frame);

    const text = "reviewing the changes";
    drawText(buf, text, Math.floor((W - text.length)/2), 38, [148,163,184]);

    stdout.write(encodeFrame(buf, W, H));

    frame++;
    if (elapsed >= durationMs) {
      clearInterval(timer);
      teardown();
      stdout.write(ansiEscapes.cursorTo(0, H/2) + ansiEscapes.eraseDown);
    }
  }, 62);
}
```

---

## 4. NO_COLOR / NON-TRUECOLOR FALLBACKS

### Detection

```js
const noColor = process.env.NO_COLOR || process.env.FORCE_COLOR === '0';
const supportsTrueColor = (() => {
  if (noColor) return false;
  const ct = process.env.COLORTERM;
  if (ct === 'truecolor' || ct === '24bit') return true;
  if (process.env.TERM === 'xterm-256color' && !process.env.COLORTERM) return false;
  return false; // default to safe 256-color
})();
```

### Fallback strategy

| Capability | Behavior |
|---|---|
| `NO_COLOR` set | All SGR reduced to `0`; pills become `[P0]` / `[logic]` / `[GROUNDED]` with brackets only, no background. |
| 256-color only | Map truecolor hex to nearest xterm-256 via a small lookup table. Severity/trust fall back to named chalk helpers: `chalk.bgRed`, `chalk.bgYellow`, etc. |
| No color | Plain text; pills use brackets. |
| Non-TTY / CI | Skip splash entirely; emit one-line spinner: `Sigilix review starting…` then findings. |

### Chalk-aware helper

```js
function truecolorOrFallback(r, g, b, chalkFn) {
  if (noColor) return { open: '', close: '' };
  if (supportsTrueColor) {
    return { open: `\x1b[38;2;${r};${g};${b}m`, close: '\x1b[39m' };
  }
  return chalkFn ? { open: chalkFn.open, close: chalkFn.close }
                 : chalk.hex(rgbToHex(r,g,b));
}
```

Use `chalk` for 256-color fallbacks; hand-roll truecolor only when confirmed.

### Splash fallback

If terminal height < 30 or width < 80, disable animation and print static one-liner:

```
  Sigilix review — analyzing changes…
```

---

## IMPLEMENTATION CHECKLIST

- [ ] `renderFinding()` with pill spacing as specified.
- [ ] `renderOverview()` with proof line, fix-plan table, trust bars.
- [ ] Half-block splash canvas (80×48), 16 fps, cursor-home redraw.
- [ ] Static splash fallback for non-TTY/CI/NO_COLOR.
- [ ] `SIGILIX_NO_ANIMATION=1` kill-switch.
- [ ] `supportsTrueColor` gate around `38;2`/`48;2`.
- [ ] Clean exit: final erase-down + reset + show cursor.
