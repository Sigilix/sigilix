import type { Env } from "@/src/shared/types/env"
import { prReviewCoverageKey, prReviewCoverageRepoIdKey } from "@/src/shared/domain/index-keys"
import type {
  IncrementalReviewCoverage,
  IncrementalReviewCoverageEntry,
} from "@/src/lib/ensemble/domain/incremental-coverage"

const TTL_SECONDS = 30 * 24 * 60 * 60

export interface IncrementalReviewCoverageWriteEntry {
  path: string
  blobSha: string | null
}

function validRepoId(repoId: number | undefined): repoId is number {
  return typeof repoId === "number" && Number.isInteger(repoId) && repoId > 0
}

function isCoverageEntry(value: unknown): value is IncrementalReviewCoverageEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.reviewedAtBlobSha === "string" &&
    entry.reviewedAtBlobSha.length > 0 &&
    typeof entry.reviewedAtHeadSha === "string" &&
    entry.reviewedAtHeadSha.length > 0 &&
    typeof entry.reviewedAt === "string" &&
    entry.reviewedAt.length > 0
  )
}

function parseCoverage(raw: string | null): IncrementalReviewCoverage | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.schemaVersion !== 1 || !obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) {
    return null
  }
  const files: Record<string, IncrementalReviewCoverageEntry> = {}
  for (const [path, entry] of Object.entries(obj.files)) {
    if (path.length > 0 && isCoverageEntry(entry)) files[path] = entry
  }
  return { schemaVersion: 1, files }
}

function mergeCoverage(
  a: IncrementalReviewCoverage | null,
  b: IncrementalReviewCoverage | null,
): IncrementalReviewCoverage | null {
  if (a === null) return b
  if (b === null) return a
  const files = { ...a.files }
  for (const [path, entry] of Object.entries(b.files)) {
    const existing = files[path]
    if (existing === undefined || Date.parse(entry.reviewedAt) >= Date.parse(existing.reviewedAt)) {
      files[path] = entry
    }
  }
  return { schemaVersion: 1, files }
}

async function readKey(env: Env, key: string): Promise<IncrementalReviewCoverage | null> {
  try {
    return parseCoverage(await env.OPENCLAW_STATE.get(key))
  } catch {
    return null
  }
}

export async function readIncrementalReviewCoverage(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  repoId?: number,
): Promise<IncrementalReviewCoverage | null> {
  const legacyKey = prReviewCoverageKey(owner, repo, prNumber)
  const repoIdKey = validRepoId(repoId) ? prReviewCoverageRepoIdKey(repoId, prNumber) : null
  const [legacy, byRepoId] = await Promise.all([
    readKey(env, legacyKey),
    repoIdKey !== null ? readKey(env, repoIdKey) : Promise.resolve(null),
  ])
  return mergeCoverage(legacy, byRepoId)
}

export async function writeIncrementalReviewCoverage(
  env: Env,
  args: {
    owner: string
    repo: string
    prNumber: number
    repoId?: number
    headSha: string
    entries: readonly IncrementalReviewCoverageWriteEntry[]
  },
): Promise<void> {
  const usableEntries = args.entries.filter((entry): entry is { path: string; blobSha: string } =>
    Boolean(entry.blobSha),
  )
  if (usableEntries.length === 0) return
  try {
    const prior = await readIncrementalReviewCoverage(env, args.owner, args.repo, args.prNumber, args.repoId)
    const reviewedAt = new Date().toISOString()
    const files: Record<string, IncrementalReviewCoverageEntry> = { ...(prior?.files ?? {}) }
    for (const entry of usableEntries) {
      files[entry.path] = {
        reviewedAtBlobSha: entry.blobSha,
        reviewedAtHeadSha: args.headSha,
        reviewedAt,
      }
    }
    const record: IncrementalReviewCoverage = { schemaVersion: 1, files }
    const writes = [
      env.OPENCLAW_STATE.put(prReviewCoverageKey(args.owner, args.repo, args.prNumber), JSON.stringify(record), {
        expirationTtl: TTL_SECONDS,
      }),
    ]
    if (validRepoId(args.repoId)) {
      writes.push(
        env.OPENCLAW_STATE.put(prReviewCoverageRepoIdKey(args.repoId, args.prNumber), JSON.stringify(record), {
          expirationTtl: TTL_SECONDS,
        }),
      )
    }
    await Promise.all(writes)
  } catch {
    // Best-effort review memory: a write failure only means the next run reviews more.
  }
}
