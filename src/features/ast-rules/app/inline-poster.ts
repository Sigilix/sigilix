// ARC-181: auto-inline poster for `error`-severity AST findings.
// Gated by `astRules.autoInline === true` (default `false`) per
// spec §3.4 cautious-rollout posture. The runner does NOT call
// this directly — the ensemble orchestrator decides when to invoke
// based on the resolved config.
//
// Each posted comment carries the hidden `<!-- ast/<id> -->` audit
// marker so re-review tooling can identify the deterministic
// supersession path (Kimi MINOR #5).

import type { GitHubClient } from "@/src/shared/adapters/github"
import type { SubmitReviewBody, SubmitReviewComment } from "@/src/shared/types/github"
import type { AstFinding } from "@/src/features/ast-rules/domain/types"

export interface PostAstInlineArgs {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  findings: readonly AstFinding[]
  perFindingPositions: Map<string, { line: number; side: "RIGHT" } | null>
}

export interface PostAstInlineResult {
  posted: number
  skippedNoReviewPosition: number
  skippedNonError: number
}

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function renderInlineBody(f: AstFinding): string {
  const lines: string[] = []
  lines.push(`<!-- ${f.astFindingId} -->`)
  lines.push(`**${f.ruleId}** (${f.severity})`)
  lines.push("")
  lines.push(f.message)
  lines.push("")
  lines.push("```")
  lines.push(f.evidence)
  lines.push("```")
  return lines.join("\n")
}

export async function postAstInlineFindings(
  args: PostAstInlineArgs,
): Promise<PostAstInlineResult> {
  const { client, owner, repo, prNumber, headSha, findings, perFindingPositions } = args
  const ctx = { owner, repo, prNumber }
  let posted = 0
  let skippedNoReviewPosition = 0
  let skippedNonError = 0

  // Track findings alongside comments so telemetry can read structured
  // fields (`ruleId`, `path`, `line`) directly off the finding object —
  // not by regex-parsing the rendered comment body, which would break
  // silently if `renderInlineBody` ever changes shape (sigilix-bot
  // self-review on PR #67).
  const comments: SubmitReviewComment[] = []
  const commentFindings: AstFinding[] = []
  for (const f of findings) {
    if (f.severity !== "error") {
      skippedNonError++
      continue
    }
    const pos = perFindingPositions.get(f.astFindingId) ?? null
    if (!pos) {
      skippedNoReviewPosition++
      continue
    }
    comments.push({
      path: f.path,
      line: pos.line,
      side: pos.side,
      body: renderInlineBody(f),
    })
    commentFindings.push(f)
  }

  if (comments.length === 0) {
    emit("ast-rules-auto-inline-summary", {
      ...ctx,
      posted: 0,
      skippedNoReviewPosition,
      skippedNonError,
    })
    return { posted: 0, skippedNoReviewPosition, skippedNonError }
  }

  const body: SubmitReviewBody = {
    event: "COMMENT",
    commit_id: headSha,
    comments,
  }
  try {
    await client.submitReview(owner, repo, prNumber, body)
    posted = comments.length
    for (const f of commentFindings) {
      emit("ast-rules-inline-posted", {
        ...ctx,
        ruleId: f.ruleId,
        path: f.path,
        line: f.line,
      })
    }
  } catch (err) {
    emit("ast-rules-auto-inline-failed", {
      ...ctx,
      err: err instanceof Error ? err.message : String(err),
      candidates: comments.length,
    })
    posted = 0
  }

  emit("ast-rules-auto-inline-summary", {
    ...ctx,
    posted,
    skippedNoReviewPosition,
    skippedNonError,
  })
  return { posted, skippedNoReviewPosition, skippedNonError }
}
