// SIG-437: deterministic, no-network association for `@sigilix summary`.
//
// The generated summary links (a) related PRs — stacked/dependency, from the
// open-PR set via `detectStack` — and (b) the PR's Linear issue. Both are
// rendered by US (not the model) so the links are trustworthy, not
// hallucinated.
//
// Linear association is intentionally NO-API (Codex MUST-FIX #5): we extract a
// Linear issue key from the PR body's `Closes/Refs/Fixes <KEY-123>` (preferred —
// the author's explicit declaration) or, failing that, from the branch name
// (`sig-437-...` → `SIG-437`), then build the workspace URL deterministically.
// This avoids a `LINEAR_API_KEY` dependency on the webhook path and any network
// call. It is best-effort: no ref found → no Linear line (never a broken link).
//
// Pure — no I/O, no env. Exported for tests + the handler.

import type { StackContext } from "./pr-stack"
import { stripQuotesAndCode } from "./mention"

/** The Linear workspace this repo's issues live in. Issue URLs are
 *  `https://linear.app/sigilix/issue/<KEY-N>`; the trailing slug is optional —
 *  Linear redirects `/issue/SIG-437` to the canonical slugged URL. */
const LINEAR_WORKSPACE_BASE = "https://linear.app/sigilix/issue"

/** A Linear issue key: 2+ uppercase letters, a hyphen, digits (e.g. `SIG-437`).
 *  Used both for the body-ref scan and the branch-name fallback. */
const LINEAR_KEY = "[A-Z]{2,}-[0-9]+"

/** Body declaration: `Closes|Close|Closed|Fixes|Fix|Fixed|Resolves|Resolve|
 *  Resolved <KEY-N>` (case-insensitive on the keyword; the key itself is
 *  upper-cased on extraction). Mirrors the linked-issue keyword set in
 *  `pre-merge-gates.ts`. Capture group 1 is the key. */
const BODY_REF_RE = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s+(${LINEAR_KEY})`, "i")

/** Branch fallback: a branch like `sig-437-add-summary` → `SIG-437`. Restricted
 *  to this repo's Linear team key (`sig-`) and anchored at the start, so a
 *  non-Linear PR-number branch (`fix-123-...`) does NOT mislink to a 404'ing
 *  `FIX-123` issue (code-review P2). Capture group 1 is the lowercase key;
 *  upper-cased on extraction. */
const BRANCH_REF_RE = /^(sig-[0-9]+)\b/i

export interface LinearRef {
  /** The canonical upper-cased key, e.g. `SIG-437`. */
  id: string
  /** The deterministic workspace URL. */
  url: string
}

/**
 * Extract the PR's Linear issue ref, body-declaration first then branch-name
 * fallback (Codex MUST-FIX #5: body refs before branch fallback, uppercase
 * key). Returns `null` when neither yields a key — best-effort, never a guess.
 *
 * Pure — exported for tests.
 */
export function extractLinearIssueRef(
  prBody: string | null | undefined,
  branchName: string | null | undefined,
): LinearRef | null {
  // Strip code/quotes before the body scan so a `closes ABC-1` inside a fenced
  // block or a `> Closes …` quote isn't mistaken for the author's own
  // declaration (parity with `parseSummaryCommand`; code-review P2).
  const body = stripQuotesAndCode(typeof prBody === "string" ? prBody : "")
  const bodyMatch = body.match(BODY_REF_RE)
  if (bodyMatch?.[1]) return toRef(bodyMatch[1])

  const branch = typeof branchName === "string" ? branchName : ""
  const branchMatch = branch.match(BRANCH_REF_RE)
  if (branchMatch?.[1]) return toRef(branchMatch[1])

  return null
}

function toRef(rawKey: string): LinearRef {
  const id = rawKey.toUpperCase()
  return { id, url: `${LINEAR_WORKSPACE_BASE}/${id}` }
}

/** Escape markdown link-text so a PR title containing `]`/`[` can't break the
 *  rendered link. The URL halves we build are all from `[A-Z0-9-]`-safe keys +
 *  numeric PR numbers, so only the human-authored title needs escaping. */
function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, "\\$&")
}

export interface RenderAssociationsArgs {
  /** The detected stack context (parent/children). Soft: pass `null` when stack
   *  detection failed or was skipped — only Linear renders then. */
  stack: StackContext | null
  /** The extracted Linear ref, or null. */
  linear: LinearRef | null
}

/**
 * Render the "Related" markdown block appended below the generated description,
 * or `null` when there is nothing to relate (no stack parent/children AND no
 * Linear ref) — so the caller omits the heading entirely rather than printing an
 * empty section.
 *
 * Shape:
 *
 *   ## Related
 *
 *   - Linear: [SIG-437](https://linear.app/sigilix/issue/SIG-437)
 *   - Stacked on #87
 *   - Followed by #91, #92
 *
 * Pure — exported for tests.
 */
export function renderAssociations(args: RenderAssociationsArgs): string | null {
  const { stack, linear } = args
  const lines: string[] = []

  if (linear) {
    lines.push(`- Linear: [${linear.id}](${linear.url})`)
  }

  if (stack && stack.isStacked) {
    if (stack.parent) {
      lines.push(`- Stacked on #${stack.parent.number}`)
    }
    if (stack.children.length > 0) {
      const kids = stack.children.map((c) => `#${c.number}`).join(", ")
      lines.push(`- Followed by ${kids}`)
    }
  }

  if (lines.length === 0) return null
  return ["## Related", "", ...lines].join("\n")
}

export { escapeLinkText }
