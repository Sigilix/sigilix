import type { PrReviewAppManifest, PrReviewAppManifestEntry, SupabaseManifestEntry, VercelManifestEntry } from "./types"

const MAX_MANIFEST_CHARS = 16 * 1024
const MAX_ENTRIES = 3
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Parse the trusted-base manifest as a closed, versioned contract. Any
 * unknown field, unsupported adapter, duplicate output lane, or over-cap list
 * rejects the whole file so a head-branch author cannot smuggle capabilities. */
export function parsePrReviewAppManifest(raw: string): PrReviewAppManifest | null {
  if (raw.length === 0 || raw.length > MAX_MANIFEST_CHARS) return null
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isClosedObject(value, ["version", "evidence"]) || value.version !== 1 || !Array.isArray(value.evidence)) {
    return null
  }
  if (value.evidence.length === 0 || value.evidence.length > MAX_ENTRIES) return null
  const evidence: PrReviewAppManifestEntry[] = []
  const lanes = new Set<string>()
  for (const candidate of value.evidence) {
    const parsed = parseEntry(candidate)
    if (!parsed) return null
    const lane =
      parsed.adapter === "vercel-deployment-status" ? parsed.adapter : `${parsed.adapter}:${parsed.advisorType}`
    if (lanes.has(lane)) return null
    lanes.add(lane)
    evidence.push(parsed)
  }
  return { version: 1, evidence }
}

function parseEntry(value: unknown): PrReviewAppManifestEntry | null {
  if (!isPlainObject(value) || typeof value.adapter !== "string") return null
  if (value.adapter === "vercel-deployment-status") return parseVercelEntry(value)
  if (value.adapter === "supabase-advisors") return parseSupabaseEntry(value)
  return null
}

function parseVercelEntry(value: Record<string, unknown>): VercelManifestEntry | null {
  if (!isClosedObject(value, ["adapter", "serverId", "teamId", "projectId"])) return null
  if (!safeId(value.serverId) || !safeId(value.teamId) || !safeId(value.projectId)) return null
  return {
    adapter: "vercel-deployment-status",
    serverId: value.serverId,
    teamId: value.teamId,
    projectId: value.projectId,
  }
}

function parseSupabaseEntry(value: Record<string, unknown>): SupabaseManifestEntry | null {
  if (!isClosedObject(value, ["adapter", "serverId", "projectId", "advisorType"])) return null
  if (!safeId(value.serverId) || !safeId(value.projectId)) return null
  if (value.advisorType !== "security" && value.advisorType !== "performance") return null
  return {
    adapter: "supabase-advisors",
    serverId: value.serverId,
    projectId: value.projectId,
    advisorType: value.advisorType,
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value)
}

function isClosedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
