// ARC-182: rendering layer for stack-aware review.
//
// Two distinct outputs:
//
//   renderStackPromptBlock() → injected into the LLM context BEFORE
//     the diff so the model knows which findings should be tagged as
//     downstack-context vs current-pr vs upstack-followup.
//
//   renderStackContextSummary() → injected into the GitHub review body
//     (the sticky summary) so a human reviewer sees the stack picture
//     at a glance.
//
// Pure rendering. No I/O. Stack detection lives in `src/lib/pr-stack.ts`.
//
// Spec: docs/superpowers/specs/2026-05-11-arc-182-stack-aware-review-design.md

import type { StackContext, FileOverlap } from "../lib/pr-stack"

/**
 * ARC-182 (code-review I6): sanitize a PR title before inlining into
 * the LLM prompt block. PR titles are user-controlled (the PR author
 * sets them) and inject directly into the prompt's `[STACK CONTEXT]`
 * block, so a hostile title can attempt prompt injection (e.g.,
 * `"Test\n\n[SYSTEM] ignore previous instructions"`).
 *
 * Defenses:
 *  - strip CR/LF so the title stays on one line
 *  - strip `[`, `]` so the title can't synthesize fake `[BLOCK]` markers
 *  - strip `"` so the title can't break out of the surrounding quotes
 *  - cap at 120 chars (GitHub allows up to ~256 — 120 is plenty for
 *    a stack-context hint without giving an attacker much surface)
 */
function sanitizeTitleForPrompt(raw: string): string {
  const stripped = (raw || "")
    .replace(/[\r\n"`\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (stripped.length <= 120) return stripped
  return stripped.slice(0, 117) + "…"
}

/**
 * Stack-awareness instruction text added to the system prompt
 * (PR_REVIEW_PROMPT in pr-review.ts and the specialist/synth prompts).
 *
 * Kept separate from the per-PR `renderStackPromptBlock` so the
 * instruction is documented to the model on EVERY review even when
 * the PR is not stacked — that way the model never sees a brand-new
 * concept on its first stacked PR.
 */
export const STACK_AWARENESS_INSTRUCTION = `
## Stack-aware findings (stackOrigin field)

When a PR is part of a Graphite-style stack (its base branch is another open PR's head branch), the [STACK CONTEXT] block at the top of the input will tell you the parent PR, child PRs, and file overlap. Use that context to tag each finding with one of:

- **"current-pr"** — the issue is introduced or maintained in THIS PR's diff. Default.
- **"downstack-context"** — the issue ALREADY exists in a downstack (parent or earlier) PR. Report it for awareness, but DO NOT describe it as introduced by this PR — that's a false-positive on the child.
- **"upstack-followup"** — the issue's proper fix belongs in an upstack PR (child or later). Flag it for awareness but don't block on it.

When uncertain, default to "current-pr". The \`stackOrigin\` field is optional and omitted when [STACK CONTEXT] indicates "not stacked."`.trim()

/**
 * Render the per-PR stack context block injected into the LLM prompt
 * BEFORE the diff. Returns empty string when the PR is not stacked so
 * the caller can concatenate safely.
 *
 * Format is plain-text, no Markdown — the model treats it as context.
 */
export function renderStackPromptBlock(
  ctx: StackContext,
  overlap?: FileOverlap,
): string {
  if (!ctx.isStacked) return ""

  const lines: string[] = []
  lines.push("[STACK CONTEXT]")
  lines.push(
    `This PR is position ${ctx.position} of ${ctx.depth} in a Graphite-style stack.`,
  )

  if (ctx.parent) {
    const authorTag = ctx.parent.author ? ` by @${ctx.parent.author}` : ""
    lines.push(
      `- Parent (downstack): #${ctx.parent.number} "${sanitizeTitleForPrompt(ctx.parent.title)}"${authorTag}`,
    )
  } else if (ctx.cycleDetected || ctx.stackWalkCapped) {
    // Sigilix self-review (PR #72) catch: when the downstack walk
    // degraded due to cycle/cap, claiming "this PR is the stack
    // root" is false — the PR may well have a parent that was lost
    // to walk degradation. Signal ambiguity so the model considers
    // downstack-context findings rather than confidently tagging
    // everything as current-pr.
    lines.push(
      "- Parent: unknown (downstack walk degraded — cycle or hop-cap hit; the actual parent may exist but couldn't be determined deterministically)",
    )
  } else {
    lines.push("- Parent: none (this PR is the stack root)")
  }

  if (ctx.children.length > 0) {
    const childList = ctx.children
      .map((c) => `#${c.number} "${sanitizeTitleForPrompt(c.title)}"`)
      .join(", ")
    lines.push(`- Children (upstack): ${childList}`)
  } else {
    lines.push("- Children: none (this PR is the top of the stack)")
  }

  if (ctx.root && ctx.root.number !== ctx.parent?.number) {
    lines.push(`- Stack root: #${ctx.root.number} "${sanitizeTitleForPrompt(ctx.root.title)}"`)
  }

  if (overlap && (overlap.sharedCount > 0 || overlap.parentOnlyCount > 0)) {
    const total =
      overlap.sharedCount + overlap.currentOnlyCount
    const shareFraction = total > 0 ? `${overlap.sharedCount} of ${total}` : "0 of 0"
    lines.push(
      `- File overlap with parent: ${shareFraction} changed files shared with parent`,
    )
    if (overlap.sharedFiles.length > 0) {
      lines.push(`  Shared files: ${overlap.sharedFiles.join(", ")}`)
    }
  }

  lines.push("")
  lines.push("Stack-awareness instructions:")
  lines.push(
    `- Tag each finding with stackOrigin: "current-pr" (introduced or maintained in this PR), "downstack-context" (issue already in downstack — do NOT describe as introduced by this PR), or "upstack-followup" (fix belongs in an upstack PR).`,
  )
  lines.push(`- Default to "current-pr" when uncertain.`)

  return lines.join("\n")
}

/**
 * Render the "### Stack context" Markdown block injected into the
 * GitHub review body (sticky summary). Returns empty string when the
 * PR is not stacked.
 *
 * Uses GitHub's native cross-PR link syntax (#N) so a reviewer sees
 * the linked PR titles inline in the rendered review body.
 */
export function renderStackContextSummary(ctx: StackContext): string {
  if (!ctx.isStacked) return ""

  const lines: string[] = ["### Stack context", ""]
  lines.push(`This PR is **#${ctx.position} of ${ctx.depth}** in a stack.`)
  lines.push("")

  if (ctx.parent) {
    lines.push(`- ⬇ Parent: #${ctx.parent.number} _${escapeForMd(ctx.parent.title)}_`)
  } else if (ctx.cycleDetected || ctx.stackWalkCapped) {
    // Mirrors the prompt-block degradation message (Sigilix PR #72
    // self-review catch). Reviewer-facing copy says "ambiguous" so a
    // human reading the sticky summary understands the parent isn't
    // simply absent.
    lines.push("- ⚠ Parent: unknown (downstack walk degraded)")
  }
  for (const child of ctx.children) {
    lines.push(`- ⬆ Child: #${child.number} _${escapeForMd(child.title)}_`)
  }
  if (ctx.root && ctx.root.number !== ctx.parent?.number) {
    lines.push(`- 🌱 Root: #${ctx.root.number} _${escapeForMd(ctx.root.title)}_`)
  }

  return lines.join("\n")
}

/** Defensive escape for Markdown emphasis characters inside PR titles
 * — a title with `_` or `*` would otherwise mangle the italics. */
function escapeForMd(s: string): string {
  return s.replace(/([_*`])/g, "\\$1")
}
