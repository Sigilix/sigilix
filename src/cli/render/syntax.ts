// SIG-304 (review CLI) — a tiny, dependency-free syntax tokenizer for the `--rich`
// code panel. Returns TOKENS (text + fg hex), NOT pre-painted ANSI, so the renderer can
// compose each token's fg with the line's diff-tint BACKGROUND in a single SGR (a
// pre-painted string would reset the bg). Deliberately approximate — over-coloring an
// identifier is harmless; this is presentation, not a parser.

export interface SyntaxToken {
  text: string
  /** fg hex, or undefined for the default identifier/plain color. */
  color?: string
}

const COLORS = { comment: "#6e7681", str: "#a5d6ff", num: "#79c0ff", kw: "#ff7b72", type: "#d2a8ff" }

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  ts: new Set(
    (
      "const let var function return if else for while do await async new throw try catch finally class extends " +
      "implements import export from default type interface enum public private protected readonly static void " +
      "number string boolean null undefined true false this super switch case break continue typeof instanceof in of as"
    ).split(" "),
  ),
  py: new Set(
    "def class return if elif else for while import from as None True False raise try except finally with lambda yield async await pass break continue and or not in is global nonlocal".split(
      " ",
    ),
  ),
  go: new Set(
    "func var const type struct interface return if else for range go defer package import map chan select switch case break continue nil true false".split(
      " ",
    ),
  ),
  rs: new Set(
    "fn let mut const struct enum impl trait pub use mod match if else for while loop return self Self where async await move ref dyn as in true false".split(
      " ",
    ),
  ),
}

const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "py",
  go: "go",
  rs: "rs",
}

/** Map a file path to a keyword set key (defaults to "ts" — harmless over-highlighting). */
export function langForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return EXT_LANG[ext] ?? "ts"
}

const RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g

/** Tokenize one line of source into {text,color} spans. Whole-line comments/strings
 *  are colored; identifiers matched against the language keyword set; Capitalized
 *  identifiers read as types. */
export function tokenize(line: string, lang: string): SyntaxToken[] {
  const kw = KEYWORDS[lang] ?? KEYWORDS.ts!
  const out: SyntaxToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  RE.lastIndex = 0
  while ((m = RE.exec(line)) !== null) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) })
    if (m[1]) out.push({ text: m[1], color: COLORS.comment })
    else if (m[2]) out.push({ text: m[2], color: COLORS.str })
    else if (m[3]) out.push({ text: m[3], color: COLORS.num })
    else {
      const w = m[4]!
      const color = kw.has(w) ? COLORS.kw : /^[A-Z]/.test(w) ? COLORS.type : undefined
      out.push(color !== undefined ? { text: w, color } : { text: w })
    }
    last = RE.lastIndex
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out
}
