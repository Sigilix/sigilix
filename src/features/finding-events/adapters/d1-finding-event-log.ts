// SIG-606 — finding event log append adapter.
//
// Appends one APPEND-ONLY row per candidate finding (posted AND suppressed). Schema
// DDL is owned by migration 0037 — no ensureSchema here.
//
// FAIL-SOFT BY DESIGN: a missing binding or any D1 error logs a warn and returns.
// This is instrumentation; it must NEVER fail or block the review it is measuring.
// Mirrors appendUsageEvent (src/features/tenancy/adapters/d1-usage-events.ts).
//
// INSERT only — never UPDATE. Outcomes are appended as new rows; mutating one would
// destroy the timeline (see the migration header).

import type { Env } from "@/src/shared/types/env"
import type { FindingEvent } from "@/src/features/finding-events/domain/types"

/** The per-review identity every row carries — matches usage_ledger's UNIQUE, so
 *  cost/tokens are JOINed rather than duplicated onto finding rows. */
export interface FindingEventReviewIdentity {
  installationId: number
  repoId?: number | null
  prNumber: number
  headSha: string
  /** RESOLVED model id post-fallback — NOT the tier alias, which can silently
   *  re-point to different weights on MaaS. */
  modelId?: string | null
  promptVersion?: string | null
}

function intOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function textOrNull(v: string | null | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Coerce a NOT NULL text bind. `.bind()` REJECTS undefined, and `db.batch()` is
 *  all-or-nothing — so one missing required field would otherwise discard an entire
 *  review's labels. These columns are typed required, but the writer populates them
 *  from webhook payloads and mid-pipeline objects where a runtime hole is real. */
function requiredText(v: string | null | undefined): string {
  return typeof v === "string" && v.length > 0 ? v : ""
}

/**
 * Append a batch of finding events. FAILS SOFT — never throws.
 *
 * No-ops on an empty batch or an absent binding (an unprovisioned deploy simply
 * records nothing rather than erroring).
 */
export async function appendFindingEvents(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  identity: FindingEventReviewIdentity,
  events: readonly FindingEvent[],
  nowIso: string,
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  if (events.length === 0) return
  const db = env.SIGILIX_PLATFORM_DB
  const installationId = Number.isFinite(identity.installationId) ? Math.trunc(identity.installationId) : 0
  const repoId = intOrNull(identity.repoId) ?? 0
  const prNumber = Number.isFinite(identity.prNumber) ? Math.trunc(identity.prNumber) : 0
  const sql =
    "INSERT INTO finding_event" +
    " (installation_id, repo_id, pr_number, head_sha, finding_key, content_fingerprint," +
    " category, score, confidence, gate_score, path, line, start_line, source_specialists," +
    " trust_tier, stage, gate, reason, enforced, outcome, model_id, prompt_version," +
    " inline_comment_id, created_at)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  const bindOne = (e: FindingEvent) =>
    db
      .prepare(sql)
      .bind(
        installationId,
        repoId,
        prNumber,
        requiredText(identity.headSha),
        requiredText(e.findingKey),
        textOrNull(e.contentFingerprint),
        textOrNull(e.category),
        intOrNull(e.score),
        intOrNull(e.confidence),
        numOrNull(e.gateScore),
        textOrNull(e.path),
        intOrNull(e.line),
        intOrNull(e.startLine),
        e.sourceSpecialists && e.sourceSpecialists.length > 0 ? e.sourceSpecialists.join(",") : null,
        textOrNull(e.trustTier),
        requiredText(e.stage),
        textOrNull(e.gate),
        textOrNull(e.reason),
        e.enforced ? 1 : 0,
        requiredText(e.outcome),
        textOrNull(identity.modelId),
        textOrNull(identity.promptVersion),
        intOrNull(e.inlineCommentId),
        requiredText(nowIso),
      )

  try {
    await db.batch(events.map(bindOne))
  } catch (error) {
    // db.batch() is ALL-OR-NOTHING, so one rejected row would otherwise discard the
    // whole review's labels — unacceptable in a table whose premise is that labels
    // stop evaporating. Retry per-statement so a bad row costs exactly one row, and
    // name the casualties so the loss is diagnosable rather than silent.
    const lost: string[] = []
    for (const e of events) {
      try {
        await bindOne(e).run()
      } catch {
        lost.push(e.findingKey)
      }
    }
    console.warn(
      JSON.stringify({
        event: "d1-finding-event-log-batch-fell-back",
        prNumber,
        count: events.length,
        lost: lost.length,
        lostKeys: lost.slice(0, 20),
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
