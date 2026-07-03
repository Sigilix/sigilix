// Convert standard Markdown (what the model emits) to Slack's mrkdwn dialect.
//
// Slack does NOT render `**bold**`, `# headings`, or `[text](url)` links — those
// show up as literal asterisks / hashes / brackets. This converts the outgoing
// message text before it's posted so replies render correctly:
//   - **bold** / __bold__      -> *bold*
//   - # Heading (h1..h6)       -> *Heading*   (bold line)
//   - [text](url)              -> <url|text>
// Inline code (`code`), fenced code blocks (```...```), and bullet lines (`- `)
// are left untouched — Slack already renders those.

/** A code region (fenced block or inline span) preserved verbatim during conversion. */
const CODE_REGION = /```[\s\S]*?```|`[^`\n]*`/g

// Sentinel wrapping protected code regions during conversion. Pure ASCII, matched
// by none of the Markdown patterns below, and astronomically unlikely to appear in
// real Slack text — so protected regions round-trip verbatim without collision.
const sentinel = (i: number): string => `@@MRKDWN_CODE_${i}@@`
const RESTORE = /@@MRKDWN_CODE_(\d+)@@/g

/**
 * Convert Markdown to Slack mrkdwn. Code spans/blocks are protected so their
 * contents are never rewritten. Idempotent-safe on already-mrkdwn text: single
 * `*bold*` and `<url|text>` links are not matched by the Markdown patterns.
 */
export function markdownToMrkdwn(input: string): string {
  if (!input) return input

  // Protect code regions with sentinels so their contents survive verbatim.
  const protectedRegions: string[] = []
  let text = input.replace(CODE_REGION, (match) => {
    const idx = protectedRegions.length
    protectedRegions.push(match)
    return sentinel(idx)
  })

  // Links: [text](url) -> <url|text>. Restrict url to non-space, non-paren chars.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>")

  // Bold: **text** or __text__ -> *text* (Slack bold is a single asterisk). This
  // mirrors standard Markdown/CommonMark, which DOES bold `__init__`-style dunders
  // in prose — so `__init__` becomes `*init*`, matching how GitHub renders it. Code
  // identifiers should be backtick-wrapped (they always are in the agent's output),
  // and backtick spans are protected above, so real code refs are never touched.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
  text = text.replace(/__([^_\n]+)__/g, "*$1*")

  // Headings: a leading #{1,6} on a line -> a bold line.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")

  // Restore protected code regions.
  text = text.replace(RESTORE, (_m, i: string) => protectedRegions[Number(i)] ?? "")

  return text
}
