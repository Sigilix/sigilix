// Webhook-side producers for history-corpus ingestion. Extracted from
// index-github-webhook.ts (which sits at its file-size budget) so each hook site
// costs the webhook a couple of lines.
//
// Both are flag-gated here AND re-checked in the consumer (the flag is the dark
// switch; the D1 lease is what makes a duplicate/redelivered backfill enqueue
// harmless — the producers are deliberately NOT deduplicating, per the
// PR-backfill-guard lesson that producer-side gating never covers every path).
// Fail-soft: an enqueue failure logs and never blocks the webhook ack.

import type { Env } from "@/src/shared/types/env"
import { historyCorpusEnabled } from "@/src/lib/history-corpus"

/** On install / repos-added: kick the one-time leased backfill for each repo. */
export async function enqueueHistoryBackfills(
  env: Env,
  repositories: ReadonlyArray<{ full_name?: unknown }>,
  installationId: number,
): Promise<void> {
  if (!historyCorpusEnabled(env)) return
  for (const r of repositories) {
    const fullName = typeof r?.full_name === "string" ? r.full_name : ""
    const [owner, repo] = fullName.split("/")
    if (!owner || !repo) continue
    try {
      await env.OPENCLAW_JOBS.send({ type: "history-ingest", op: "backfill", owner, repo, installationId })
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "history-backfill-enqueue-failed",
          owner,
          repo,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
}

/** On merged PR: the cheap incremental upsert of that PR's history docs. */
export async function enqueueHistoryPrUpsert(
  env: Env,
  args: { owner: string; repo: string; prNumber: number; installationId: number },
): Promise<void> {
  if (!historyCorpusEnabled(env)) return
  try {
    await env.OPENCLAW_JOBS.send({
      type: "history-ingest",
      op: "pr-upsert",
      owner: args.owner,
      repo: args.repo,
      installationId: args.installationId,
      prNumber: args.prNumber,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "history-pr-upsert-enqueue-failed",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
