export type LinearContextMode = "auto" | "enabled" | "disabled"
export type LinearScopeMode = "auto" | "explicit"
export type LinearCreateIssueMode = "manual" | "disabled" | "auto"

export interface LinearWritebackConfig {
  comments: boolean
  status: boolean
  labels: boolean
}

export interface LinearConfig {
  revision: number
  contextMode: LinearContextMode
  scope: { mode: LinearScopeMode; teamIds: string[] }
  prValidation: boolean
  createIssue: LinearCreateIssueMode
  planning: boolean
  writeback: LinearWritebackConfig
}

export interface LinearConfigInput {
  revision: number
  contextMode: LinearContextMode
  scope: { mode: LinearScopeMode; teamIds: string[] }
  prValidation: boolean
  createIssue: LinearCreateIssueMode
  planning: boolean
  writeback: LinearWritebackConfig
}

export const DEFAULT_LINEAR_CONFIG: LinearConfig = {
  revision: 1,
  contextMode: "auto",
  scope: { mode: "auto", teamIds: [] },
  prValidation: false,
  createIssue: "manual",
  planning: true,
  writeback: { comments: true, status: false, labels: true },
}

export type LinearConfigValidation =
  | { ok: true; value: LinearConfigInput }
  | {
      ok: false
      reason:
        | "invalid-shape"
        | "invalid-revision"
        | "invalid-context-mode"
        | "invalid-scope"
        | "invalid-create-issue"
        | "unsafe-feature-dark"
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse the closed portal contract. Unknown keys are rejected by exact key
 * checks so a UI cannot appear to persist a setting the runtime ignores.
 * `prValidation` and automatic issue creation intentionally remain dark until
 * their tenant-safe runtime paths exist; accepting true would be dishonest.
 */
export function validateLinearConfigInput(raw: unknown): LinearConfigValidation {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-shape" }
  const keys = Object.keys(raw).sort().join(",")
  if (keys !== "contextMode,createIssue,planning,prValidation,revision,scope,writeback") {
    return { ok: false, reason: "invalid-shape" }
  }
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) <= 0) {
    return { ok: false, reason: "invalid-revision" }
  }
  if (raw.contextMode !== "auto" && raw.contextMode !== "enabled" && raw.contextMode !== "disabled") {
    return { ok: false, reason: "invalid-context-mode" }
  }
  if (!isRecord(raw.scope)) return { ok: false, reason: "invalid-scope" }
  if (Object.keys(raw.scope).sort().join(",") !== "mode,teamIds") return { ok: false, reason: "invalid-scope" }
  if (raw.scope.mode !== "auto" && raw.scope.mode !== "explicit") return { ok: false, reason: "invalid-scope" }
  if (!Array.isArray(raw.scope.teamIds)) return { ok: false, reason: "invalid-scope" }
  const teamIds = raw.scope.teamIds
  if (
    teamIds.some((id) => typeof id !== "string" || id.trim() === "" || id.length > 128) ||
    new Set(teamIds).size !== teamIds.length ||
    (raw.scope.mode === "explicit" && teamIds.length === 0) ||
    (raw.scope.mode === "auto" && teamIds.length !== 0)
  ) {
    return { ok: false, reason: "invalid-scope" }
  }
  if (raw.createIssue !== "manual" && raw.createIssue !== "disabled" && raw.createIssue !== "auto") {
    return { ok: false, reason: "invalid-create-issue" }
  }
  if (
    typeof raw.prValidation !== "boolean" ||
    typeof raw.planning !== "boolean" ||
    !isRecord(raw.writeback) ||
    Object.keys(raw.writeback).sort().join(",") !== "comments,labels,status" ||
    typeof raw.writeback.comments !== "boolean" ||
    typeof raw.writeback.status !== "boolean" ||
    typeof raw.writeback.labels !== "boolean"
  ) {
    return { ok: false, reason: "invalid-shape" }
  }
  if (raw.prValidation || raw.createIssue === "auto" || raw.writeback.status) {
    return { ok: false, reason: "unsafe-feature-dark" }
  }
  return {
    ok: true,
    value: {
      revision: Number(raw.revision),
      contextMode: raw.contextMode,
      scope: { mode: raw.scope.mode, teamIds: teamIds.map((id) => id.trim()) },
      prValidation: false,
      createIssue: raw.createIssue,
      planning: raw.planning,
      writeback: { comments: raw.writeback.comments, status: false, labels: raw.writeback.labels },
    },
  }
}

export function teamIsSelected(config: LinearConfig, teamId: string): boolean {
  return config.scope.mode === "auto" || config.scope.teamIds.includes(teamId)
}

export function codebaseContextEnabled(config: LinearConfig): boolean {
  return config.contextMode !== "disabled"
}
