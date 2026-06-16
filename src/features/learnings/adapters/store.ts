import { learningsKey, removeEntry, upsertEntry } from "@/src/features/learnings/domain/store-ops"
import {
  LEARNINGS_SCHEMA_VERSION,
  type LearningEntry,
  type LearningScope,
  type LearningStore,
} from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

export async function loadLearnings(env: Env, scope: LearningScope, subjectId: string): Promise<LearningStore | null> {
  const key = learningsKey(scope, subjectId)
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    return isValidStore(parsed, scope, subjectId) ? parsed : null
  } catch (err) {
    emitLearningStoreLog("learnings-load-failed", {
      scope,
      subject_id: subjectId,
      error: errorMessage(err),
    })
    return null
  }
}

/**
 * Append (or upsert-by-id) a learning. Read-modify-write over KV, which has NO
 * compare-and-swap — so two concurrent appends to the SAME scope+subject can
 * lose one (the same accepted caveat as review-memory's `appendSignal` /
 * precision-profile's `recordOutcome`). It's rare (two teaches on one repo
 * inside the write window), and the content-addressed id makes a redelivery an
 * idempotent upsert; the transactional fix is the planned D1 migration (SIG-448).
 * Best-effort: returns false + logs on any failure, never throws.
 */
export async function appendLearning(
  env: Env,
  scope: LearningScope,
  subjectId: string,
  entry: LearningEntry,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const key = learningsKey(scope, subjectId)
  const nowIso = new Date(nowMs).toISOString()
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    const existing = parseStoredLearnings(raw, scope, subjectId)
    const base: LearningStore = existing ?? {
      schemaVersion: LEARNINGS_SCHEMA_VERSION,
      scope,
      subjectId,
      entries: [],
    }
    const nextEntry: LearningEntry = { ...entry, scope, subjectId }
    const next = upsertEntry(base, nextEntry, nowIso)
    await env.OPENCLAW_STATE.put(key, JSON.stringify(next))
    emitLearningStoreLog("learnings-append-succeeded", {
      scope,
      subject_id: subjectId,
      learning_id: entry.id,
      entry_count: next.entries.length,
    })
    return true
  } catch (err) {
    emitLearningStoreLog("learnings-append-failed", {
      scope,
      subject_id: subjectId,
      learning_id: entry.id,
      error: errorMessage(err),
    })
    return false
  }
}

export async function forgetLearning(env: Env, scope: LearningScope, subjectId: string, id: string): Promise<boolean> {
  const key = learningsKey(scope, subjectId)
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    const existing = parseStoredLearnings(raw, scope, subjectId)
    if (existing === null) return true
    const next = removeEntry(existing, id)
    await env.OPENCLAW_STATE.put(key, JSON.stringify(next))
    emitLearningStoreLog("learnings-forget-succeeded", {
      scope,
      subject_id: subjectId,
      learning_id: id,
      entry_count: next.entries.length,
    })
    return true
  } catch (err) {
    emitLearningStoreLog("learnings-forget-failed", {
      scope,
      subject_id: subjectId,
      learning_id: id,
      error: errorMessage(err),
    })
    return false
  }
}

export async function hardDeleteLearnings(env: Env, scope: LearningScope, subjectId: string): Promise<boolean> {
  try {
    await env.OPENCLAW_STATE.delete(learningsKey(scope, subjectId))
    emitLearningStoreLog("learnings-hard-delete-succeeded", {
      scope,
      subject_id: subjectId,
    })
    return true
  } catch (err) {
    emitLearningStoreLog("learnings-hard-delete-failed", {
      scope,
      subject_id: subjectId,
      error: errorMessage(err),
    })
    return false
  }
}

function parseStoredLearnings(raw: string | null, scope: LearningScope, subjectId: string): LearningStore | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isValidStore(parsed, scope, subjectId) ? parsed : null
  } catch {
    return null
  }
}

function isValidStore(value: unknown, scope: LearningScope, subjectId: string): value is LearningStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Partial<LearningStore>
  return (
    record.schemaVersion === LEARNINGS_SCHEMA_VERSION &&
    record.scope === scope &&
    record.subjectId === subjectId &&
    Array.isArray(record.entries) &&
    record.entries.every(isValidEntry)
  )
}

function isValidEntry(value: unknown): value is LearningEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Partial<LearningEntry>
  return (
    typeof entry.id === "string" &&
    typeof entry.rule === "string" &&
    isPolarity(entry.polarity) &&
    isScope(entry.scope) &&
    typeof entry.subjectId === "string" &&
    typeof entry.source === "object" &&
    entry.source !== null &&
    typeof entry.createdTs === "string" &&
    typeof entry.appliedCount === "number"
  )
}

function isScope(value: unknown): value is LearningScope {
  return value === "repo" || value === "org" || value === "project"
}

function isPolarity(value: unknown): value is LearningEntry["polarity"] {
  return value === "suppress" || value === "require" || value === "context"
}

function emitLearningStoreLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
