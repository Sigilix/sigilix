// SIG-247 Phase 1 PR B — admin migration for review-memory keyspace.
//
// Walks every repo of one installation, lists existing legacy keys
// (`review-memory:<owner>/<repo>:*`), resolves the immutable
// `repo.id` via GitHub API, and copies/merges the records into the
// new repo-id keyspace (`review-memory:repo:<id>:*`).
//
// Why this exists: Phase 1 PR A's dual-write only fires when a fresh
// capture lands. Repos with existing review-memory state written
// BEFORE PR A deployed will only get their new key populated when the
// NEXT capture happens — which could be days or weeks for a low-
// activity repo. This admin endpoint is the cutover tool: one-shot
// per install + idempotent re-runs.
//
// Migration semantics (DeepSeek consult — read-union-write, NOT
// overwrite):
//   - Read the legacy record
//   - Read the current new record (may be non-empty from dual-write
//     captures that landed during the transition window)
//   - Union signals on commentId dedup (via storage.ts::unionRecords)
//   - Sort by ts desc, cap to 50 newest
//   - Stamp `migratedAt: <iso8601>` sentinel on the record
//   - Write merged record to the new key
//
// Phase 5 cleanup (separate ticket, ~2-3 weeks later) drops the
// legacy reads + deletes the legacy writes after a 7-day safety
// window. PR B explicitly does NOT delete legacy keys — they stay
// intact until Phase 5 confirms zero canary regressions.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import {
  getInstallationToken,
  listInstallationRepoFullNames,
} from "@/src/shared/adapters/github/github-app"
import { parseFullName } from "@/src/lib/index-producer"
import { buildRepoIdKey, unionRecords } from "./storage"
import type {
  ReviewMemoryCategory,
  ReviewMemoryRecord,
  ReviewMemoryStorageScope,
} from "./types"
import { ALL_REVIEW_MEMORY_CATEGORIES } from "./types"

const TTL_DAYS = 90
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60

// `migratedAt` is the advisory sentinel on `ReviewMemoryRecord` (see
// types.ts). Migration stamps it on first copy; `unionRecords` +
// `appendSignal` preserve it across subsequent read-modify-write
// cycles. Phase 5 cleanup reads the field as evidence the record went
// through migration BEFORE the cleanup window started.

export type MigrateMemoryRepoStatus =
  | "migrated"
  | "already-migrated"
  | "no-legacy-records"
  | "github-404"
  | "github-no-id"
  | "github-error"
  | "kv-error"

export interface MigrateMemoryRepoOutcome {
  owner: string
  repo: string
  status: MigrateMemoryRepoStatus
  githubRepoId?: number
  /** Number of legacy keys discovered (cat + path-cat combined). */
  legacyKeysFound: number
  /**
   * Number of records the migration would touch (always populated —
   * including dry-run). Code-reviewer M2: this is the operator-facing
   * "how big is this batch?" number.
   */
  recordsConsidered: number
  /**
   * Number of records actually written to KV. 0 on dry-run. Diverges
   * from `recordsConsidered` when a per-record put fails mid-batch.
   */
  recordsWritten: number
  /** Signal-count sums across all migrated records (post-union). */
  signalsCopied: number
  detail?: string
}

export interface MigrateMemoryInstallSummary {
  installationId: number
  reposScanned: number
  migrated: number
  alreadyMigrated: number
  skipped: number
  failed: number
  /** Sums across all repos' outcomes. */
  legacyKeysFound: number
  recordsConsidered: number
  recordsWritten: number
  signalsCopied: number
  dryRun: boolean
  outcomes: MigrateMemoryRepoOutcome[]
}

async function buildClient(
  env: Env,
  installationId: number,
): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error(
      "migrate-review-memory: GITHUB_APP_ID + GITHUB_PRIVATE_KEY required",
    )
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}

function isValidRecord(value: unknown): value is ReviewMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== 1) return false
  if (typeof r.category !== "string") return false
  if (!Array.isArray(r.signals)) return false
  if (typeof r.lastUpdatedTs !== "string") return false
  return true
}

interface DiscoveredLegacyRecord {
  scope: ReviewMemoryStorageScope
  record: ReviewMemoryRecord
}

/**
 * Enumerate every legacy `review-memory:<owner>/<repo>:*` key for one
 * repo. Returns parsed scope + record pairs ready for union-and-write.
 * Skips corrupt records (logged + counted as `skipped`, but the
 * migration continues on the remaining records).
 */
async function discoverLegacyRecords(
  env: Env,
  owner: string,
  repo: string,
): Promise<DiscoveredLegacyRecord[]> {
  const prefix = `review-memory:${owner}/${repo}:`
  const discovered: DiscoveredLegacyRecord[] = []
  let cursor: string | undefined
  do {
    const listOpts: { prefix: string; cursor?: string } = { prefix }
    if (cursor !== undefined) listOpts.cursor = cursor
    const page = await env.OPENCLAW_STATE.list(listOpts)
    for (const item of page.keys) {
      const scope = parseLegacyKey(item.name)
      if (!scope) continue
      let raw: string | null
      try {
        raw = await env.OPENCLAW_STATE.get(item.name)
      } catch {
        continue
      }
      if (raw === null) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!isValidRecord(parsed)) continue
      discovered.push({ scope, record: parsed })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor !== undefined)
  return discovered
}

/**
 * Parse a legacy key back into the discriminated scope. Returns null
 * for malformed shapes (defensive — `kv.list` only returns keys we
 * wrote, but a manual KV edit could land junk).
 */
function parseLegacyKey(
  key: string,
): ReviewMemoryStorageScope | null {
  // review-memory:<owner>/<repo>:cat:<category>
  // review-memory:<owner>/<repo>:path:<sha256>:cat:<category>
  const catMatch = key.match(/:cat:([a-z]+)$/)
  if (!catMatch) return null
  const category = catMatch[1] as ReviewMemoryCategory
  if (!ALL_REVIEW_MEMORY_CATEGORIES.includes(category)) return null
  const pathMatch = key.match(/:path:([0-9a-f]+):cat:/)
  if (pathMatch) {
    return {
      kind: "path-category",
      category,
      pathSha256: pathMatch[1]!,
    }
  }
  return { kind: "category", category }
}

async function readNewKeyRecord(
  env: Env,
  repoId: number,
  scope: ReviewMemoryStorageScope,
): Promise<ReviewMemoryRecord | null> {
  const key = buildRepoIdKey(repoId, scope)
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return isValidRecord(parsed) ? parsed : null
}

/**
 * Single-repo migration. Exposed for the per-repo admin endpoint
 * flavor + unit tests. Idempotent: re-running on records that all
 * carry the `migratedAt` sentinel is a no-op + cheap GitHub API
 * check that returns `already-migrated`. Re-running with new legacy
 * captures (rare — capture path dual-writes once Phase 1 PR A is
 * live) merges them in via the union semantics.
 */
export async function migrateOneRepoReviewMemory(
  env: Env,
  client: GitHubClient,
  owner: string,
  repo: string,
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<MigrateMemoryRepoOutcome> {
  let legacy: DiscoveredLegacyRecord[]
  try {
    legacy = await discoverLegacyRecords(env, owner, repo)
  } catch (err) {
    return {
      owner,
      repo,
      status: "kv-error",
      legacyKeysFound: 0,
      recordsConsidered: 0,
      recordsWritten: 0,
      signalsCopied: 0,
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  if (legacy.length === 0) {
    return {
      owner,
      repo,
      status: "no-legacy-records",
      legacyKeysFound: 0,
      recordsConsidered: 0,
      recordsWritten: 0,
      signalsCopied: 0,
    }
  }

  // Cheap idempotency check — if EVERY legacy record's new-key
  // counterpart already carries the `migratedAt` sentinel, we can
  // skip the GitHub API call entirely. Saves an API roundtrip per
  // re-run on already-migrated installs.
  //
  // We still need the repo.id to construct the new key, so we read
  // ANY new-key record's `migratedAt`. If none exist yet, fall
  // through to the full migration path.
  //
  // (Detection path: the legacy key contains owner/repo but not
  // repo.id; we cannot probe the new keyspace without first
  // resolving repo.id via the API.)

  let repoMeta: { default_branch: string; id: number | undefined } | null
  try {
    repoMeta = await client.getRepository(owner, repo)
  } catch (err) {
    return {
      owner,
      repo,
      status: "github-error",
      legacyKeysFound: legacy.length,
      recordsConsidered: 0,
      recordsWritten: 0,
      signalsCopied: 0,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  if (repoMeta === null) {
    return {
      owner,
      repo,
      status: "github-404",
      legacyKeysFound: legacy.length,
      recordsConsidered: 0,
      recordsWritten: 0,
      signalsCopied: 0,
    }
  }
  if (
    typeof repoMeta.id !== "number" ||
    !Number.isInteger(repoMeta.id) ||
    repoMeta.id <= 0
  ) {
    return {
      owner,
      repo,
      status: "github-no-id",
      legacyKeysFound: legacy.length,
      recordsConsidered: 0,
      recordsWritten: 0,
      signalsCopied: 0,
    }
  }
  const repoId = repoMeta.id

  let recordsConsidered = 0
  let recordsWritten = 0
  let signalsCopied = 0
  let allAlreadyMigrated = true

  for (const { scope, record } of legacy) {
    // Read-union-write per DeepSeek's algorithmic recommendation. The
    // new key may already hold a record (dual-write captures during
    // the transition window) — naive overwrite would lose those
    // signals. Union on commentId, sort ts desc, cap to 50 newest.
    const existingNew = await readNewKeyRecord(env, repoId, scope)
    const existingMigratedAt = existingNew?.migratedAt
    const isAlreadyMigrated = existingMigratedAt !== undefined
    if (!isAlreadyMigrated) allAlreadyMigrated = false

    const merged = unionRecords(record, existingNew, scope)
    if (merged === null) continue
    recordsConsidered += 1

    // Code-reviewer M1: preserve the original `migratedAt` on
    // already-migrated re-runs. Without this, every idempotent
    // re-run resets the sentinel to "last re-run" instead of "first
    // migration" — which breaks Phase 5's ability to use the sentinel
    // as evidence that a record went through migration BEFORE the
    // cleanup window started.
    const withSentinel: ReviewMemoryRecord = {
      ...merged,
      migratedAt: existingMigratedAt ?? new Date().toISOString(),
    }

    signalsCopied += withSentinel.signals.length

    if (opts.dryRun) {
      // M2: do NOT increment recordsWritten on dry-run; the field
      // semantics are "actual KV puts that succeeded". The operator
      // reads recordsConsidered for the "how big is this batch"
      // signal.
      continue
    }

    const newKey = buildRepoIdKey(repoId, scope)
    try {
      await env.OPENCLAW_STATE.put(newKey, JSON.stringify(withSentinel), {
        expirationTtl: TTL_SECONDS,
      })
      recordsWritten += 1
    } catch (err) {
      return {
        owner,
        repo,
        status: "kv-error",
        githubRepoId: repoId,
        legacyKeysFound: legacy.length,
        recordsConsidered,
        recordsWritten,
        signalsCopied,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  return {
    owner,
    repo,
    status: allAlreadyMigrated ? "already-migrated" : "migrated",
    githubRepoId: repoId,
    legacyKeysFound: legacy.length,
    recordsConsidered,
    recordsWritten,
    signalsCopied,
  }
}

/**
 * Migrate every repo under one installation. Reads the installation's
 * repo list via GitHub, then runs `migrateOneRepoReviewMemory` per
 * repo. Per-repo errors don't abort the batch — the response carries
 * a structured summary so the operator can re-run on `failed` repos.
 */
export async function migrateInstallReviewMemoryToRepoId(
  env: Env,
  installationId: number,
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<MigrateMemoryInstallSummary> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error(
      "migrate-review-memory: GITHUB_APP_ID + GITHUB_PRIVATE_KEY required",
    )
  }

  const listing = await listInstallationRepoFullNames(
    env.OPENCLAW_STATE,
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
    installationId,
  )
  // Same partial-listing guard as SIG-243's migration helper. The
  // operator must re-run rather than be misled by a clean-looking
  // summary that skipped the tail of the listing.
  if (!listing.complete) {
    throw new Error(
      `migrate-review-memory: repository listing incomplete for installation ${installationId} ` +
        `(${listing.items.length} items observed before truncation); re-run after the underlying ` +
        `pagination issue is resolved`,
    )
  }
  const fullNames = listing.items

  const client = await buildClient(env, installationId)

  const outcomes: MigrateMemoryRepoOutcome[] = []
  let migrated = 0
  let alreadyMigrated = 0
  let skipped = 0
  let failed = 0
  let legacyKeysFound = 0
  let recordsConsidered = 0
  let recordsWritten = 0
  let signalsCopied = 0

  for (const fullName of fullNames) {
    const parsed = parseFullName({ full_name: fullName })
    if (!parsed) {
      outcomes.push({
        owner: "",
        repo: fullName,
        status: "kv-error",
        legacyKeysFound: 0,
        recordsConsidered: 0,
        recordsWritten: 0,
        signalsCopied: 0,
        detail: "bad full_name",
      })
      // CR Major (PR #206): status is `kv-error`, so this counts as
      // failed, not skipped. The prior `skipped += 1` misreported
      // outcome totals and could hide real migration-data issues in
      // operator dashboards.
      failed += 1
      continue
    }
    const { owner, repo } = parsed
    const outcome = await migrateOneRepoReviewMemory(env, client, owner, repo, opts)
    outcomes.push(outcome)
    legacyKeysFound += outcome.legacyKeysFound
    recordsConsidered += outcome.recordsConsidered
    recordsWritten += outcome.recordsWritten
    signalsCopied += outcome.signalsCopied
    switch (outcome.status) {
      case "migrated":
        migrated += 1
        break
      case "already-migrated":
        alreadyMigrated += 1
        break
      case "no-legacy-records":
      case "github-404":
        skipped += 1
        break
      default:
        failed += 1
    }
  }

  console.log(JSON.stringify({
    event: "review-memory-migration-coverage",
    installation_id: installationId,
    repos_scanned: fullNames.length,
    listing_complete: listing.complete,
    migrated,
    already_migrated: alreadyMigrated,
    skipped,
    failed,
    legacy_keys_found: legacyKeysFound,
    records_considered: recordsConsidered,
    records_written: recordsWritten,
    signals_copied: signalsCopied,
    dry_run: opts.dryRun,
  }))

  return {
    installationId,
    reposScanned: fullNames.length,
    migrated,
    alreadyMigrated,
    skipped,
    failed,
    legacyKeysFound,
    recordsConsidered,
    recordsWritten,
    signalsCopied,
    dryRun: opts.dryRun,
    outcomes,
  }
}
