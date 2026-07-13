import { resolveRuntimeApp, type RuntimeAppId } from "@/src/shared/domain/runtime-app-registry"

export type AppMemoryScope = "personal" | "organization"
export type ManagedAppId = RuntimeAppId | "cli" | "gitlab"

export interface AppMemory {
  id: string
  installationId: number
  scope: AppMemoryScope
  ownerUserId: string
  appId: ManagedAppId
  content: string
  createdAtMs: number
}

export const MAX_APP_MEMORY_CONTENT_LENGTH = 2000
export const MAX_APP_MEMORIES_PER_SCOPE = 100

export function resolveManagedAppId(value: unknown): ManagedAppId | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  // CLI and the native GitLab connector are not MCP runtime apps, but both are
  // first-class context surfaces with app detail pages in the portal.
  if (normalized === "cli" || normalized === "gitlab") return normalized
  return resolveRuntimeApp(normalized)?.id ?? null
}

export function parseAppMemoryScope(value: unknown): AppMemoryScope | null {
  return value === "personal" || value === "organization" ? value : null
}

export function normalizeAppMemoryContent(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > MAX_APP_MEMORY_CONTENT_LENGTH) return null
  return normalized
}
