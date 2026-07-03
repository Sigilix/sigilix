// Unified instructive-learning capture — the shared, scope-parameterized write
// path that lets NON-GitHub conversational surfaces (Slack, Linear) contribute
// to the SAME `learnings:<scope>:<subjectId>` store the PR-review pipeline and
// the CLI agent read back from. This is the "one memory, every surface" seam.
//
// The GitHub surfaces (github-mention-auto-learnings.ts, review-memory/capture.ts)
// keep their own richer capture sites because they ALSO post a GitHub
// confirmation reply, record a `@sigilix forget` map, and mirror repo→org. This
// adapter is the minimal common core for surfaces that do NOT post their own
// learning confirmation and want a single-scope write: run the QUALITY GATE
// (`extractLearning`), dedupe, classify, and `appendLearning` into the given
// scope. All four surfaces therefore converge on the same store + read seam
// (`loadEffectiveLearnings` / the CLI union), so a rule taught on one surface is
// applied on every other surface in the same scope.
//
// QUALITY GATE (central, testable): a message becomes a learning ONLY if
// `extractLearning` returns a rule. The LLM extractor rejects acknowledgements,
// pure questions, and one-off explanations, and the deterministic post-filters
// (`isAck` / `isPureQuestion` / blanket-scope-for-suppress in domain/extractor.ts)
// back it. On the `"chat"` surface the policy is narrower still: remember only a
// message that TEACHES a durable convention or CORRECTS the assistant with a
// generalizable rule. Ordinary Q&A, task requests, and chatter never pass.
//
// SEPARATE FROM TRAINING-DATA CONSENT (#796): this is always-on-per-org GROUNDING
// memory, gated ONLY by `OPENCLAW_LEARNINGS_MODE` (+ `OPENCLAW_ORG_MEMORY_CAPTURE`
// for org-scope writes, matching the repo→org mirror's rollout switch). It NEVER
// reads `SIGILIX_TRAINING_RETENTION_MODE` or the consent store, and NEVER writes
// the training R2 partition — grounding and the cross-org training corpus are
// deliberately different systems.
//
// TENANT ISOLATION: the learning is written into exactly
// `learnings:<scope>:<subjectId>` and read back only within that scope — an
// org write keyed by the installation id is visible only to surfaces under that
// installation. The caller resolves `subjectId` from the surface's own tenant
// mapping (Slack team → repo → installation; Linear team → repo → installation),
// never from cross-tenant data.
//
// Best-effort: never throws; every failure is logged-and-swallowed so a capture
// can never block the surface's user-facing reply.

import { classifyLearningMemory } from "@/src/features/learnings/domain/classify"
import type { ExtractionSurface } from "@/src/features/learnings/domain/extractor"
import { resolveLearningsMode, resolveOrgMemoryCaptureMode } from "@/src/features/learnings/domain/mode"
import { computeLearningId, normalizeRule } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry, LearningScope, LearningSourceKind } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"
import { emitLearningAudit } from "./audit"
import { extractLearning } from "./extractor-model"
import { appendLearning } from "./store"

const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60

export interface CaptureInstructiveLearningArgs {
  env: Env
  /** Target scope. Slack/Linear org-automation writes `"org"`. */
  scope: LearningScope
  /** Scope subject id — for `"org"`, the GitHub App installation id as a string. */
  subjectId: string
  /** The extractor surface policy to apply (the quality gate). */
  surface: ExtractionSurface
  /** The persisted `source.kind` for audit/telemetry/decay. */
  sourceKind: LearningSourceKind
  /** The human message tested against the quality gate + extracted into a rule. */
  message: string
  /** Stable id of the source message for best-effort dedupe (Slack thread key, Linear comment id). */
  dedupeId: string
  /** Actor for the audit record (e.g. `"slack:U123"`, a Linear display name). */
  actor?: string
  /** Extra structured fields folded into every telemetry line for this capture. */
  telemetry?: Record<string, unknown>
}

export interface CaptureInstructiveLearningResult {
  captured: boolean
  learningId?: string
  rule?: string
}

/**
 * Capture an instructive chat message as a scope-scoped learning, quality-gated
 * by `extractLearning`. Returns `{ captured: false }` on mode off/shadow, an
 * org-capture-disabled scope, a dedupe hit, a message that fails the quality
 * gate, or any internal error — the caller's reply is never blocked.
 */
export async function captureInstructiveLearning(
  args: CaptureInstructiveLearningArgs,
): Promise<CaptureInstructiveLearningResult> {
  const { env, scope, subjectId, surface, sourceKind, message, dedupeId, actor } = args
  const fields = { surface, scope, subject_id: subjectId, ...args.telemetry }
  try {
    const mode = resolveLearningsMode(env.OPENCLAW_LEARNINGS_MODE)
    if (mode === "off") return { captured: false }

    // Org-scope grounding shares ONE rollout switch with the repo→org mirror, so
    // org memory is either wholly active or wholly dark. Non-org scopes are
    // governed by the learnings-mode master flag alone.
    if (scope === "org" && resolveOrgMemoryCaptureMode(env) === "off") {
      log("learning-capture-skipped", { ...fields, reason: "org-capture-disabled" })
      return { captured: false }
    }

    if (subjectId.length === 0) {
      log("learning-capture-skipped", { ...fields, reason: "missing-subject-id" })
      return { captured: false }
    }

    // Dedupe key folds a content hash of the message with the caller's stable id:
    // a webhook REDELIVERY (same source id + same content) is suppressed, but two
    // DISTINCT teachings that happen to share a coarse id (e.g. two messages in the
    // same Slack thread by one user) each get their own key and are both captured.
    const contentHash = await computeLearningId(normalizeRule(message))
    const seenKey = `learning-capture-seen:${surface}:${dedupeId}:${contentHash}`
    if (mode === "on" && (await alreadySeen(env, seenKey, fields))) return { captured: false }

    // ── QUALITY GATE ────────────────────────────────────────────────────────
    const extracted = await extractLearning(env, { surface, replyText: message })
    if (extracted === null) return { captured: false }

    const rule = normalizeRule(extracted.rule)
    if (rule.length === 0) return { captured: false }

    if (mode === "shadow") {
      log("learning-extract-shadow", {
        ...fields,
        actor,
        rule,
        polarity: extracted.polarity,
        category: extracted.category ?? null,
        path_glob: extracted.pathGlob ?? null,
      })
      return { captured: false }
    }

    await markSeen(env, seenKey, fields)
    const learningId = await computeLearningId(rule)
    const createdTs = new Date().toISOString()
    // No PR/branch anchor on a chat surface → classify falls through to the LLM's
    // suggested type or a durable preference (never a PR-tied ephemeral).
    const { type, lifespanAnchor } = classifyLearningMemory({
      sourceKind,
      polarity: extracted.polarity,
      suggestedType: extracted.memoryType ?? null,
    })
    const entry: LearningEntry = {
      id: learningId,
      rule,
      polarity: extracted.polarity,
      category: extracted.category ?? null,
      pathGlob: extracted.pathGlob ?? null,
      scope,
      subjectId,
      source: { kind: sourceKind },
      createdTs,
      appliedCount: 0,
      ...(actor !== undefined ? { authorLogin: actor } : {}),
      type,
      lifespanAnchor,
    }

    const appended = await appendLearning(env, scope, subjectId, entry, Date.parse(createdTs))
    if (!appended) return { captured: false }

    emitLearningAudit({ actor: actor ?? "", scope, subjectId, action: "capture", learningId, ts: createdTs })
    return { captured: true, learningId, rule }
  } catch (err) {
    log("learning-capture-failed", {
      ...fields,
      stage: "capture",
      err: err instanceof Error ? err.message : String(err),
    })
    return { captured: false }
  }
}

async function alreadySeen(env: Env, key: string, fields: Record<string, unknown>): Promise<boolean> {
  try {
    const seen = await env.OPENCLAW_STATE.get(key)
    if (seen !== null) {
      log("learning-capture-skipped", { ...fields, reason: "already-seen" })
      return true
    }
  } catch (err) {
    log("learning-capture-failed", {
      ...fields,
      stage: "dedupe-read",
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return false
}

async function markSeen(env: Env, key: string, fields: Record<string, unknown>): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, "1", { expirationTtl: DEDUPE_TTL_SECONDS })
  } catch (err) {
    log("learning-capture-failed", {
      ...fields,
      stage: "dedupe-write",
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}
