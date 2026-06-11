import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

export interface RunnerToolCatalogEntry {
  id: string
  displayName: string
  roles: readonly SpecialistRole[]
  defaultEnabled: boolean
}

export const RUNNER_TOOL_CATALOG = [
  { id: "semgrep", displayName: "Semgrep", roles: ["security"], defaultEnabled: true },
  { id: "eslint", displayName: "ESLint", roles: ["logic"], defaultEnabled: true },
  { id: "ruff", displayName: "Ruff", roles: ["logic", "performance"], defaultEnabled: true },
  { id: "actionlint", displayName: "actionlint", roles: ["logic", "security"], defaultEnabled: true },
  { id: "shellcheck", displayName: "ShellCheck", roles: ["security", "logic"], defaultEnabled: true },
  { id: "gitleaks", displayName: "gitleaks", roles: ["security"], defaultEnabled: true },
  { id: "osv-scanner", displayName: "OSV-Scanner", roles: ["security"], defaultEnabled: true },
  { id: "checkov", displayName: "Checkov", roles: ["security"], defaultEnabled: false },
  { id: "trivy", displayName: "Trivy", roles: ["security"], defaultEnabled: false },
  { id: "trufflehog", displayName: "TruffleHog", roles: ["security"], defaultEnabled: false },
  { id: "zizmor", displayName: "zizmor", roles: ["security", "logic"], defaultEnabled: false },
  { id: "hadolint", displayName: "Hadolint", roles: ["logic", "security"], defaultEnabled: false },
  { id: "tflint", displayName: "TFLint", roles: ["logic", "security"], defaultEnabled: false },
] as const satisfies readonly RunnerToolCatalogEntry[]

export type RunnerToolId = (typeof RUNNER_TOOL_CATALOG)[number]["id"]

export const RUNNER_TOOL_IDS: readonly RunnerToolId[] = RUNNER_TOOL_CATALOG.map((entry) => entry.id)

const RUNNER_TOOL_ID_SET: ReadonlySet<string> = new Set(RUNNER_TOOL_IDS)

export function isRunnerToolId(value: unknown): value is RunnerToolId {
  return typeof value === "string" && RUNNER_TOOL_ID_SET.has(value)
}

export function defaultEnabledForRunnerTool(toolId: RunnerToolId): boolean {
  return RUNNER_TOOL_CATALOG.find((entry) => entry.id === toolId)?.defaultEnabled ?? false
}

export function rolesForRunnerTool(toolId: RunnerToolId): SpecialistRole[] {
  return [...(RUNNER_TOOL_CATALOG.find((entry) => entry.id === toolId)?.roles ?? [])]
}
