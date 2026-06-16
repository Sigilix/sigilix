import type { GitHubClient } from "@/src/shared/adapters/github"

type PermissionClient = Pick<GitHubClient, "restGet">

const WRITE_PERMISSIONS = new Set(["write", "admin", "maintain"])

export async function hasRepoWriteAccess(
  client: PermissionClient,
  owner: string,
  repo: string,
  login: string | null | undefined,
): Promise<boolean> {
  const trimmedLogin = login?.trim()
  if (!trimmedLogin) return false

  try {
    const res = await client.restGet<{ permission?: string }>(
      `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(trimmedLogin)}/permission`,
    )
    return typeof res.permission === "string" && WRITE_PERMISSIONS.has(res.permission)
  } catch {
    return false
  }
}
