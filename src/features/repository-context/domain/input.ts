export const MAX_REPOSITORY_CONTEXT_REPOSITORIES = 100
export const MAX_REPOSITORY_CONTEXT_RELATIONSHIPS = 200
export const MAX_REPOSITORY_CONTEXT_CHARS = 2_000
export const MAX_REPOSITORY_CONTEXT_LABEL_CHARS = 200
export const MAX_REPOSITORY_CONTEXT_CONVENTIONS_CHARS = 4_000

export interface RepositoryContextInputRepository {
  externalId: string
  context: string
  position: number
}

export interface RepositoryContextInputRelationship {
  fromExternalId: string
  toExternalId: string
  label: string
  normalizedLabel: string
  position: number
}

export interface RepositoryContextInput {
  expectedRevision: number
  repositories: RepositoryContextInputRepository[]
  relationships: RepositoryContextInputRelationship[]
  conventions: string
}

export type RepositoryContextInputValidationReason =
  | "invalid_shape"
  | "invalid_revision"
  | "invalid_repository"
  | "duplicate_repository"
  | "invalid_relationship"
  | "duplicate_relationship"
  | "too_many_repositories"
  | "too_many_relationships"
  | "repository_context_too_large"
  | "relationship_label_too_large"
  | "conventions_too_large"
  | "invalid_text"
  | "credential_detected"

export type RepositoryContextInputValidation =
  | { ok: true; value: RepositoryContextInput }
  | { ok: false; reason: RepositoryContextInputValidationReason }

export type RepositoryContextCredentialDetector = (text: string) => boolean

export function validateGitHubRepositoryContextInput(
  raw: unknown,
  detectsCredential: RepositoryContextCredentialDetector,
): RepositoryContextInputValidation {
  if (!isRecord(raw) || !hasExactKeys(raw, ["revision", "repositories", "relationships", "conventions"])) {
    return invalid("invalid_shape")
  }
  if (
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0 ||
    Number(raw.revision) >= Number.MAX_SAFE_INTEGER
  ) {
    return invalid("invalid_revision")
  }
  if (!Array.isArray(raw.repositories) || !Array.isArray(raw.relationships) || typeof raw.conventions !== "string") {
    return invalid("invalid_shape")
  }
  if (raw.repositories.length > MAX_REPOSITORY_CONTEXT_REPOSITORIES) return invalid("too_many_repositories")
  if (raw.relationships.length > MAX_REPOSITORY_CONTEXT_RELATIONSHIPS) return invalid("too_many_relationships")

  const repositories: RepositoryContextInputRepository[] = []
  const repositoryIds = new Set<string>()
  for (const [position, candidate] of raw.repositories.entries()) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["repositoryId", "context"])) {
      return invalid("invalid_shape")
    }
    if (typeof candidate.context !== "string") {
      return invalid("invalid_repository")
    }
    const externalId = githubRepositoryId(candidate.repositoryId)
    if (externalId === null) return invalid("invalid_repository")
    if (repositoryIds.has(externalId)) return invalid("duplicate_repository")
    const context = normalizeMultiline(candidate.context)
    if (hasDisallowedMultilineControl(candidate.context)) return invalid("invalid_text")
    if (exceeds(candidate.context, context, MAX_REPOSITORY_CONTEXT_CHARS)) {
      return invalid("repository_context_too_large")
    }
    if (containsCredential(candidate.context, context, detectsCredential)) return invalid("credential_detected")
    repositoryIds.add(externalId)
    repositories.push({ externalId, context, position })
  }

  const relationships: RepositoryContextInputRelationship[] = []
  const relationshipKeys = new Set<string>()
  for (const [position, candidate] of raw.relationships.entries()) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["fromRepositoryId", "toRepositoryId", "label"])) {
      return invalid("invalid_shape")
    }
    if (typeof candidate.label !== "string") {
      return invalid("invalid_relationship")
    }
    const fromExternalId = githubRepositoryId(candidate.fromRepositoryId)
    const toExternalId = githubRepositoryId(candidate.toRepositoryId)
    if (fromExternalId === null || toExternalId === null) {
      return invalid("invalid_relationship")
    }
    const label = normalizeLabel(candidate.label)
    if (
      label.length === 0 ||
      fromExternalId === toExternalId ||
      !repositoryIds.has(fromExternalId) ||
      !repositoryIds.has(toExternalId)
    ) {
      return invalid("invalid_relationship")
    }
    if (hasDisallowedLabelControl(candidate.label)) return invalid("invalid_text")
    if (exceeds(candidate.label, label, MAX_REPOSITORY_CONTEXT_LABEL_CHARS)) {
      return invalid("relationship_label_too_large")
    }
    if (containsCredential(candidate.label, label, detectsCredential)) return invalid("credential_detected")
    const normalizedLabel = label.toLowerCase()
    if (normalizedLabel.length > MAX_REPOSITORY_CONTEXT_LABEL_CHARS) {
      return invalid("relationship_label_too_large")
    }
    const relationshipKey = `${fromExternalId}\u0000${toExternalId}\u0000${normalizedLabel}`
    if (relationshipKeys.has(relationshipKey)) return invalid("duplicate_relationship")
    relationshipKeys.add(relationshipKey)
    relationships.push({ fromExternalId, toExternalId, label, normalizedLabel, position })
  }

  const conventions = normalizeMultiline(raw.conventions)
  if (hasDisallowedMultilineControl(raw.conventions)) return invalid("invalid_text")
  if (exceeds(raw.conventions, conventions, MAX_REPOSITORY_CONTEXT_CONVENTIONS_CHARS)) {
    return invalid("conventions_too_large")
  }
  if (containsCredential(raw.conventions, conventions, detectsCredential)) return invalid("credential_detected")
  repositories.sort((a, b) => Number(a.externalId) - Number(b.externalId))
  repositories.forEach((repository, position) => {
    repository.position = position
  })
  relationships.sort(
    (a, b) =>
      Number(a.fromExternalId) - Number(b.fromExternalId) ||
      Number(a.toExternalId) - Number(b.toExternalId) ||
      compareCodepoints(a.normalizedLabel, b.normalizedLabel),
  )
  relationships.forEach((relationship, position) => {
    relationship.position = position
  })
  return {
    ok: true,
    value: {
      expectedRevision: Number(raw.revision),
      repositories,
      relationships,
      conventions,
    },
  }
}

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function githubRepositoryId(value: unknown): string | null {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return null
  const numeric = Number(value)
  return String(numeric)
}

function normalizeMultiline(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim()
}

function normalizeLabel(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim()
}

function exceeds(original: string, normalized: string, cap: number): boolean {
  return original.length > cap || normalized.length > cap
}

function containsCredential(
  original: string,
  normalized: string,
  detectsCredential: RepositoryContextCredentialDetector,
): boolean {
  if (detectsCredential(original)) return true
  const compatibilityProbe = normalized.normalize("NFKC")
  return detectsCredential(compatibilityProbe)
}

function hasDisallowedMultilineControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || hasUnpairedSurrogate(value)
}

function hasDisallowedLabelControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value) || hasUnpairedSurrogate(value)
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

function invalid(reason: RepositoryContextInputValidationReason): RepositoryContextInputValidation {
  return { ok: false, reason }
}
