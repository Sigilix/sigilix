import { isRunnerToolId, rolesForRunnerTool, type RunnerToolId } from "@/src/shared/domain/runner-tool-catalog"
import type { RoleHint } from "./types"

export { RUNNER_TOOL_IDS } from "@/src/shared/domain/runner-tool-catalog"
export type { RunnerToolId } from "@/src/shared/domain/runner-tool-catalog"

export const RUNNER_METADATA_SCHEMA_VERSION = 1
export const RUNNER_METADATA_SOURCE = "deterministic-tool"

export type RunnerMetadataSource = typeof RUNNER_METADATA_SOURCE
export type RunnerMetadataErrorReason = "absent-metadata" | "unknown-schema-version" | "unknown-tool" | "invalid-source"

export interface RunnerDroppedResults {
  toolId: RunnerToolId
  droppedCount: number
  keptCount?: number
}

export interface RunnerMetadata {
  schemaVersion: typeof RUNNER_METADATA_SCHEMA_VERSION
  toolId: RunnerToolId
  source: RunnerMetadataSource
  roleHints: RoleHint[]
  droppedResults?: RunnerDroppedResults
}

export type ParseRunnerMetadataResult =
  | { ok: true; metadata: RunnerMetadata }
  | {
      ok: false
      reason: RunnerMetadataErrorReason
      schemaVersion?: unknown
      toolId?: unknown
      source?: unknown
    }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseDroppedResults(value: unknown, toolId: RunnerToolId): RunnerDroppedResults | undefined {
  if (!isObject(value)) return undefined
  const droppedCount = value.droppedCount
  if (typeof droppedCount !== "number" || !Number.isFinite(droppedCount) || droppedCount < 0) return undefined
  const dropped: RunnerDroppedResults = { toolId, droppedCount }
  if (typeof value.keptCount === "number" && Number.isFinite(value.keptCount) && value.keptCount >= 0) {
    dropped.keptCount = value.keptCount
  }
  return dropped
}

export function roleHintsForRunnerTool(toolId: RunnerToolId): RoleHint[] {
  return rolesForRunnerTool(toolId) as RoleHint[]
}

export function parseRunnerMetadata(properties: unknown): ParseRunnerMetadataResult {
  if (!isObject(properties)) return { ok: false, reason: "absent-metadata" }

  const schemaVersion = properties.sigilixSchemaVersion
  const toolId = properties.sigilixToolId
  const source = properties.sigilixSource
  if (schemaVersion === undefined || toolId === undefined || source === undefined) {
    return { ok: false, reason: "absent-metadata" }
  }
  if (schemaVersion !== RUNNER_METADATA_SCHEMA_VERSION) {
    return { ok: false, reason: "unknown-schema-version", schemaVersion }
  }
  if (!isRunnerToolId(toolId)) {
    return { ok: false, reason: "unknown-tool", toolId }
  }
  if (source !== RUNNER_METADATA_SOURCE) {
    return { ok: false, reason: "invalid-source", source }
  }

  const droppedResults = parseDroppedResults(properties.sigilixDroppedResults, toolId)
  const metadata: RunnerMetadata = {
    schemaVersion: RUNNER_METADATA_SCHEMA_VERSION,
    toolId,
    source: RUNNER_METADATA_SOURCE,
    roleHints: roleHintsForRunnerTool(toolId),
  }
  if (droppedResults !== undefined) metadata.droppedResults = droppedResults
  return { ok: true, metadata }
}
