// Gardener tombstone store (Phase-1 activity-aware decay).
//
// A reaped ephemeral memory is MOVED to a parallel `learnings-archive:` keyspace
// — never hard-deleted — so it stays recoverable (this phase's contract is
// "recoverable for >= 30 days"; we set NO TTL so a future cleanup slice owns
// expiry rather than risk under-shooting it here).
//
// Ordering is a hard safety invariant: the archive record is written FIRST, and
// the entries are removed from the ACTIVE store ONLY after that write succeeds.
// A crash/throw between the two steps leaves an entry present in BOTH places
// (safe + recoverable) rather than in NEITHER (data loss). The archive append is
// dedup-by-id (last-write-wins), so re-archiving the same id on a retry is
// idempotent — the tombstone never accumulates duplicates. Best-effort
// throughout: any failure logs + returns `false` (the caller counts it "archive
// failed, entry NOT removed"), never throws.

import { learningsArchiveKey, learningsKey, removeEntry } from "@/src/features/learnings/domain/store-ops"
import {
  LEARNINGS_SCHEMA_VERSION,
  type LearningEntry,
  type LearningScope,
  type LearningStore,
} from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"
import { loadLearnings } from "./store"

/** An active `LearningEntry` stamped with the wall-clock at which it was reaped. */
export interface ArchivedLearningEntry extends LearningEntry {
  /** ISO-8601 timestamp the Gardener moved this memory into the tombstone. */
  archivedTs: string
}

/** The tombstone store — same shape as `LearningStore`, archived entries. */
export interface ArchivedLearningStore {
  schemaVersion: 1
  scope: LearningScope
  subjectId: string
  entries: ArchivedLearningEntry[]
}

/**
 * Tombstone `entries` under `learnings-archive:<scope>:<subjectId>`, THEN remove
 * them from the active `learnings:<scope>:<subjectId>` store. Returns `true` when
 * the archive write succeeds AND the active removal completes (or the active
 * store is already absent); returns `false` only when the archive write throws or
 * the active-removal write throws — in which case the entries are left in the
 * active store (and, on a post-archive removal failure, also in the tombstone —
 * the safe "both places" state). Never throws.
 */
export async function archiveLearningEntries(
  env: Env,
  scope: LearningScope,
  subjectId: string,
  entries: ReadonlyArray<LearningEntry>,
  archivedTs: string,
): Promise<boolean> {
  if (entries.length === 0) return true

  // ── Step 1: write the tombstone FIRST (read-modify-write the archive key). ──
  try {
    const archiveKey = learningsArchiveKey(scope, subjectId)
    const existing = parseArchiveStore(await env.OPENCLAW_STATE.get(archiveKey), scope, subjectId)
    const base: ArchivedLearningStore = existing ?? {
      schemaVersion: LEARNINGS_SCHEMA_VERSION,
      scope,
      subjectId,
      entries: [],
    }
    // Dedup-by-id, last-write-wins: a re-archive of the same id updates in place
    // rather than appending a duplicate (idempotent on the retry path).
    const byId = new Map<string, ArchivedLearningEntry>()
    for (const existingEntry of base.entries) byId.set(existingEntry.id, existingEntry)
    for (const entry of entries) byId.set(entry.id, { ...entry, scope, subjectId, archivedTs })
    await env.OPENCLAW_STATE.put(archiveKey, JSON.stringify({ ...base, entries: [...byId.values()] }))
  } catch (err) {
    emitArchiveLog("learnings-archive-write-failed", {
      scope,
      subject_id: subjectId,
      entry_count: entries.length,
      error: errorMessage(err),
    })
    return false
  }

  // ── Step 2: only NOW remove from the active store (fresh read-modify-write). ─
  // Re-read via loadLearnings (full validation, never throws — returns null on
  // missing / unreadable / invalid) so removal runs against a vetted store.
  try {
    const active = await loadLearnings(env, scope, subjectId)
    if (active === null) {
      // Nothing to remove (already absent / unreadable) — tombstone is written, done.
      emitArchiveLog("learnings-archive-succeeded", {
        scope,
        subject_id: subjectId,
        archived_count: entries.length,
        removed_count: 0,
      })
      return true
    }
    let next: LearningStore = active
    for (const entry of entries) next = removeEntry(next, entry.id)
    await env.OPENCLAW_STATE.put(learningsKey(scope, subjectId), JSON.stringify(next))
    emitArchiveLog("learnings-archive-succeeded", {
      scope,
      subject_id: subjectId,
      archived_count: entries.length,
      removed_count: active.entries.length - next.entries.length,
    })
    return true
  } catch (err) {
    // Archive DID land; the active-removal write failed. The entries are safely
    // in BOTH places — report false so the caller does not count them removed.
    emitArchiveLog("learnings-archive-remove-failed", {
      scope,
      subject_id: subjectId,
      entry_count: entries.length,
      error: errorMessage(err),
    })
    return false
  }
}

/**
 * Read the tombstone store for a (scope, subjectId), or null when missing /
 * unreadable / invalid. Lets recovery tooling (and tests) prove a reaped memory
 * is still present + round-trips. Never throws.
 */
export async function loadArchivedLearnings(
  env: Env,
  scope: LearningScope,
  subjectId: string,
): Promise<ArchivedLearningStore | null> {
  try {
    return parseArchiveStore(await env.OPENCLAW_STATE.get(learningsArchiveKey(scope, subjectId)), scope, subjectId)
  } catch (err) {
    emitArchiveLog("learnings-archive-load-failed", {
      scope,
      subject_id: subjectId,
      error: errorMessage(err),
    })
    return null
  }
}

function parseArchiveStore(raw: string | null, scope: LearningScope, subjectId: string): ArchivedLearningStore | null {
  if (raw === null) return null // genuinely absent — NOT corruption
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A corrupt EXISTING tombstone is the recovery store — surface the signal
    // (the step-1 append then overwrites it, so don't lose it silently).
    emitArchiveLog("learnings-archive-corrupt", { scope, subject_id: subjectId, reason: "json-parse" })
    return null
  }
  if (!isValidArchiveStore(parsed, scope, subjectId)) {
    emitArchiveLog("learnings-archive-corrupt", { scope, subject_id: subjectId, reason: "shape" })
    return null
  }
  return parsed
}

function isValidArchiveStore(value: unknown, scope: LearningScope, subjectId: string): value is ArchivedLearningStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Partial<ArchivedLearningStore>
  return (
    record.schemaVersion === LEARNINGS_SCHEMA_VERSION &&
    record.scope === scope &&
    record.subjectId === subjectId &&
    Array.isArray(record.entries) &&
    record.entries.every(isValidArchivedEntry)
  )
}

// Honest guard: validates the full `LearningEntry` field set (matching
// store.ts's `isValidEntry`) PLUS the `archivedTs` stamp — this is the recovery
// read-back path, so the predicate must actually check what it asserts.
function isValidArchivedEntry(value: unknown): value is ArchivedLearningEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Partial<ArchivedLearningEntry>
  return (
    typeof entry.id === "string" &&
    typeof entry.rule === "string" &&
    isPolarity(entry.polarity) &&
    isScope(entry.scope) &&
    typeof entry.subjectId === "string" &&
    typeof entry.source === "object" &&
    entry.source !== null &&
    typeof entry.createdTs === "string" &&
    typeof entry.appliedCount === "number" &&
    typeof entry.archivedTs === "string"
  )
}

function isScope(value: unknown): value is LearningScope {
  return value === "repo" || value === "org" || value === "project"
}

function isPolarity(value: unknown): value is LearningEntry["polarity"] {
  return value === "suppress" || value === "require" || value === "context"
}

function emitArchiveLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
