import { indexNamespace, readRepoIndexManifest } from "@/src/lib/repo-index-manifest"
import type { Env } from "@/src/shared/types/env"

export interface LinearAgentRepoScope {
  repo: string | null
  mappedRepo: string | null
  availableRepos: string[]
  status: "unmapped" | "mapped_indexed" | "mapped_not_indexed" | "mapped_default_not_indexed"
}

/**
 * Resolve the indexed subset of one tenant-verified Linear binding. The
 * configured namespaces already came from the installation-scoped D1 binding;
 * the manifest check prevents stale or not-yet-indexed repos from being
 * advertised to the model or admitted by its retrieval tool.
 */
export async function resolveTenantLinearRepoScope(
  env: Env,
  teamRepo: { owner: string; repo: string } | null,
  configuredNamespaces: string[] = [],
): Promise<LinearAgentRepoScope> {
  if (!teamRepo) return { repo: null, mappedRepo: null, availableRepos: [], status: "unmapped" }
  const namespace = indexNamespace(teamRepo.owner, teamRepo.repo)
  const candidates = [...new Set([namespace, ...configuredNamespaces.map((candidate) => candidate.toLowerCase())])]
  const availableRepos = (
    await Promise.all(
      candidates.map(async (candidate) => {
        const parts = candidate.split("/")
        if (parts.length !== 2 || !parts[0] || !parts[1]) return null
        try {
          const manifest = await readRepoIndexManifest(env, parts[0], parts[1])
          return manifest.kind === "ok" ? candidate : null
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "linear-agent-repo-scope-manifest-read-failed",
              repo: candidate,
              err: err instanceof Error ? err.message : String(err),
            }),
          )
          return null
        }
      }),
    )
  ).filter((candidate): candidate is string => candidate !== null)
  const defaultIndexed = availableRepos.includes(namespace)
  return {
    repo: defaultIndexed ? namespace : null,
    mappedRepo: namespace,
    availableRepos,
    status: defaultIndexed
      ? "mapped_indexed"
      : availableRepos.length > 0
        ? "mapped_default_not_indexed"
        : "mapped_not_indexed",
  }
}
