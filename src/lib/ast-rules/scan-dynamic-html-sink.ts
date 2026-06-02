// SIG-312: deterministic detector for an UNTRUSTED dynamic value flowing into an
// HTML-injection sink (React `dangerouslySetInnerHTML`, DOM `innerHTML` /
// `outerHTML` / `insertAdjacentHTML`) — the recurring XSS the LLM security
// specialist intermittently MISSES. It dropped `dangerouslySetInnerHTML={{
// __html: c.bodyHtml }}` at PROMPT_VERSION 14 AND again at 17, while CodeRabbit
// and Greptile both caught it. This is the deterministic safety net.
//
// Why a line-scan and not an AST rule: `dangerouslySetInnerHTML` is a JSX
// attribute, and our walker does NOT traverse JSX nodes (it no-ops them), so a
// rule's visitor can never reach it. So we regex the source lines, reusing the
// SIG-292 HTML-write sink extractors (`HTML_WRITE_SINK_EXTRACTORS`) as the
// single source of truth for the sink SYNTAX — the inverse of SIG-292, which
// DEMOTES a constant-fed sink; this one FLAGS a dynamic-fed sink.
//
// FP-safe by construction (north-star = ZERO P0/P1 false positives). It flags
// ONLY the two value shapes that are inherently untrusted-dynamic AND can't be
// a sanitizer:
//   1. a MEMBER ACCESS whose terminal property is HTML-ish/risky (`bodyHtml`,
//      `rawHtml`, `markup`, …) and NOT a safe-marker — the recurring miss; and
//   2. a RAW interpolated template (`` `…${x}…` ``) with NO call inside.
// Everything else is SKIPPED: string/template literals (constant), bare
// identifiers (could be pre-sanitized), safe-marked values (`safeHtml`,
// `DOMPurify.sanitize(x)`), and ANY call (any call could be an unrecognized
// sanitizer — we skip them all: FN over FP).
//
// Design reviewed by Codex (gpt-5.5) + DeepSeek-v4-pro; both independently
// converged on this exact line: "flag member-access (HTML-ish, not safe-named)
// + raw interpolation; skip constants, bare identifiers, and all calls; use a
// line-scan, not a walker/JSX change (broader blast radius, not needed)."

import { HTML_WRITE_SINK_EXTRACTORS } from "../validate-injection-taint"
import type { AstRuleHit } from "./types"

export const DYNAMIC_HTML_SINK_RULE_ID = "no-dangerous-html-dynamic"

/** A safe-marker TOKEN in the value PROVES intentional sanitization
 *  (`safeHtml`, `sanitizedHtml`, `trustedHtml`, `DOMPurify.sanitize(x)`,
 *  `escapeHtml(x)`) → never flag. This single guard subsumes both the
 *  safe-named-member and the sanitizer-call cases.
 *
 *  Anchored to a token boundary (start, or a non-letter before the marker) so
 *  `unSAFEHtml` / `unCLEANHtml` — the literally-UNSAFE fields — are NOT
 *  swallowed as "safe" (CodeRabbit #296: a raw substring match dropped exactly
 *  the dynamic sink we must catch). With the `i` flag, `[^a-z]` is "not a
 *  letter (any case)", so `c.unsafeHtml` (marker preceded by `n`) does NOT
 *  match while `c.safeHtml` / `DOMPurify.sanitize` (preceded by `.`) do. */
const SAFE_MARKER_RE = /(?:^|[^a-z])(?:safe|saniti|trusted|clean|escap|purif)/i

/** Terminal property of a member access (the part after the last `.` / `?.`). */
function terminalProperty(memberExpr: string): string {
  const parts = memberExpr.split(/[.?]/).filter((p) => p.trim().length > 0)
  return (parts.length > 0 ? parts[parts.length - 1]! : memberExpr).trim()
}

/** Terminal property "screams raw HTML": contains `html` or is `markup`. We
 *  require an HTML-ish NAME (rather than flagging every member access) so a
 *  generic `c.id` is skipped — FN over FP. */
function isRiskyHtmlProperty(prop: string): boolean {
  return /html/i.test(prop) || /^markup$/i.test(prop)
}

/** Any function call: `f(x)`, `a.b(x)`, `DOMPurify.sanitize(x)`. A `(` directly
 *  after an identifier / `)` / `]`. */
function containsCall(expr: string): boolean {
  return /[\w$)\]]\s*\(/.test(expr)
}

/** Member access: `a.b`, `a.b.c`, `a?.b` — at least one property step, no call.
 *  (Calls are excluded earlier; this is purely the value SHAPE.) */
function isMemberAccess(expr: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)+$/.test(expr.trim())
}

/** Raw interpolated template literal with at least one `${…}`. */
function isInterpolatedTemplate(expr: string): boolean {
  const v = expr.trim()
  return v.startsWith("`") && v.endsWith("`") && v.includes("${")
}

export type HtmlSinkVerdict =
  | { flag: false }
  | { flag: true; reason: "member" | "interpolation" }

/**
 * Classify the value expression flowing into an HTML sink. Pure; the ordering
 * of guards is the FP-safety contract:
 *   safe-marker → skip; any call → skip; HTML-ish member → FLAG; raw
 *   interpolation → FLAG; everything else (literals, bare identifiers, non-HTML
 *   members) → skip.
 */
export function classifyHtmlSinkValue(rawValue: string): HtmlSinkVerdict {
  const value = rawValue.trim()
  if (value.length === 0) return { flag: false }
  // safe-marked (safeHtml / DOMPurify.sanitize / escapeHtml) → provably benign.
  if (SAFE_MARKER_RE.test(value)) return { flag: false }
  // any call could be an unrecognized sanitizer → skip (FN over FP).
  if (containsCall(value)) return { flag: false }
  // member access with an HTML-ish risky terminal property → the recurring XSS.
  if (isMemberAccess(value) && isRiskyHtmlProperty(terminalProperty(value))) {
    return { flag: true, reason: "member" }
  }
  // raw interpolated template (calls already returned above).
  if (isInterpolatedTemplate(value)) return { flag: true, reason: "interpolation" }
  // literals, bare identifiers, non-HTML members → skip.
  return { flag: false }
}

/** Cap an expression embedded in the human-facing message. */
function clip(expr: string, max = 80): string {
  const v = expr.trim()
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function dynamicHtmlSinkMessage(value: string, reason: "member" | "interpolation"): string {
  const shape =
    reason === "member"
      ? `the \`__html\` value \`${clip(value)}\` is a non-constant member access`
      : `the \`__html\` value is an interpolated template`
  // Deliberately HEDGED / advisory (P2): a deterministic line-scan can't prove
  // whether the value is attacker-influenced vs a trusted constant/i18n table,
  // so this SURFACES the sink for review rather than asserting an XSS. When the
  // model's security specialist judges the value untrusted it raises its OWN
  // P0/P1 (which supersedes this), so no recall is lost on a real XSS.
  return (
    `Dynamic value rendered as raw HTML via an HTML-injection sink — verify it is sanitized before render. ` +
    `${shape} passed to \`dangerouslySetInnerHTML\` / \`innerHTML\`; ` +
    `if it can carry attacker-controlled markup (not a trusted constant or sanitizer output) this is a stored/reflected XSS. ` +
    `Confirm the source is trusted, or wrap it in a sanitizer (e.g. \`DOMPurify.sanitize(...)\`) / render it as text.`
  )
}

/**
 * Scan a source file for an HTML-injection sink fed a non-constant dynamic
 * value. Scans the FULL source (not line-by-line) with global+multiline clones
 * of the shared extractors so a pretty-printed multi-line `dangerouslySetInner
 * HTML={{ … }}` is caught too (CodeRabbit #296) — the match offset is mapped
 * back to a 1-based line number (+ endLine when the match spans lines). The
 * shared single-line regexes are untouched; the `m` flag only makes the
 * `innerHTML` `$` mean end-of-LINE for the full-source scan. Returns raw hits
 * (the runner filters by changed-lines, assigns the finding id, and wraps them
 * as `warning`/`security`/`emitWhenUnmatched` advisories). Pure.
 */
export function scanDynamicHtmlSinks(source: string): AstRuleHit[] {
  const hits: AstRuleHit[] = []
  const seenStartLine = new Set<number>()
  for (const baseRe of HTML_WRITE_SINK_EXTRACTORS) {
    const re = new RegExp(baseRe.source, "gm")
    for (const m of source.matchAll(re)) {
      const value = (m[1] ?? "").trim()
      const verdict = classifyHtmlSinkValue(value)
      if (!verdict.flag) continue
      const idx = m.index ?? 0
      const startLine = source.slice(0, idx).split("\n").length
      if (seenStartLine.has(startLine)) continue
      const newlinesInMatch = (m[0].match(/\n/g) ?? []).length
      const lineStartIdx = source.lastIndexOf("\n", idx - 1) + 1
      // Skip a line-commented sink (CodeRabbit #296): if a `//` opens before the
      // sink on its line, it's commented-out code, not a live sink.
      if (source.slice(lineStartIdx, idx).includes("//")) continue
      seenStartLine.add(startLine)
      hits.push({
        message: dynamicHtmlSinkMessage(value, verdict.reason),
        evidence: m[0].replace(/\s+/g, " ").trim().slice(0, 200),
        line: startLine,
        ...(newlinesInMatch > 0 ? { endLine: startLine + newlinesInMatch } : {}),
        column: Math.max(0, idx - lineStartIdx),
      })
    }
  }
  return hits
}
