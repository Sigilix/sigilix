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
      `- Parent (downstack): #${ctx.parent.number} "${ctx.parent.title}"${authorTag}`,
    )
  } else {
    lines.push("- Parent: none (this PR is the stack root)")
  }

  if (ctx.children.length > 0) {
    const childList = ctx.children
      .map((c) => `#${c.number} "${c.title}"`)
      .join(", ")
    lines.push(`- Children (upstack): ${childList}`)
  } else {
    lines.push("- Children: none (this PR is the top of the stack)")
  }

  if (ctx.root && ctx.root.number !== ctx.parent?.number) {
    lines.push(`- Stack root: #${ctx.root.number} "${ctx.root.title}"`)
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
