import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

export interface RunnerToolCatalogEntry {
  id: string
  displayName: string
  roles: readonly [SpecialistRole, ...SpecialistRole[]]
  defaultEnabled: boolean
}

// Defaults mirror Sigilix/runner's current workflow_call inputs; the worker
// catalog controls config and specialist routing for cataloged tool metadata.
export const RUNNER_TOOL_CATALOG = [
  { id: "semgrep", displayName: "Semgrep", roles: ["security"], defaultEnabled: true },
  { id: "eslint", displayName: "ESLint", roles: ["logic"], defaultEnabled: true },
  { id: "tsc", displayName: "TypeScript Compiler", roles: ["logic"], defaultEnabled: true },
  { id: "ruff", displayName: "Ruff", roles: ["logic", "performance"], defaultEnabled: true },
  { id: "pylint", displayName: "Pylint", roles: ["logic"], defaultEnabled: true },
  { id: "flake8", displayName: "Flake8", roles: ["logic"], defaultEnabled: true },
  { id: "knip", displayName: "Knip", roles: ["logic"], defaultEnabled: true },
  { id: "golangci-lint", displayName: "golangci-lint", roles: ["logic"], defaultEnabled: true },
  { id: "actionlint", displayName: "actionlint", roles: ["logic", "security"], defaultEnabled: true },
  { id: "shellcheck", displayName: "ShellCheck", roles: ["security", "logic"], defaultEnabled: true },
  { id: "gitleaks", displayName: "gitleaks", roles: ["security"], defaultEnabled: true },
  { id: "osv-scanner", displayName: "OSV-Scanner", roles: ["security"], defaultEnabled: true },
  { id: "checkov", displayName: "Checkov", roles: ["security"], defaultEnabled: false },
  { id: "trivy", displayName: "Trivy", roles: ["security"], defaultEnabled: false },
  { id: "trufflehog", displayName: "TruffleHog", roles: ["security"], defaultEnabled: false },
  { id: "zizmor", displayName: "zizmor", roles: ["security", "logic"], defaultEnabled: true },
  { id: "hadolint", displayName: "Hadolint", roles: ["logic", "security"], defaultEnabled: true },
  { id: "tflint", displayName: "TFLint", roles: ["logic", "security"], defaultEnabled: true },
  { id: "biome", displayName: "Biome", roles: ["logic"], defaultEnabled: true },
  { id: "oxlint", displayName: "Oxlint", roles: ["logic"], defaultEnabled: true },
  { id: "ast-grep", displayName: "ast-grep", roles: ["logic"], defaultEnabled: true },
  { id: "regal", displayName: "Regal", roles: ["security", "logic"], defaultEnabled: true },
  { id: "htmlhint", displayName: "HTMLHint", roles: ["logic"], defaultEnabled: true },
  { id: "stylelint", displayName: "Stylelint", roles: ["logic"], defaultEnabled: true },
  { id: "yamllint", displayName: "yamllint", roles: ["logic"], defaultEnabled: true },
  { id: "markdownlint", displayName: "markdownlint", roles: ["logic"], defaultEnabled: true },
  { id: "dotenv-linter", displayName: "dotenv-linter", roles: ["security", "logic"], defaultEnabled: true },
  { id: "checkmake", displayName: "checkmake", roles: ["logic"], defaultEnabled: true },
] as const satisfies readonly RunnerToolCatalogEntry[]

export type RunnerToolId = (typeof RUNNER_TOOL_CATALOG)[number]["id"]

export const RUNNER_TOOL_IDS: readonly RunnerToolId[] = RUNNER_TOOL_CATALOG.map((entry) => entry.id)

const RUNNER_TOOL_ID_SET: ReadonlySet<string> = new Set(RUNNER_TOOL_IDS)
const SAFE_RUNNER_TOOL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RUNNER_TOOL_BY_ID: ReadonlyMap<string, RunnerToolCatalogEntry> = new Map(
  RUNNER_TOOL_CATALOG.map((entry) => [entry.id, entry]),
)

export function isRunnerToolId(value: unknown): value is RunnerToolId {
  return typeof value === "string" && RUNNER_TOOL_ID_SET.has(value)
}

export function isSafeRunnerToolId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 64 && SAFE_RUNNER_TOOL_ID_RE.test(value)
}

export function defaultEnabledForRunnerTool(toolId: RunnerToolId): boolean {
  return RUNNER_TOOL_BY_ID.get(toolId)?.defaultEnabled ?? false
}

export function rolesForRunnerTool(toolId: RunnerToolId): SpecialistRole[] {
  return [...(RUNNER_TOOL_BY_ID.get(toolId)?.roles ?? [])]
}
