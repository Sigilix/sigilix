// Memory Gardener — activity-aware decay pass (Phase-1 of the dynamic-memory
// moat). Runs on the 6h cron (a THIRD independent `ctx.waitUntil` block in
// `scheduled()`, gated ONLY by its own mode-check — never by the indexer gate).
//
// Bounded KV scan of `learnings:*` stores → for each ephemeral, PR-anchored,
// repo-scope memory it resolves the anchoring PR's closure time (repo-tenant KV
// → App installation → token → GET /pulls/{n}) and asks the pure
// `isMemoryDecayEligible` gate whether the PR closed longer ago than the decay
// window. In "shadow" it only LOGS each would-reap; in "enforce" it tombstones
// each eligible memory into the `learnings-archive:` keyspace (archive-then-
// remove, never a hard delete). Durable tiers + legacy records are never
// touched, and every ambiguous/failed signal keeps.
//
// Default OFF (mode unset) returns immediately with ZERO side effects — no KV
// read, no GitHub call, no telemetry — so prod is byte-identical until an
// operator opts in. Fail-soft throughout (per-key + per-entry try/catch, like
// `runIndexReconciliation`): one bad key/entry/GitHub call counts as "unknown"
// (keep) and is logged, never aborting the tick.

import {
  EPHEMERAL_MEMORY_TYPES,
  archiveLearningEntries,
  isMemoryDecayEligible,
  loadLearnings,
  parseLearningsKey,
  resolveMemoryDecayMode,
  type LearningEntry,
  type LearningScope,
  type MemoryDecayMode,
} from "@/src/features/learnings"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken, resolveRepoInstallationId } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"
import { parseRepoIndexManifest, repoTenantKey } from "./repo-index-manifest"
import { writeDecayDigestHalf, type DecayWouldReapSample } from "./memory-gardener-digest"

/** Max active `learnings:` keys visited per tick. The scan reads up to this many
 *  `learnings:` keys in lexicographic order FROM THE START (no cursor is carried
 *  across ticks), so with more than this many stores the tail is NOT reached
 *  until a future paginating/rotating-cursor slice — it is NOT auto-retried next
 *  tick. A truncated scan is logged (`memory-decay-tick-truncated`), never silent. */
export const MAX_LEARNINGS_KEYS_PER_TICK = 200

/** Max NEW `getPullRequest` network lookups per tick (cache hits don't count).
 *  Once reached, further un-cached candidates are skipped (fail-safe keep). */
export const MAX_PR_LOOKUPS_PER_TICK = 50

const MS_PER_DAY = 24 * 60 * 60 * 1000
const LEARNINGS_PREFIX = "learnings:"

export interface MemoryDecaySummary {
  mode: MemoryDecayMode
  /** `learnings:` keys parsed + loaded this tick. */
  keysScanned: number
  /** Entries iterated across all loaded stores. */
  entriesScanned: number
  /** Entries that passed the cheap no-IO pre-filter (ephemeral + pr + repo). */
  candidates: number
  /** NEW `getPullRequest` network lookups made (cache hits excluded). */
  prLookupsUsed: number
  /** Entries the pure gate judged reap-eligible (counted in shadow AND enforce). */
  eligible: number
  /** Entries actually tombstoned (enforce-only; 0 in shadow/off). */
  archived: number
  /** Eligible entries whose `archiveLearningEntries` returned false (NOT removed). */
  archiveFailed: number
  /** Caught per-key/per-entry errors (each = "unknown", kept). */
  errors: number
  /** The KV key-list was truncated at the per-tick cap. */
  keyListTruncated: boolean
  /** The per-tick PR-lookup cap was hit; some candidates were skipped (kept). */
  prLookupCapReached: boolean
}

/** Per-tick memoization so a shared repo/PR/installation is resolved once. */
interface DecayCaches {
  ownerRepo: Map<string, { owner: string; repo: string } | null>
  prClosedAt: Map<string, number | null>
  installationId: Map<string, number | null>
  token: Map<number, string | null>
}

export async function runMemoryDecayPass(env: Env, opts: { nowMs?: number } = {}): Promise<MemoryDecaySummary> {
  const mode = resolveMemoryDecayMode(env)
  const summary: MemoryDecaySummary = {
    mode,
    keysScanned: 0,
    entriesScanned: 0,
    candidates: 0,
    prLookupsUsed: 0,
    eligible: 0,
    archived: 0,
    archiveFailed: 0,
    errors: 0,
    keyListTruncated: false,
    prLookupCapReached: false,
  }
  // Load-bearing "default OFF = prod unchanged": no KV read, no GitHub call, no
  // log — return the zeroed summary immediately.
  if (mode === "off") return summary

  const nowMs = opts.nowMs ?? Date.now()
  const archivedTs = new Date(nowMs).toISOString()
  const caches: DecayCaches = {
    ownerRepo: new Map(),
    prClosedAt: new Map(),
    installationId: new Map(),
    token: new Map(),
  }

  // Founder visibility (see memory-gardener-digest.ts): the top would-reap
  // memories this tick (collected in BOTH shadow AND enforce), surfaced read-only
  // behind the admin route so eligibility is visible without `wrangler tail`.
  const wouldReapSamples: DecayWouldReapSample[] = []

  const listed = await env.OPENCLAW_STATE.list({
    prefix: LEARNINGS_PREFIX,
    limit: MAX_LEARNINGS_KEYS_PER_TICK,
  })
  if (!listed.list_complete) {
    summary.keyListTruncated = true
    console.log(
      JSON.stringify({ event: "memory-decay-tick-truncated", reason: "key-list", keysScanned: listed.keys.length }),
    )
  }

  let prCapSkipped = 0

  for (const key of listed.keys) {
    // Per-key fail-soft: one bad key can't abort the tick.
    try {
      const parsedKey = parseLearningsKey(key.name)
      if (parsedKey === null) continue // e.g. a `learnings-archive:` key never matches this prefix anyway
      const { scope, subjectId } = parsedKey
      summary.keysScanned += 1
      const store = await loadLearnings(env, scope, subjectId)
      if (store === null) continue

      const eligibleBatch: Array<{ entry: LearningEntry; prNumber: number; prClosedAtMs: number }> = []

      for (const entry of store.entries) {
        summary.entriesScanned += 1
        // Cheap no-IO pre-filter: only an ephemeral, PR-anchored, repo-scope
        // memory can ever be eligible — everything else keeps with NO lookup.
        const prNumber = candidatePrNumber(entry, scope)
        if (prNumber === null) continue
        summary.candidates += 1

        // Per-entry fail-soft: a caught error = "unknown" (keep), logged.
        try {
          const ownerRepo = await resolveOwnerRepo(env, subjectId, caches)
          if (ownerRepo === null) continue // repo unknown → keep (not against the cap)

          const prKey = `${ownerRepo.owner}/${ownerRepo.repo}#${prNumber}`
          let prClosedAtMs: number | null
          if (caches.prClosedAt.has(prKey)) {
            prClosedAtMs = caches.prClosedAt.get(prKey) ?? null
          } else {
            if (summary.prLookupsUsed >= MAX_PR_LOOKUPS_PER_TICK) {
              summary.prLookupCapReached = true
              prCapSkipped += 1
              continue // fail-safe keep — skipped this tick (not looked up)
            }
            summary.prLookupsUsed += 1
            prClosedAtMs = await fetchPrClosedAtMs(env, ownerRepo.owner, ownerRepo.repo, prNumber, caches)
            caches.prClosedAt.set(prKey, prClosedAtMs)
          }

          if (!isMemoryDecayEligible(entry, prClosedAtMs, nowMs)) continue
          // Eligible ⇒ prClosedAtMs is a concrete number (the gate rejects null).
          if (prClosedAtMs === null) continue
          summary.eligible += 1
          if (wouldReapSamples.length < 100) {
            wouldReapSamples.push({
              scope,
              subjectId,
              learningId: entry.id,
              ...(entry.type !== undefined ? { type: entry.type } : {}),
              prNumber,
              closedAt: new Date(prClosedAtMs).toISOString(),
              ageDays: (nowMs - prClosedAtMs) / MS_PER_DAY,
            })
          }

          if (mode === "shadow") {
            emitDecayEvent("memory-decay-shadow", scope, subjectId, entry, prNumber, prClosedAtMs, nowMs)
          } else if (mode === "enforce") {
            eligibleBatch.push({ entry, prNumber, prClosedAtMs })
          } else {
            // Exhaustive guard: a future MemoryDecayMode member fails to compile
            // here instead of silently falling into the enforce path.
            const _exhaustive: never = mode
            throw new Error(`unhandled memory-decay mode: ${JSON.stringify(_exhaustive)}`)
          }
        } catch (err) {
          summary.errors += 1
          console.error(
            JSON.stringify({
              event: "memory-decay-entry-error",
              scope,
              subjectId,
              learningId: entry.id,
              error: errorMessage(err),
            }),
          )
        }
      }

      // Enforce: archive the whole store's eligible batch in ONE call, then emit
      // one auditable `memory-decay-archived` per reaped id.
      if (mode === "enforce" && eligibleBatch.length > 0) {
        const ok = await archiveLearningEntries(
          env,
          scope,
          subjectId,
          eligibleBatch.map((e) => e.entry),
          archivedTs,
        )
        if (ok) {
          summary.archived += eligibleBatch.length
          for (const { entry, prNumber, prClosedAtMs } of eligibleBatch) {
            emitDecayEvent("memory-decay-archived", scope, subjectId, entry, prNumber, prClosedAtMs, nowMs, archivedTs)
          }
        } else {
          summary.archiveFailed += eligibleBatch.length
        }
      }
    } catch (err) {
      summary.errors += 1
      console.error(JSON.stringify({ event: "memory-decay-key-error", key: key.name, error: errorMessage(err) }))
    }
  }

  // One truncation event for the whole tick (not per skipped entry — avoid spam).
  if (summary.prLookupCapReached) {
    console.log(
      JSON.stringify({
        event: "memory-decay-tick-truncated",
        reason: "pr-lookup-cap",
        entriesSkipped: prCapSkipped,
        cap: MAX_PR_LOOKUPS_PER_TICK,
      }),
    )
  }
  await writeDecayDigestHalf(env, {
    ranAt: new Date(nowMs).toISOString(),
    mode,
    summary: { ...summary },
    wouldReapSamples,
  })
  console.log(JSON.stringify({ event: "memory-decay-complete", ...summary }))
  return summary
}

/**
 * The cheap no-IO pre-filter: the PR number an entry is eligible-by-shape to be
 * checked against, or null to skip WITHOUT any lookup. Only repo-scope,
 * ephemeral-type, PR-anchored entries qualify (org/project scope have no
 * githubRepoId resolution path; durable/legacy/branch entries never decay).
 */
function candidatePrNumber(entry: LearningEntry, scope: LearningScope): number | null {
  if (scope !== "repo") return null
  if (entry.type === undefined || !EPHEMERAL_MEMORY_TYPES.has(entry.type)) return null
  const anchor = entry.lifespanAnchor
  if (anchor === undefined || anchor.kind !== "pr") return null
  // The store loader (`isValidEntry`) does NOT shape-validate `lifespanAnchor`,
  // so a persisted `{kind:"pr"}` with a missing / non-positive prNumber can load.
  // Such an entry must skip WITHOUT a lookup — otherwise it would burn a PR-lookup
  // slot on `/pulls/undefined` and only KEEP incidentally via GitHub's 404. Only a
  // positive integer is a real candidate.
  return Number.isInteger(anchor.prNumber) && anchor.prNumber > 0 ? anchor.prNumber : null
}

/**
 * Resolve owner/repo for a repo-scope subjectId (a GitHub numeric repo id as a
 * string) via the `repo-tenant:<id>` KV manifest. Memoized per subjectId this
 * tick. Fail-safe: a missing key, invalid manifest, non-numeric subjectId, or
 * KV error all resolve to null (unknown → keep) — never throws.
 */
async function resolveOwnerRepo(
  env: Env,
  subjectId: string,
  caches: DecayCaches,
): Promise<{ owner: string; repo: string } | null> {
  const cached = caches.ownerRepo.get(subjectId)
  if (cached !== undefined) return cached

  let result: { owner: string; repo: string } | null = null
  try {
    const id = Number(subjectId)
    if (Number.isInteger(id) && id > 0) {
      const raw = await env.OPENCLAW_STATE.get(repoTenantKey(id))
      if (raw !== null) {
        const parsed = parseRepoIndexManifest(raw)
        if (parsed.kind === "ok") result = { owner: parsed.manifest.owner, repo: parsed.manifest.repo }
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: "memory-decay-repo-resolve-error", subjectId, error: errorMessage(err) }))
    result = null
  }
  caches.ownerRepo.set(subjectId, result)
  return result
}

/**
 * Resolve the anchoring PR's closure timestamp (epoch ms) via App installation
 * → token → `GET /pulls/{n}`. Returns null for open / unknown / any failure —
 * so an unresolved PR can never reap. Memoizes the installation id + token so a
 * per-PR fetch never re-mints a token. Never lets a GitHub error propagate.
 */
async function fetchPrClosedAtMs(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  caches: DecayCaches,
): Promise<number | null> {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_PRIVATE_KEY
  if (!appId || !privateKey) return null
  try {
    const installationId = await resolveInstallationId(appId, privateKey, owner, repo, caches)
    if (installationId === null) return null
    const token = await resolveInstallationToken(env, appId, privateKey, installationId, caches)
    if (token === null) return null
    const pr = await new GitHubClient({ token }).getPullRequest(owner, repo, prNumber)
    // A closed OR merged PR sets `closed_at`; `merged_at` is a robust fallback
    // for a partial payload. Open → both null → keep.
    const closedAt = pr.closed_at ?? pr.merged_at ?? null
    if (closedAt === null) return null
    const ms = Date.parse(closedAt)
    return Number.isFinite(ms) ? ms : null
  } catch (err) {
    console.warn(
      JSON.stringify({ event: "memory-decay-pr-fetch-error", owner, repo, prNumber, error: errorMessage(err) }),
    )
    return null
  }
}

async function resolveInstallationId(
  appId: string,
  privateKey: string,
  owner: string,
  repo: string,
  caches: DecayCaches,
): Promise<number | null> {
  const k = `${owner}/${repo}`
  const cached = caches.installationId.get(k)
  if (cached !== undefined) return cached
  // resolveRepoInstallationId is already fail-soft (null on any failure).
  const id = await resolveRepoInstallationId(appId, privateKey, owner, repo)
  caches.installationId.set(k, id)
  return id
}

async function resolveInstallationToken(
  env: Env,
  appId: string,
  privateKey: string,
  installationId: number,
  caches: DecayCaches,
): Promise<string | null> {
  const cached = caches.token.get(installationId)
  if (cached !== undefined) return cached
  let token: string | null = null
  try {
    token = await getInstallationToken({ kv: env.OPENCLAW_STATE, appId, privateKey, installationId })
  } catch (err) {
    console.warn(JSON.stringify({ event: "memory-decay-token-error", installationId, error: errorMessage(err) }))
    token = null
  }
  caches.token.set(installationId, token)
  return token
}

function emitDecayEvent(
  event: "memory-decay-shadow" | "memory-decay-archived",
  scope: LearningScope,
  subjectId: string,
  entry: LearningEntry,
  prNumber: number,
  prClosedAtMs: number,
  nowMs: number,
  archivedTs?: string,
): void {
  console.log(
    JSON.stringify({
      event,
      scope,
      subjectId,
      learningId: entry.id,
      type: entry.type,
      prNumber,
      closedAt: new Date(prClosedAtMs).toISOString(),
      ageDays: (nowMs - prClosedAtMs) / MS_PER_DAY,
      ...(archivedTs !== undefined ? { archivedTs } : {}),
    }),
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
