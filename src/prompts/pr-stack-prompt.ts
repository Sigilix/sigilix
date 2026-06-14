// ARC-182: rendering layer for stack-aware review.
//
//   renderStackPromptBlock() → injected into the LLM context BEFORE
//     the diff so the model knows which findings should be tagged as
//     downstack-context vs current-pr vs upstack-followup.
//
// Pure rendering. No I/O. Stack detection lives in `src/lib/pr-stack.ts`.
//
// Spec: docs/superpowers/specs/2026-05-11-arc-182-stack-aware-review-design.md

import type { StackContext, FileOverlap } from "@/src/lib/pr-stack"

/**
 * ARC-182 (code-review I6 + PR #72 CR major): sanitize any
 * repo-controlled value before inlining into the LLM prompt block.
 * Applies to:
 *  - PR titles (author-controlled, multiline up to ~256 chars)
 *  - Filenames in shared-files lists (repo-controlled — a malicious
 *    contributor can rename a file to inject `\n[SYSTEM] override`)
 *
 * Defenses:
 *  - strip CR/LF so the value stays on one line
 *  - strip `[`, `]` so the value can't synthesize fake `[BLOCK]`
 *    markers in our own pseudo-Markdown prompt
 *  - strip `"` so the value can't break out of surrounding quotes
 *  - strip `` ` `` so the value can't open a code fence
 *  - cap at `maxLength` chars (default 120 for titles; pass 200 for
 *    filenames since long path/file names are legitimate)
 */
function sanitizeInlinePromptValue(raw: string, maxLength = 120): string {
  const stripped = (raw || "")
    .replace(/[\r\n"`\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (stripped.length <= maxLength) return stripped
  return stripped.slice(0, maxLength - 1) + "…"
}

/**
 * Render the per-PR stack context block injected into the LLM prompt
 * BEFORE the diff. Returns empty string when the PR is not stacked so
 * the caller can concatenate safely.
 *
 * Format is plain-text, no Markdown — the model treats it as context.
 */
export function renderStackPromptBlock(ctx: StackContext, overlap?: FileOverlap): string {
  if (!ctx.isStacked) return ""

  const lines: string[] = []
  lines.push("[STACK CONTEXT]")
  // CodeRabbit PR #72 minor: depth is a lower bound when the upstack
  // forks (we only walk the primary child chain). Render "at least Y"
  // so the model + reviewer aren't told an inflated certainty.
  const depthCopy = ctx.hasUpstackFork ? `at least ${ctx.depth}` : `${ctx.depth}`
  lines.push(`This PR is position ${ctx.position} of ${depthCopy} in a Graphite-style stack.`)

  if (ctx.parent) {
    const authorTag = ctx.parent.author ? ` by @${ctx.parent.author}` : ""
    lines.push(
      `- Parent (downstack): #${ctx.parent.number} "${sanitizeInlinePromptValue(ctx.parent.title)}"${authorTag}`,
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
    const childList = ctx.children.map((c) => `#${c.number} "${sanitizeInlinePromptValue(c.title)}"`).join(", ")
    lines.push(`- Children (upstack): ${childList}`)
  } else {
    lines.push("- Children: none (this PR is the top of the stack)")
  }

  if (ctx.root && ctx.root.number !== ctx.parent?.number) {
    lines.push(`- Stack root: #${ctx.root.number} "${sanitizeInlinePromptValue(ctx.root.title)}"`)
  }

  if (overlap && (overlap.sharedCount > 0 || overlap.parentOnlyCount > 0)) {
    const total = overlap.sharedCount + overlap.currentOnlyCount
    const shareFraction = total > 0 ? `${overlap.sharedCount} of ${total}` : "0 of 0"
    lines.push(`- File overlap with parent: ${shareFraction} changed files shared with parent`)
    if (overlap.sharedFiles.length > 0) {
      // CodeRabbit PR #72 major: filenames are repo-controlled and
      // can contain newlines / brackets / quotes that would break
      // out of the [STACK CONTEXT] block. Sanitize each, allowing a
      // longer cap (200) since legitimate file paths can be long.
      lines.push(
        `  Shared files: ${overlap.sharedFiles.map((file) => sanitizeInlinePromptValue(file, 200)).join(", ")}`,
      )
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
