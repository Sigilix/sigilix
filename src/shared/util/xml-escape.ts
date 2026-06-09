// XML-like escaping for prompt interpolation. The downstream consumer is
// an LLM, not a strict XML parser — but the escape rules still matter:
// PR-controlled text containing `</pr_context>` (or any closing tag) would
// otherwise visually break the structural delimiters the prompt uses to
// fence user content off from system instructions.

/**
 * Escape user-controlled text for safe XML-like text-node interpolation.
 * Replaces &, <, and > so embedded closing tags such as </pr_context>
 * and CDATA terminators such as ]]> remain inert user data — `>` becomes
 * `&gt;`, so `]]>` becomes `]]&gt;` without needing a separate rule.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Escape user-controlled text for safe XML-like attribute interpolation.
 * Adds `"` escaping on top of `escapeXmlText` so a value cannot close the
 * attribute and inject siblings (e.g. `state="merged" injected="yes"`).
 */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;")
}
