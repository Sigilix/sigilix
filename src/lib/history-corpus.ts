// The `history:` corpus — a repo's own past as retrieval context.
//
// WHY: the model should understand a codebase from its HISTORY — commit messages
// and, above all, the humans' own PR review discussion ("we tried that, it broke
// X") — independent of whether the customer runs OUR PR reviewer. The PR-review
// tool is optional; the history is fuel either way. This is the doc-shaped sibling
// of the `pr:`/`issue:` multi-corpus namespaces: same Vectorize index, same
// embeddings, a new namespace prefix and `kind` values.
//
// Doc ids key on immutable GitHub identifiers (commit sha, comment id, review id),
// so re-ingesting is idempotent: an overwrite, never a duplicate. (An overwrite
// still PAYS the embed — idempotent ≠ free — which is why ingestion runs under the
// run-until-complete D1 lease in history-ingest-lease.ts, never unguarded.)

import { embedText } from "@/src/shared/adapters/model"
import type { MultiCorpusEnv } from "@/src/lib/multi-corpus"
// Name-keyed like `pr:`/`issue:` — a renamed repo is a new namespace on purpose.
// DEFINED in multi-corpus.ts (the read side) so write and read can never drift.
import { historyNamespace } from "@/src/lib/multi-corpus"

export { historyNamespace }

/** Dark by default. `on` enables producers AND consumers; anything else is off. */
export function historyCorpusEnabled(env: { SIGILIX_HISTORY_CORPUS?: string }): boolean {
  return env.SIGILIX_HISTORY_CORPUS === "on"
}

const MAX_EMBED_CHARS = 3_500

export type HistoryDocKind = "commit" | "review-comment" | "review"

export interface HistoryDoc {
  owner: string
  repo: string
  kind: HistoryDocKind
  /** Immutable GitHub id: commit sha / review-comment id / review id. */
  sourceId: string
  /** Where it points for a citation, e.g. "abc1234" or "#42 src/pay.ts". */
  ref: string
  /** The human text: commit message, review-comment body, review body. */
  text: string
  /** PR the doc came from, when applicable (commits arrive via merged PRs too). */
  prNumber?: number
}

/** `commit-<sha>` / `prrc-<id>` / `prrev-<id>` — immutable, so upserts overwrite. */
export function historyDocId(doc: Pick<HistoryDoc, "kind" | "sourceId">): string {
  const prefix = doc.kind === "commit" ? "commit" : doc.kind === "review-comment" ? "prrc" : "prrev"
  return `${prefix}-${doc.sourceId.toLowerCase()}`
}

/** Lead with what it IS (the retrieval-side header cites this), then the text. */
export function buildHistoryCorpusText(doc: HistoryDoc): string {
  const head =
    doc.kind === "commit"
      ? `Commit ${doc.ref}${doc.prNumber !== undefined ? ` (PR #${doc.prNumber})` : ""}`
      : doc.kind === "review-comment"
        ? `Review comment on ${doc.ref}`
        : `Review on ${doc.ref}`
  return `${head}:\n${doc.text.trim()}`.slice(0, MAX_EMBED_CHARS)
}

/** Skip docs with no human signal — embedding "Merge branch 'main'" is pure cost. */
export function isHistoryDocWorthEmbedding(doc: Pick<HistoryDoc, "text" | "kind">): boolean {
  const t = doc.text.trim()
  if (t.length < 12) return false
  if (doc.kind === "commit" && /^merge (branch|pull request|remote)/i.test(t)) return false
  return true
}

/**
 * Embed + upsert one history doc. Returns false (logs) on failure — the CALLER
 * decides what a failure means. For the leased backfill that means "do not advance
 * the cursor past this shard": a swallowed failure must never be recorded as
 * progress (the PR-backfill guard's found:300/upserted:0 lesson).
 */
export async function upsertHistoryDoc(env: MultiCorpusEnv, doc: HistoryDoc): Promise<boolean> {
  try {
    const text = buildHistoryCorpusText(doc)
    const values = await embedText(env.AI, text)
    await env.OPENCLAW_CODE_INDEX.upsert([
      {
        id: historyDocId(doc),
        values,
        namespace: historyNamespace(doc.owner, doc.repo),
        metadata: { kind: doc.kind, ref: doc.ref, content: text },
      },
    ])
    return true
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "history-corpus-upsert-failed",
        owner: doc.owner,
        repo: doc.repo,
        kind: doc.kind,
        sourceId: doc.sourceId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}
