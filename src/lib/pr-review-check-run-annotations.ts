// SIG-318 / SIG-366: the check-run annotation sanitizer cluster — the public
// `toPlainTextAnnotation` + its private `stripMarkupToPlainText` /
// `isPostableAnnotation` helpers — split into a sibling leaf so
// `pr-review-check-run.ts` stays under the 1k-line cap (the SIG-318 file-size
// invariant) after Prettier's canonical wrapping pushed it just over. Moved VERBATIM
// (only the `export` keyword + the import path change). ZERO behavior change.
//
// `toPlainTextAnnotation` is part of the public surface (exported for tests), so
// `pr-review-check-run.ts` re-exports it so the surface is byte-identical; the other
// two stay module-private (imported back into the check-run module for `postCheckAnnotations`).
//
// Dependency rule: a pure leaf — it imports only the `CheckRunAnnotation` type from
// the github types leaf and never imports the check-run module.

import type { CheckRunAnnotation } from "@/src/shared/types/github"

/**
 * SIG-144 / SIG-216: GitHub renders the annotation `title`, `message`,
 * and `raw_details` fields as PLAIN TEXT. The ensemble producer builds
 * annotation bodies from the same markdown the PR-comment surface uses
 * (`**bold**`, `<details>`, badge `<img>` tags, `[link](url)`), which
 * dumps literally. This strips the markup down to readable prose so the
 * annotation reads cleanly in the Files tab + Checks UI.
 *
 * Pure — exported for tests.
 */
export function toPlainTextAnnotation(a: CheckRunAnnotation): CheckRunAnnotation {
  const out: CheckRunAnnotation = {
    path: a.path,
    start_line: a.start_line,
    end_line: a.end_line,
    annotation_level: a.annotation_level,
    message: stripMarkupToPlainText(a.message),
  }
  if (a.title !== undefined) out.title = stripMarkupToPlainText(a.title)
  if (a.raw_details !== undefined) out.raw_details = stripMarkupToPlainText(a.raw_details)
  return out
}

/**
 * SIG-144: reduce GitHub-flavored markdown / HTML to plain text. Order is
 * deliberate: drop dangerous element bodies, then real `<img>`/`<br>`, then
 * unwrap ONLY our renderers' allow-listed tags, then markdown, and **decode
 * HTML entities LAST**. Decoding last is the fix for two PR #339 findings:
 * a literal code example like `` `&lt;details&gt;` `` stays readable text
 * instead of being decoded into a real tag and then deleted by the allow-list
 * (CodeRabbit), and entity-encoded markup can't be normalized into a
 * surviving non-allow-listed tag (Sigilix). Real tags emitted by our
 * renderers are already plain `<...>` (not entity-encoded), so they're
 * stripped before the decode pass runs.
 */
function stripMarkupToPlainText(input: string): string {
  let s = input
  // Best-effort tidy-up: drop dangerous *literal* element bodies so they don't
  // dump as noise. NOT a security control and NOT load-bearing — the output
  // sink (GitHub annotation message/title/raw_details) is rendered as PLAIN
  // TEXT, so nothing here is ever live HTML. Note this runs BEFORE the
  // entity-decode below, so entity-encoded markup an author wrote as an example
  // (e.g. a finding that literally discusses `&lt;script&gt;`) is intentionally
  // preserved as readable text rather than stripped. (PR #339 review.)
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
  // Drop badge / image tags entirely (they carry no readable text).
  s = s.replace(/<img\b[^>]*>/gi, "")
  // <br> → newline so structure isn't lost.
  s = s.replace(/<br\s*\/?>/gi, "\n")
  // Unwrap ONLY the HTML tags our finding renderers actually emit — an
  // ALLOW-LIST, not a blanket `<[a-z]…>` strip. The blanket strip deleted
  // TypeScript generics in finding text (`Map<string, number>` → `Map`,
  // `Promise<void>` → `Promise`) — silently corrupting the very content
  // this surface exists to show. (PR #339 review: P1.)
  s = s.replace(
    /<\/?(?:details|summary|sub|sup|b|i|em|strong|code|pre|a|p|div|span|kbd|ul|ol|li|blockquote|h[1-6]|table|thead|tbody|tr|td|th)\b[^>]*>/gi,
    "",
  )
  // Markdown links [text](url) → "text (url)".
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  // Bold / italic emphasis markers.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1")
  s = s.replace(/__([^_]+)__/g, "$1")
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
  // Code spans / fences → keep inner text, drop backticks.
  s = s.replace(/```[a-z]*\n?/gi, "")
  s = s.replace(/`+/g, "")
  // Heading / blockquote / list leaders at line starts.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
  s = s.replace(/^[ \t]*>[ \t]?/gm, "")
  // Decode the handful of HTML entities our renderers emit LAST — see the
  // doc-comment: real tags are already stripped, so this only turns
  // entity-encoded example text back into readable literal characters.
  // `&amp;` last to avoid double-decoding.
  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
  // Collapse 3+ blank lines and trim trailing whitespace per line.
  s = s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

/**
 * SIG-144: GitHub rejects an annotation (and the whole request with it)
 * when required fields are missing or nonsensical. Filter to the ones
 * that can anchor: a real path, finite positive line range with
 * end ≥ start, and a non-empty message. Out-of-range / file-deleted
 * cases that survive this still get caught by the per-annotation retry.
 */
export function isPostableAnnotation(a: CheckRunAnnotation): boolean {
  return (
    typeof a.path === "string" &&
    a.path.trim().length > 0 &&
    Number.isInteger(a.start_line) &&
    a.start_line >= 1 &&
    Number.isInteger(a.end_line) &&
    a.end_line >= a.start_line &&
    typeof a.message === "string" &&
    a.message.trim().length > 0
  )
}
