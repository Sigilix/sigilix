const DEFAULT_GITLAB_ORIGIN = "https://gitlab.com"
const MAX_INSTANCE_ORIGIN_CHARS = 512
const MAX_FULL_NAME_CHARS = 512

export interface GitLabRepositoryAuthorityIdentity {
  instanceOrigin: string
  sourceId: number
  externalId: string
}

export interface GitLabRepositoryAuthorityRepository extends GitLabRepositoryAuthorityIdentity {
  fullName: string
}

/**
 * Canonicalize one GitLab instance base URL without discarding a self-managed
 * relative-URL root. Query, fragment, and credentials are never identity.
 */
export function normalizeGitLabInstanceOrigin(value?: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value ?? DEFAULT_GITLAB_ORIGIN)
  } catch {
    return null
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null
  }
  const pathname = parsed.pathname.replace(/\/+$/, "")
  const normalized = `${parsed.origin}${pathname === "/" ? "" : pathname}`
  return normalized.length > 0 && normalized.length <= MAX_INSTANCE_ORIGIN_CHARS ? normalized : null
}

export function canonicalGitLabSourceId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

export function canonicalGitLabRepositoryFullName(value: unknown): string | null {
  if (typeof value !== "string" || hasDisallowedControl(value)) return null
  const normalized = value.normalize("NFC").trim()
  return normalized.length > 0 && normalized.length <= MAX_FULL_NAME_CHARS ? normalized : null
}

/**
 * Bounded issuer-qualified repository identity. The versioned NUL-delimited
 * preimage is unambiguous; the full SHA-256 digest keeps even long self-managed
 * instance URLs within repository_context_repository.external_id's 128-char cap.
 */
export async function makeGitLabRepositoryExternalId(instanceOrigin: string, sourceId: number): Promise<string | null> {
  const origin = normalizeGitLabInstanceOrigin(instanceOrigin)
  const canonicalSourceId = canonicalGitLabSourceId(sourceId)
  if (!origin || canonicalSourceId === null) return null
  const preimage = new TextEncoder().encode(`${origin}\u0000${canonicalSourceId}`)
  const digest = await crypto.subtle.digest("SHA-256", preimage)
  return `gl:v1:${base64url(new Uint8Array(digest))}`
}

export async function canonicalGitLabRepositoryAuthorityIdentity(
  instanceOrigin: string,
  sourceId: number,
): Promise<GitLabRepositoryAuthorityIdentity | null> {
  const origin = normalizeGitLabInstanceOrigin(instanceOrigin)
  const canonicalSourceId = canonicalGitLabSourceId(sourceId)
  if (!origin || canonicalSourceId === null) return null
  const externalId = await makeGitLabRepositoryExternalId(origin, canonicalSourceId)
  return externalId ? { instanceOrigin: origin, sourceId: canonicalSourceId, externalId } : null
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function hasDisallowedControl(value: string): boolean {
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
