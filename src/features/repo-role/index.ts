// repo-role feature barrel — the ONLY legal cross-feature/cross-unit import
// surface. External consumers reach this feature via `@/src/features/repo-role`;
// its internal `domain/` layer stays private behind this re-export. No logic here.

export { classifyRepoRole, computeRepoRole, isRepoRole, REPO_ROLES } from "./domain/classify"
export type { RepoRole } from "./domain/classify"
export { gatherRepoRoleSignals } from "./domain/signals"
export type { RepoRoleSignals, RepoRoleMarkers, RepoRolePackageJsonSignals } from "./domain/signals"
