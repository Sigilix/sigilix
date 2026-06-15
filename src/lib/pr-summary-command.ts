// SIG-437: parse `@sigilix summary` out of a PR body.
//
// Unlike `parseSlashCommand` (`/sigilix <cmd>` in a COMMENT) and
// `parseDismissCommand` (`@sigilix dismiss` in a review thread), this matches
// the `@sigilix summary` one-liner an author drops in the PR BODY (the
// description). Recognition mirrors the mention/slash contract:
//
//   - Strip the existing managed summary block FIRST (Codex MUST-FIX #4): once
//     Sigilix has written the block, a `@sigilix summary` token the model
//     echoed INSIDE the generated description must NOT re-trigger us on the next
//     `edited` webhook (our own PATCH is itself an `edited` event). Only a real,
//     fresh, author-typed trigger OUTSIDE the block counts.
//   - Then strip markdown blockquotes + fenced/inline code (`stripQuotesAndCode`)
//     so a quoted or in-code `@sigilix summary` doesn't trigger.
//   - The trigger must be its OWN line (anchored), so `@sigilix summary` quoted
//     mid-sentence in prose doesn't count.
//   - Case-insensitive on the `@`-handle and the literal `summary`.
//   - Trigger handles come from `OPENCLAW_MENTION_TRIGGERS` (default sigilix),
//     same source as the reply path.
//
// Pure — no I/O, no env. Exported for tests + the webhook trigger gate.

import { getMentionTriggers, stripQuotesAndCode } from "./mention"
import { stripSummaryBlock, summaryTriggerRegex } from "./pr-summary-apply"

/**
 * Returns `{ kind: "summary" }` when the (cleaned) body contains a fresh,
 * author-typed `@sigilix summary` trigger line OUTSIDE any existing managed
 * block, else `null`.
 *
 * @param body         The raw PR body.
 * @param envTriggers  Raw `OPENCLAW_MENTION_TRIGGERS` (optional).
 */
export function parseSummaryCommand(body: string | null | undefined, envTriggers?: string): { kind: "summary" } | null {
  if (typeof body !== "string" || body.length === 0) return null
  // Re-trigger guard: drop the already-written managed block before looking for
  // a trigger, so an echoed marker inside our own generated text is invisible.
  const withoutBlock = stripSummaryBlock(body)
  const cleaned = stripQuotesAndCode(withoutBlock)
  if (cleaned.length === 0) return null
  const re = summaryTriggerRegex(getMentionTriggers(envTriggers))
  return re.test(cleaned) ? { kind: "summary" } : null
}
