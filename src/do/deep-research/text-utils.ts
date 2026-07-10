// SIG-298 — pure text helpers for the research engine. All original to this
// repo (NOT adapted from Tongyi DeepResearch): `stripThinking` and
// `isLowQuality` are written fresh from their functional specs, and the HTML
// stripper is a deliberately lightweight state-machine so the Worker pulls in
// no heavy HTML-parsing dependency.

/**
 * Remove model reasoning/thinking spans from a completion before it is shown or
 * parsed. Strips paired `<think>…</think>` / `<thinking>…</thinking>` /
 * `<reasoning>…</reasoning>` blocks (case-insensitive, across newlines). A lone
 * unmatched OPENING tag (a truncated stream) drops everything from that tag to
 * the end — reasoning must never leak. A lone CLOSING tag with no opener drops
 * everything before it (the opener was cut off upstream). Whitespace is
 * trimmed. Never throws.
 */
// sig-deep-research-repo-grounding — phrases that signal the caller is asking
// about THEIR OWN connected repository rather than a general/external engineering
// question. It REQUIRES an ownership cue (our/my/this/the + a repo-ish noun, or
// "in our/the code…") so a general design question like "which service should we
// use for queues?" or "where should rate limiting be implemented?" is NOT
// misrouted into repo grounding. A false negative is cheap: when the caller has a
// connected repo the web loop still folds in (soft-failing) repo grounding as
// augmentation; when they don't, it correctly runs web research. Kept in the pure
// text-utils leaf so the engine imports no heavy retrieval deps.
const CODEBASE_PATTERNS: RegExp[] = [
  // "our/my/this repo | repository | codebase | project | app | service | backend | …"
  /\b(our|my|this)\s+(repo|repository|code\s?base|project|app|service|backend|frontend|monorepo)\b/i,
  // "in our/my/this/the code | codebase | repo | repository | project"
  /\bin\s+(our|my|this|the)\s+(code|code\s?base|repo|repository|project)\b/i,
  // "the repo | repository | codebase" — product-contextual: refers to the user's own
  /\bthe\s+(repo|repository|code\s?base)\b/i,
  // An explicit "owner/repo" slug after a locating preposition — the caller named a
  // specific repository ("in sigilix/sigilix", "within acme/api"). A strong,
  // unambiguous codebase signal the possessive patterns above miss (the broken-moat
  // repro: "in sigilix/sigilix, what other repos does it use" was going un-grounded).
  /\b(?:in|within|inside|for|from|of)\s+[a-z0-9][\w.-]{0,38}\/[a-z0-9][\w.-]{0,99}\b/i,
  // "does it | this | the repo … use | depend on | import | contain | call …" — a
  // question about what an EXISTING thing (the caller's code) uses. Deliberately
  // scoped to "does it/this/the repo …" so a GENERAL design question ("which service
  // should we use for queues?") is NOT misrouted into grounding, per the note above.
  /\bdoes\s+(?:it|this|that|the\s+(?:repo|repository|code\s?base|project|app|service))\s+(?:use|uses|depend|import|contain|include|have|call|need|require)/i,
]

// A narrow implicit implementation-location shape for code questions that do not
// repeat "our repo" on every turn. Keep both halves conjunctive: descriptive
// location grammar + a code-specific target + a small implementation-verb set.
// Advisory/modal questions remain web/conversational questions.
const IMPLICIT_CODE_LOCATION =
  /\bwhere\s+(?:does|do|is|are)\b(?=[^?]{0,160}\b(?:rate[- ]limit|quota|cap|function|method|class|module|file|route|handler|middleware|constant|config|auth|token|indexer|indexing|queue|webhook|cache|database|table)\b)[^?]{0,160}\b(?:get\s+)?(?:computed|defined|implemented|resolved)\b/i
const ADVISORY_CUE = /\b(?:should|could|would|best|recommend(?:ed|ation)?)\b/i
const EXTERNAL_REFERENCE_CUE =
  /\b(?:in|inside|on|for|from|of|by)\s+(?:the\s+)?(?:[\w.-]+\s+){0,3}(?:api|sdk|service|platform|library|framework|package|docs?|documentation)\b/i

/**
 * Whether a question is asking about the caller's own codebase (so repo grounding
 * should take priority, and a missing indexed repo should prompt them to connect
 * one instead of getting a generic answer). Pure; never throws.
 */
export function isCodebaseQuestion(question: string): boolean {
  const q = question.trim()
  if (!q) return false
  if (CODEBASE_PATTERNS.some((re) => re.test(q))) return true
  if (ADVISORY_CUE.test(q) || EXTERNAL_REFERENCE_CUE.test(q)) return false
  return IMPLICIT_CODE_LOCATION.test(q)
}

// sig-chat-conversational-mode — greeting / small-talk / acknowledgement messages
// that must get a short, direct reply instead of kicking off a web-research run
// (the "hey!" → 23s SearXNG essay bug). Matched after lowercasing, stripping
// punctuation/emoji, and collapsing whitespace, so "Hey!!" and "hey" both hit.
// Deliberately CONSERVATIVE: only WHOLE-message chit-chat matches — a real question
// that merely opens with a greeting ("hey, where does auth live?") carries extra
// content and is NOT trivial, so it still routes to grounding / research.
const TRIVIAL_MESSAGES = new Set<string>([
  // greetings
  "hi",
  "hey",
  "hello",
  "heya",
  "hiya",
  "yo",
  "sup",
  "wassup",
  "wasup",
  "whats up",
  "howdy",
  "hola",
  "greetings",
  "hey there",
  "hi there",
  "hello there",
  "hey sigilix",
  "hi sigilix",
  "hello sigilix",
  "good morning",
  "good afternoon",
  "good evening",
  "good night",
  "morning",
  "gm",
  "gn",
  // small talk
  "how are you",
  "how are you doing",
  "hows it going",
  "how is it going",
  "how goes it",
  "whats new",
  "you there",
  "are you there",
  "anyone there",
  "hello world",
  // thanks
  "thanks",
  "thank you",
  "thanks so much",
  "thank you so much",
  "thanks a lot",
  "thanks a ton",
  "many thanks",
  "thx",
  "ty",
  "tysm",
  "cheers",
  "much appreciated",
  "appreciate it",
  "thanks sigilix",
  // acknowledgements
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "nice",
  "great",
  "awesome",
  "perfect",
  "sweet",
  "gotcha",
  "got it",
  "sounds good",
  "makes sense",
  "understood",
  "noted",
  "good to know",
  "fair enough",
  "no problem",
  "np",
  "youre welcome",
  "yw",
  "roger",
  // reactions
  "lol",
  "lmao",
  "haha",
  "hahaha",
  "hehe",
  "nice one",
  "amazing",
  "wow",
  // farewells
  "bye",
  "goodbye",
  "see you",
  "see ya",
  "cya",
  "later",
  "take care",
  "talk soon",
  // connectivity check
  "ping",
])

/**
 * Whether a message is a greeting / acknowledgement / small-talk utterance that
 * should get a short, direct conversational reply rather than a full web-research
 * run — even when Deep Research is on. Pure; never throws. Conservative on purpose:
 * only whole-message chit-chat matches, so a real question that merely starts with
 * "hey" is not short-circuited.
 */
export function isTrivialMessage(question: string): boolean {
  const norm = question
    .toLowerCase()
    .replace(/['\u2019`]/g, "") // drop apostrophes so "what's" → "whats"
    .replace(/[^a-z0-9\s]/g, " ") // drop remaining punctuation, emoji, symbols
    .replace(/\s+/g, " ")
    .trim()
  if (!norm) {
    // Empty only because we stripped latin punctuation/emoji. A message that still
    // holds letters/numbers in ANOTHER script (e.g. CJK) is a real question, not
    // trivial; pure emoji/punctuation ("👋", "!!!") IS trivial small-talk.
    return !/[\p{L}\p{N}]/u.test(question)
  }
  return TRIVIAL_MESSAGES.has(norm)
}

export function stripThinking(raw: string): string {
  if (!raw) return ""
  const tags = ["think", "thinking", "reasoning"]
  let out = raw
  for (const tag of tags) {
    // Paired blocks.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "")
    // Unmatched opener → drop to end.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "")
    // Unmatched closer → drop from start.
    out = out.replace(new RegExp(`^[\\s\\S]*?</${tag}>`, "gi"), "")
  }
  return out.trim()
}

/** Words that signal a model produced nothing usable this round. */
const JUNK_MARKERS = [
  "no relevant information",
  "no useful information",
  "nothing relevant",
  "could not find",
  "couldn't find",
  "no results",
  "not found",
  "n/a",
  "none found",
  "no data",
  "i don't know",
  "i do not know",
  "unable to find",
]

/**
 * Heuristic: does this text carry so little information it should count as an
 * empty/low-quality round? True when the text is empty, too short to hold a
 * fact, made entirely of junk/boilerplate markers, or has almost no unique
 * word content (a repeated-token wall). Conservative on purpose — a false
 * "low quality" only costs one round toward the empty-round kill, and the
 * `minRounds` floor still protects against stopping too early.
 */
export function isLowQuality(text: string): boolean {
  const trimmed = (text ?? "").trim()
  if (trimmed.length < 40) return true

  const lower = trimmed.toLowerCase()
  // Strip junk markers; if what remains is tiny, it was all boilerplate.
  let stripped = lower
  for (const marker of JUNK_MARKERS) stripped = stripped.split(marker).join(" ")
  if (stripped.replace(/[^a-z0-9]+/g, "").length < 24) return true

  // Low lexical diversity → a repeated-token wall carries little information.
  const words = lower.match(/[a-z0-9]+/g) ?? []
  if (words.length < 8) return true
  const unique = new Set(words)
  if (unique.size / words.length < 0.25) return true

  return false
}

/** Elements whose ENTIRE subtree (content included) is dropped — their inner
 *  text is never page content. */
const DROPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "head"]

/** Named entities common enough to be worth decoding after tag removal. */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
}

/**
 * Strip HTML to readable plain text with a lightweight regex/state-machine
 * approach — no DOM, no parser dependency. Drops entire `<script>/<style>/…`
 * subtrees (content and all), removes remaining tags, decodes a small set of
 * common entities + numeric references, and collapses whitespace. Deterministic
 * and total; malformed HTML degrades to best-effort text rather than throwing.
 */
export function htmlToText(html: string): string {
  if (!html) return ""
  let out = html

  // Remove whole subtrees whose text is never content.
  for (const el of DROPPED_ELEMENTS) {
    out = out.replace(new RegExp(`<${el}\\b[^>]*>[\\s\\S]*?</${el}>`, "gi"), " ")
    // Unclosed variant (truncated body) — drop to end of the element open.
    out = out.replace(new RegExp(`<${el}\\b[^>]*>`, "gi"), " ")
  }

  // HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, " ")
  // Turn block-ish boundaries into newlines so text doesn't run together.
  out = out.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br|header|footer)\s*>/gi, "\n")
  out = out.replace(/<br\s*\/?>/gi, "\n")
  // Remove all remaining tags.
  out = out.replace(/<[^>]+>/g, " ")

  // Decode named entities.
  for (const [entity, value] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(value)
  }
  // Decode decimal + hex numeric references.
  out = out.replace(/&#(\d+);/g, (_m, code: string) => safeFromCodePoint(Number.parseInt(code, 10)))
  out = out.replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, code: string) => safeFromCodePoint(Number.parseInt(code, 16)))

  // Collapse whitespace: trim each line, drop blank runs.
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim()
}

/** Guard `String.fromCodePoint` against NaN / out-of-range references. */
function safeFromCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ""
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

/** Extract a page `<title>` (decoded, whitespace-collapsed) or "" if absent. */
export function extractTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match || !match[1]) return ""
  return htmlToText(match[1]).replace(/\s+/g, " ").trim()
}

/** Hard character cap with an ellipsis marker; used to bound model inputs. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n…[truncated]"
}
