export type AppMemoryCliMode = "off" | "shadow" | "on"

export const MAX_APP_MEMORY_CONTEXT_CANDIDATES_PER_SCOPE = 8
export const MAX_APP_MEMORY_CONTEXT_ENTRIES_PER_SCOPE = 4
export const MAX_APP_MEMORY_CONTEXT_CHARS_PER_SCOPE = 3_000

export interface AppMemoryContextCandidate {
  id: string
  content: string
  createdAtMs: number
}

export interface ManagedAppContextMemory {
  id: string
  scope: "personal" | "organization"
  content: string
  source: "managed-app"
}

export interface AppMemoryContextScopeStats {
  candidateCount: number
  selectedCount: number
  selectedChars: number
  truncated: boolean
}

export interface AppMemoryContextSelection {
  memories: ManagedAppContextMemory[]
  stats: {
    personal: AppMemoryContextScopeStats
    organization: AppMemoryContextScopeStats
  }
}

type ModeEnv = { OPENCLAW_APP_MEMORY_CLI_MODE?: string }

/** Unknown or missing rollout values fail closed to off. */
export function resolveAppMemoryCliMode(env: unknown): AppMemoryCliMode {
  const raw = typeof env === "object" && env !== null ? (env as ModeEnv).OPENCLAW_APP_MEMORY_CLI_MODE : undefined
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if (normalized === "on") return "on"
  if (normalized === "shadow") return "shadow"
  return "off"
}

/**
 * Select bounded CLI context independently per scope. Personal entries are
 * selected first and suppress canonically-equal organization entries, so a
 * developer's explicit preference wins the shared default without letting one
 * scope consume the other scope's count or character budget.
 */
export function selectAppMemoryContext(args: {
  personal: readonly AppMemoryContextCandidate[]
  organization: readonly AppMemoryContextCandidate[]
}): AppMemoryContextSelection {
  const personalCandidates = newestCandidates(args.personal)
  const organizationCandidates = newestCandidates(args.organization)
  const selectedCanonicals = new Set<string>()
  const personal = selectScope(personalCandidates, "personal", selectedCanonicals)
  const organization = selectScope(organizationCandidates, "organization", selectedCanonicals)

  return {
    memories: [...personal.memories, ...organization.memories],
    stats: {
      personal: {
        candidateCount: personalCandidates.length,
        selectedCount: personal.memories.length,
        selectedChars: personal.selectedChars,
        truncated: args.personal.length > personal.memories.length,
      },
      organization: {
        candidateCount: organizationCandidates.length,
        selectedCount: organization.memories.length,
        selectedChars: organization.selectedChars,
        truncated: args.organization.length > organization.memories.length,
      },
    },
  }
}

function newestCandidates(candidates: readonly AppMemoryContextCandidate[]): AppMemoryContextCandidate[] {
  return [...candidates]
    .sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs
      if (a.id === b.id) return 0
      return a.id < b.id ? 1 : -1
    })
    .slice(0, MAX_APP_MEMORY_CONTEXT_CANDIDATES_PER_SCOPE)
}

function selectScope(
  candidates: readonly AppMemoryContextCandidate[],
  scope: ManagedAppContextMemory["scope"],
  selectedCanonicals: Set<string>,
): { memories: ManagedAppContextMemory[]; selectedChars: number } {
  const memories: ManagedAppContextMemory[] = []
  let selectedChars = 0
  for (const candidate of candidates) {
    if (memories.length >= MAX_APP_MEMORY_CONTEXT_ENTRIES_PER_SCOPE) break
    const canonical = canonicalContent(candidate.content)
    if (selectedCanonicals.has(canonical)) continue
    if (selectedChars + candidate.content.length > MAX_APP_MEMORY_CONTEXT_CHARS_PER_SCOPE) continue
    memories.push({ id: candidate.id, scope, content: candidate.content, source: "managed-app" })
    selectedCanonicals.add(canonical)
    selectedChars += candidate.content.length
  }
  return { memories, selectedChars }
}

function canonicalContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase()
}
