// Slack memory adapter — scoped recall + credential-gated capture over the
// shared agent-memory store (Vectorize + KV).
//
// Legacy memory used mutable primary owner/repo names as its privacy boundary.
// The versioned boundary instead hashes the exact authorized installation,
// channel, and complete immutable repository-id set. A reversible off/shadow/on
// rollout warms and measures the new namespace before it becomes authoritative.

import { canonicalTenantId, storeMemoryFact } from "@/src/lib/agent-memory/agent-memory-route"
import type { StoreMemoryFactResult } from "@/src/lib/agent-memory/agent-memory-route"
import { queryMemoryIds } from "@/src/lib/agent-memory/retrieval"
import { readRecord } from "@/src/lib/agent-memory/storage"
import type { AgentMemoryKind } from "@/src/lib/agent-memory/types"
import { containsCredentialToken } from "@/src/lib/secret-scan"
import type { SlackScope } from "@/src/lib/slack/slack-scope"
import type { Env } from "@/src/shared/types/env"

export type SlackMemoryScope = Pick<SlackScope, "teamId" | "channelId" | "installationId" | "repos">

type SlackMemoryScopeMode = "off" | "shadow" | "on"

interface ScopeIds {
  userId: string
  repoId: string
}

interface ExactScopeIds extends ScopeIds {
  scopeHash: string
}

interface ExactScopeInputs {
  tenantInput: string
  scopeInput: string
}

type TimedResult<T> =
  | { status: "fulfilled"; value: T; durationMs: number }
  | { status: "rejected" | "timed-out"; durationMs: number }

const EXACT_HASH_HEX_LENGTH = 26
const SHADOW_SIDECAR_TIMEOUT_MS = 500
const SLACK_ID = /^[A-Z0-9]{1,64}$/
const encoder = new TextEncoder()

function resolveSlackMemoryScopeMode(env: Pick<Env, "OPENCLAW_SLACK_MEMORY_SCOPE_MODE">): SlackMemoryScopeMode {
  const value = env.OPENCLAW_SLACK_MEMORY_SCOPE_MODE
  return value === "shadow" || value === "on" ? value : "off"
}

// Off mode deliberately preserves the previous tenant pair byte-for-byte.
function legacyScopeIds(scope: SlackMemoryScope): ScopeIds {
  const primary = scope.repos[0]
  if (!primary) throw new Error("Slack memory requires at least one repository")
  return {
    userId: canonicalTenantId(`slack:${scope.teamId}`),
    repoId: canonicalTenantId(`${primary.owner}/${primary.repo}`),
  }
}

function normalizedSlackId(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!SLACK_ID.test(normalized)) throw new Error("Invalid Slack memory scope identifier")
  return normalized
}

function positiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid Slack memory numeric scope")
  return value
}

/** Decimal UTF-8 byte length + ':' + bytes for every ordered ASCII field. */
function canonicalFields(fields: readonly string[]): string {
  return fields.map((field) => `${encoder.encode(field).byteLength}:${field}`).join("")
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function exactScopeInputs(scope: SlackMemoryScope): ExactScopeInputs {
  const teamId = normalizedSlackId(scope.teamId)
  const channelId = normalizedSlackId(scope.channelId)
  const installationId = positiveSafeInteger(scope.installationId)
  const repositoryIds = [...new Set(scope.repos.map((repo) => positiveSafeInteger(repo.githubRepoId)))].sort(
    (left, right) => left - right,
  )
  if (repositoryIds.length === 0) throw new Error("Slack memory requires at least one repository")

  return {
    tenantInput: canonicalFields(["slack-memory-tenant", "2", "github", teamId, String(installationId)]),
    scopeInput: canonicalFields([
      "slack-memory-scope",
      "2",
      "github",
      teamId,
      channelId,
      String(installationId),
      String(repositoryIds.length),
      ...repositoryIds.map(String),
    ]),
  }
}

async function exactScopeIdsFromInputs(inputs: ExactScopeInputs): Promise<ExactScopeIds> {
  const [tenantDigest, scopeDigest] = await Promise.all([sha256Hex(inputs.tenantInput), sha256Hex(inputs.scopeInput)])
  const scopeHash = scopeDigest.slice(0, EXACT_HASH_HEX_LENGTH)
  const ids = {
    userId: `slack:v2:${tenantDigest.slice(0, EXACT_HASH_HEX_LENGTH)}`,
    repoId: `s-${scopeHash}`,
    scopeHash,
  }
  if (encoder.encode(`${ids.userId}/${ids.repoId}`).byteLength !== 64) {
    throw new Error("Slack memory namespace invariant failed")
  }
  return ids
}

async function exactScopeIds(scope: SlackMemoryScope): Promise<ExactScopeIds> {
  return exactScopeIdsFromInputs(exactScopeInputs(scope))
}

async function recallUnderIds(env: Env, ids: ScopeIds, query: string, topK: number): Promise<string[]> {
  const { userId, repoId } = ids
  const hits = await queryMemoryIds(env, { userId, repoId, query, topK })
  const records = await Promise.all(hits.map((hit) => readRecord(env, ids.userId, ids.repoId, hit.id)))
  return records.filter((record) => record !== null).map((record) => record.content)
}

async function timed<T>(operation: () => Promise<T>, timeoutMs?: number): Promise<TimedResult<T>> {
  const startedAt = Date.now()
  const settled = (async (): Promise<TimedResult<T>> => {
    try {
      return { status: "fulfilled", value: await operation(), durationMs: Date.now() - startedAt }
    } catch {
      return { status: "rejected", durationMs: Date.now() - startedAt }
    }
  })()
  if (timeoutMs === undefined) return settled

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<TimedResult<T>>((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: "timed-out", durationMs: Date.now() - startedAt }), timeoutMs)
  })
  const result = await Promise.race([settled, deadline])
  if (timeoutId !== undefined) clearTimeout(timeoutId)
  return result
}

// Preconditions: both arrays contain lowercase hex digests sorted ascending.
function multisetDelta(legacy: string[], exact: string[]): { missing: number; extra: number } {
  let legacyIndex = 0
  let exactIndex = 0
  let missing = 0
  let extra = 0
  while (legacyIndex < legacy.length && exactIndex < exact.length) {
    const legacyDigest = legacy[legacyIndex]
    const exactDigest = exact[exactIndex]
    if (legacyDigest === undefined || exactDigest === undefined) break
    if (legacyDigest === exactDigest) {
      legacyIndex += 1
      exactIndex += 1
    } else if (legacyDigest < exactDigest) {
      missing += 1
      legacyIndex += 1
    } else {
      extra += 1
      exactIndex += 1
    }
  }
  return { missing: missing + legacy.length - legacyIndex, extra: extra + exact.length - exactIndex }
}

async function emitShadowRecallTelemetry(
  legacy: TimedResult<string[]>,
  exact: TimedResult<{ ids: ExactScopeIds; contents: string[] }>,
  scopeHash: string | null,
): Promise<void> {
  const legacyContents = legacy.status === "fulfilled" ? legacy.value : []
  const exactContents = exact.status === "fulfilled" ? exact.value.contents : []
  let digestParity = false
  let missingExactCount = legacyContents.length
  let extraExactCount = exactContents.length
  const digests = await timed(async () => {
    const [legacyDigests, exactDigests] = await Promise.all([
      Promise.all(legacyContents.map(sha256Hex)),
      Promise.all(exactContents.map(sha256Hex)),
    ])
    return { legacyDigests, exactDigests }
  }, SHADOW_SIDECAR_TIMEOUT_MS)
  if (digests.status === "fulfilled") {
    const { legacyDigests, exactDigests } = digests.value
    legacyDigests.sort()
    exactDigests.sort()
    const delta = multisetDelta(legacyDigests, exactDigests)
    missingExactCount = delta.missing
    extraExactCount = delta.extra
    digestParity =
      legacy.status === "fulfilled" && exact.status === "fulfilled" && delta.missing === 0 && delta.extra === 0
  }
  emitTelemetry({
    event: "slack-memory-scope-shadow",
    operation: "recall",
    scopeHash,
    legacyStatus: legacy.status,
    exactStatus: exact.status,
    legacyCount: legacyContents.length,
    exactCount: exactContents.length,
    digestStatus: digests.status,
    digestParity,
    missingExactCount,
    extraExactCount,
    legacyDurationMs: legacy.durationMs,
    exactDurationMs: exact.durationMs,
  })
}

function emitShadowCaptureTelemetry(
  legacy: TimedResult<StoreMemoryFactResult>,
  exact: TimedResult<StoreMemoryFactResult>,
  scopeHash: string | null,
): void {
  emitTelemetry({
    event: "slack-memory-scope-shadow",
    operation: "capture",
    scopeHash,
    legacyStatus: legacy.status,
    exactStatus: exact.status,
    legacyStored: legacy.status === "fulfilled" && legacy.value.stored,
    exactStored: exact.status === "fulfilled" && exact.value.stored,
    exactVectorStored: exact.status === "fulfilled" && exact.value.vectorStored,
    exactDeduped: exact.status === "fulfilled" && exact.value.deduped,
    legacyDurationMs: legacy.durationMs,
    exactDurationMs: exact.durationMs,
  })
}

function emitTelemetry(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(fields))
  } catch {
    // Telemetry is observational and can never change recall/capture behavior.
  }
}

/** Recall is grounding, not gating; every mode soft-fails to an empty list. */
export async function recallSlackMemory(env: Env, scope: SlackMemoryScope, query: string, topK = 5): Promise<string[]> {
  const mode = resolveSlackMemoryScopeMode(env)
  if (mode === "off") {
    try {
      return await recallUnderIds(env, legacyScopeIds(scope), query, topK)
    } catch {
      return []
    }
  }
  if (mode === "on") {
    try {
      return await recallUnderIds(env, await exactScopeIds(scope), query, topK)
    } catch {
      return []
    }
  }

  let exactScopeHash: string | null = null
  const [legacy, exact] = await Promise.all([
    timed(() => recallUnderIds(env, legacyScopeIds(scope), query, topK)),
    timed(async () => {
      const ids = await exactScopeIds(scope)
      exactScopeHash = ids.scopeHash
      return { ids, contents: await recallUnderIds(env, ids, query, topK) }
    }, SHADOW_SIDECAR_TIMEOUT_MS),
  ])
  await emitShadowRecallTelemetry(legacy, exact, exactScopeHash).catch(() => {})
  return legacy.status === "fulfilled" ? legacy.value : []
}

/** Capture is secret-gated and returns the authoritative mode's KV status. */
export async function captureSlackMemory(
  env: Env,
  scope: SlackMemoryScope,
  args: { kind: AgentMemoryKind; content: string },
): Promise<{ stored: boolean; skippedSecret: boolean }> {
  try {
    if (containsCredentialToken(args.content)) return { stored: false, skippedSecret: true }
  } catch {
    emitTelemetry({ event: "slack-memory-secret-scan-failed" })
    return { stored: false, skippedSecret: true }
  }

  const mode = resolveSlackMemoryScopeMode(env)
  if (mode === "off") return captureSingle(env, legacyScopeIds, scope, args)
  if (mode === "on") return captureSingle(env, exactScopeIds, scope, args)

  // Finish all synchronous validation and exact-id hashing before either write
  // promise is constructed, so a scope failure cannot leave partial I/O in flight.
  let legacyIds: ScopeIds
  try {
    legacyIds = legacyScopeIds(scope)
  } catch {
    return { stored: false, skippedSecret: false }
  }
  let exactInputs: ExactScopeInputs | null = null
  try {
    exactInputs = exactScopeInputs(scope)
  } catch {
    // Shadow stays legacy-authoritative when the exact sidecar cannot be derived.
  }
  const legacyPromise = timed(() =>
    storeMemoryFact(env, { userId: legacyIds.userId, repoId: legacyIds.repoId, ...args }),
  )
  let exactScopeHash: string | null = null
  const validatedExactInputs = exactInputs
  const exactPromise = validatedExactInputs
    ? timed(async () => {
        const exactIds = await exactScopeIdsFromInputs(validatedExactInputs)
        exactScopeHash = exactIds.scopeHash
        return storeMemoryFact(env, { userId: exactIds.userId, repoId: exactIds.repoId, ...args })
      }, SHADOW_SIDECAR_TIMEOUT_MS)
    : Promise.resolve<TimedResult<StoreMemoryFactResult>>({ status: "rejected", durationMs: 0 })
  const [legacy, exact] = await Promise.all([legacyPromise, exactPromise])
  emitShadowCaptureTelemetry(legacy, exact, exactScopeHash)
  return {
    stored: legacy.status === "fulfilled" && legacy.value.stored,
    skippedSecret: false,
  }
}

async function captureSingle(
  env: Env,
  deriveIds: (scope: SlackMemoryScope) => ScopeIds | Promise<ScopeIds>,
  scope: SlackMemoryScope,
  args: { kind: AgentMemoryKind; content: string },
): Promise<{ stored: boolean; skippedSecret: boolean }> {
  try {
    const ids = await deriveIds(scope)
    const result = await storeMemoryFact(env, { userId: ids.userId, repoId: ids.repoId, ...args })
    return { stored: result.stored, skippedSecret: false }
  } catch {
    return { stored: false, skippedSecret: false }
  }
}
