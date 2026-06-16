import { pathMatchesAny } from "@/src/shared/util/path-glob"
import type { LearningEntry, LearningScope, LearningStore } from "./types"

export const MAX_LEARNINGS = 50
const MAX_PROMPT_LEARNINGS = 10
const HASH_HEX_WIDTH = 16
const DEFAULT_PROMPT_BUDGET_CHARS = 1500

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const WELL_KNOWN_TOKEN_RE =
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g
const GENERIC_TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g
const SECRET_ASSIGNMENT_RE =
  /(\b(?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|authorization)\b\s*[:=]\s*)["'`]?[^\s,"'`;]+["'`]?/gi

export function learningsKey(scope: LearningScope, subjectId: string): string {
  return `learnings:${scope}:${subjectId}`
}

export function normalizeRule(raw: string): string {
  const collapsed = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:remember|note)\b\s*:?\s*/i, "")
  // Redact shaped tokens (well-known + 40+ generic) BEFORE the key=value pass
  // so a secret is caught regardless of assignment context — code-review P2.
  // (A short, non-shaped value after a scheme word like `Bearer` is a known
  // low-risk residual the reviewer accepted; PR-2's extractor adds another gate.)
  return collapsed
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(WELL_KNOWN_TOKEN_RE, "[redacted-token]")
    .replace(GENERIC_TOKEN_RE, "[redacted-token]")
    .replace(SECRET_ASSIGNMENT_RE, "$1[redacted-secret]")
    .trim()
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += b.toString(16).padStart(2, "0")
  }
  return out
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", enc)
  return bytesToHex(new Uint8Array(buf))
}

export async function computeLearningId(normalizedRule: string): Promise<string> {
  const full = await sha256Hex(normalizedRule)
  return full.slice(0, HASH_HEX_WIDTH)
}

export function upsertEntry(
  store: LearningStore,
  entry: LearningEntry,
  appliedTs: string = entry.createdTs,
): LearningStore {
  const existingIndex = store.entries.findIndex((e) => e.id === entry.id)
  if (existingIndex >= 0) {
    const existing = store.entries[existingIndex]
    if (existing === undefined) return store
    const nextEntries = store.entries.slice()
    nextEntries[existingIndex] = {
      ...existing,
      lastAppliedTs: appliedTs,
      appliedCount: existing.appliedCount + 1,
    }
    return { ...store, entries: nextEntries }
  }

  const appended = [...store.entries, entry]
  if (appended.length <= MAX_LEARNINGS) {
    return { ...store, entries: appended }
  }

  const evictIndex = indexOfLeastRecentlyApplied(appended)
  return {
    ...store,
    entries: appended.filter((_, i) => i !== evictIndex),
  }
}

export function removeEntry(store: LearningStore, id: string): LearningStore {
  return {
    ...store,
    entries: store.entries.filter((entry) => entry.id !== id),
  }
}

export function selectRelevantForPaths(
  entries: ReadonlyArray<LearningEntry>,
  changedPaths: ReadonlyArray<string>,
  tokenBudget: number = DEFAULT_PROMPT_BUDGET_CHARS,
): LearningEntry[] {
  const selected: LearningEntry[] = []
  let used = 0
  for (const entry of entries) {
    if (selected.length >= MAX_PROMPT_LEARNINGS) break
    if (!isRelevantToChangedPaths(entry, changedPaths)) continue
    const cost = promptCost(entry)
    if (used + cost > tokenBudget) continue
    selected.push(entry)
    used += cost
  }
  return selected
}

function indexOfLeastRecentlyApplied(entries: ReadonlyArray<LearningEntry>): number {
  let bestIndex = 0
  let bestTs = timestampForEviction(entries[0])
  let bestCount = entries[0]?.appliedCount ?? 0
  for (let i = 1; i < entries.length; i++) {
    const candidate = entries[i]
    if (candidate === undefined) continue
    const candidateTs = timestampForEviction(candidate)
    if (candidateTs < bestTs || (candidateTs === bestTs && candidate.appliedCount < bestCount)) {
      bestIndex = i
      bestTs = candidateTs
      bestCount = candidate.appliedCount
    }
  }
  return bestIndex
}

function timestampForEviction(entry: LearningEntry | undefined): number {
  if (entry === undefined) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(entry.lastAppliedTs ?? entry.createdTs)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function isRelevantToChangedPaths(entry: LearningEntry, changedPaths: ReadonlyArray<string>): boolean {
  const glob = entry.pathGlob?.trim()
  if (!glob) return true
  return changedPaths.some((path) => pathMatchesAny(path, [glob]))
}

function promptCost(entry: LearningEntry): number {
  return entry.rule.length + entry.polarity.length + 16
}
