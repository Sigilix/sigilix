// Explicit one-time bridge from the legacy user-scoped onboarding KV payload
// into canonical, installation-scoped repository context.
//
// The legacy key has no installation id. Callers MUST therefore obtain the
// installation from an authenticated admin action and pass only that exact
// installation's complete live GitHub App repository snapshot. This helper
// never discovers or guesses an installation from names in KV. Once imported,
// immutable numeric repository ids are authoritative in D1.

import {
  readRepositoryContext,
  replaceRepositoryContext,
  validateGitHubRepositoryContextInput,
  type RepositoryContextInputValidationReason,
  type RepositoryContextSnapshot,
} from "@/src/features/repository-context"
import { hasHighConfidenceSecretText } from "@/src/lib/secret-scan"

const PROVIDER = "github" as const
const ONBOARDING_KV_PREFIX = "onboarding:"

export interface OnboardingImportAvailableRepository {
  repositoryId: number
  fullName: string
}

export type OnboardingRepositoryContextImportResult =
  | { status: "updated"; snapshot: RepositoryContextSnapshot }
  | { status: "not_found" }
  | { status: "invalid"; reason: RepositoryContextInputValidationReason }
  | { status: "scope_changed"; missingRepositoryCount: number }
  | { status: "exists"; currentRevision: number }
  | { status: "unavailable"; stage: "kv" | "repository_context" }

interface LegacyOnboardingLink {
  from: string
  label: string
  to: string
}

interface LegacyOnboardingContext {
  selectedRepos: Set<string> | null
  repoDescriptions: Record<string, string>
  links: LegacyOnboardingLink[]
  conventions: string
}

type ParsedLegacyContext =
  | { ok: true; value: LegacyOnboardingContext }
  | { ok: false; reason: RepositoryContextInputValidationReason }

type BuiltImport =
  | {
      ok: true
      repositories: Array<{ externalId: string; fullName: string; context: string; position: number }>
      relationships: Array<{
        fromExternalId: string
        toExternalId: string
        label: string
        normalizedLabel: string
        position: number
      }>
      conventions: string
    }
  | { ok: false; status: "not_found" }
  | { ok: false; status: "invalid"; reason: RepositoryContextInputValidationReason }
  | { ok: false; status: "scope_changed"; missingRepositoryCount: number }

export async function importOnboardingRepositoryContext(args: {
  db: D1Database
  kv: KVNamespace
  githubUserId: string
  installationId: number
  availableRepositories: OnboardingImportAvailableRepository[]
  nowIso: string
}): Promise<OnboardingRepositoryContextImportResult> {
  const scopeId = String(args.installationId)
  const current = await readRepositoryContext(args.db, PROVIDER, scopeId)
  if (current.status === "unavailable") return { status: "unavailable", stage: "repository_context" }
  // Active snapshots and tombstones are both durable history. An import never
  // resurrects or overwrites either one.
  if (current.status === "ok") return { status: "exists", currentRevision: current.snapshot.revision }

  // The source is intentionally user-scoped legacy data. The explicit route's
  // exact installation selection is the user's consent to apply matching
  // answers to that installation; this helper never fans the payload out.
  let raw: unknown
  try {
    raw = await args.kv.get(`${ONBOARDING_KV_PREFIX}${args.githubUserId}`, "json")
  } catch {
    return { status: "unavailable", stage: "kv" }
  }
  const built = buildImport(raw, args.availableRepositories)
  if (!built.ok) {
    if (built.status === "not_found") return { status: "not_found" }
    if (built.status === "scope_changed") {
      return { status: "scope_changed", missingRepositoryCount: built.missingRepositoryCount }
    }
    return { status: "invalid", reason: built.reason }
  }

  const written = await replaceRepositoryContext(args.db, {
    provider: PROVIDER,
    scopeId,
    expectedRevision: 0,
    repositories: built.repositories,
    relationships: built.relationships,
    conventions: built.conventions,
    nowIso: args.nowIso,
    updatedBy: `github:${args.githubUserId}:onboarding-import`,
  })
  if (written.status === "updated") return written
  if (written.status === "conflict") return { status: "exists", currentRevision: written.currentRevision }
  if (written.status === "scope_changed") return { status: "scope_changed", missingRepositoryCount: 0 }
  return { status: "unavailable", stage: "repository_context" }
}

function buildImport(raw: unknown, availableRepositories: OnboardingImportAvailableRepository[]): BuiltImport {
  const parsed = parseLegacyContext(raw)
  if (!parsed.ok) return { ok: false, status: "invalid", reason: parsed.reason }

  const availableByName = new Map<string, OnboardingImportAvailableRepository>()
  for (const repository of availableRepositories) {
    if (availableByName.has(repository.fullName)) {
      return { ok: false, status: "invalid", reason: "invalid_repository" }
    }
    availableByName.set(repository.fullName, repository)
  }

  const missingNames = new Set<string>()
  const contextByRepositoryId = new Map<number, string>()
  const selected = parsed.value.selectedRepos
  const isSelected = (fullName: string): boolean => selected === null || selected.has(fullName)

  for (const [fullName, context] of Object.entries(parsed.value.repoDescriptions)) {
    if (!isSelected(fullName) || context.trim().length === 0) continue
    const available = availableByName.get(fullName)
    if (!available) {
      missingNames.add(fullName)
      continue
    }
    contextByRepositoryId.set(available.repositoryId, context)
  }

  const rawRelationships: Array<{
    fromRepositoryId: number
    toRepositoryId: number
    label: string
  }> = []
  for (const link of parsed.value.links) {
    if (!isSelected(link.from) || !isSelected(link.to)) {
      return { ok: false, status: "invalid", reason: "invalid_relationship" }
    }
    const from = availableByName.get(link.from)
    const to = availableByName.get(link.to)
    if (!from) missingNames.add(link.from)
    if (!to) missingNames.add(link.to)
    if (!from || !to) continue
    if (!contextByRepositoryId.has(from.repositoryId)) contextByRepositoryId.set(from.repositoryId, "")
    if (!contextByRepositoryId.has(to.repositoryId)) contextByRepositoryId.set(to.repositoryId, "")
    rawRelationships.push({
      fromRepositoryId: from.repositoryId,
      toRepositoryId: to.repositoryId,
      label: link.label,
    })
  }
  if (missingNames.size > 0) {
    return { ok: false, status: "scope_changed", missingRepositoryCount: missingNames.size }
  }

  const rawRepositories = [...contextByRepositoryId.entries()].map(([repositoryId, context]) => ({
    repositoryId,
    context,
  }))
  if (rawRepositories.length === 0 && rawRelationships.length === 0 && parsed.value.conventions.trim().length === 0) {
    return { ok: false, status: "not_found" }
  }

  const validated = validateGitHubRepositoryContextInput(
    {
      revision: 0,
      repositories: rawRepositories,
      relationships: rawRelationships,
      conventions: parsed.value.conventions,
    },
    hasHighConfidenceSecretText,
  )
  if (!validated.ok) return { ok: false, status: "invalid", reason: validated.reason }

  const liveById = new Map(availableRepositories.map((repository) => [String(repository.repositoryId), repository]))
  const repositories = validated.value.repositories.map((repository) => ({
    externalId: repository.externalId,
    fullName: liveById.get(repository.externalId)!.fullName,
    context: repository.context,
    position: repository.position,
  }))
  return {
    ok: true,
    repositories,
    relationships: validated.value.relationships,
    conventions: validated.value.conventions,
  }
}

function parseLegacyContext(raw: unknown): ParsedLegacyContext {
  if (!isRecord(raw)) return { ok: false, reason: "invalid_shape" }

  let selectedRepos: Set<string> | null = null
  if (raw.selectedRepos !== undefined) {
    if (!isStringArray(raw.selectedRepos)) return { ok: false, reason: "invalid_shape" }
    selectedRepos = new Set(raw.selectedRepos)
  }

  let repoDescriptions: Record<string, string> = {}
  if (raw.repoDescriptions !== undefined) {
    if (!isStringRecord(raw.repoDescriptions)) return { ok: false, reason: "invalid_shape" }
    repoDescriptions = raw.repoDescriptions
  }

  let links: LegacyOnboardingLink[] = []
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links) || !raw.links.every(isLegacyLink)) {
      return { ok: false, reason: "invalid_shape" }
    }
    links = raw.links
  }

  const conventions = raw.conventions ?? ""
  if (typeof conventions !== "string") return { ok: false, reason: "invalid_shape" }
  return { ok: true, value: { selectedRepos, repoDescriptions, links, conventions } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
}

function isLegacyLink(value: unknown): value is LegacyOnboardingLink {
  return (
    isRecord(value) && typeof value.from === "string" && typeof value.label === "string" && typeof value.to === "string"
  )
}
