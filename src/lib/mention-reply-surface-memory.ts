// Surface memory apply — the Linear-side resolver for the mention-reply answer.
//
// Keeps the installation-id + numeric-repo-id resolution (and the flag gate) out
// of the already-large mention-reply.ts. Returns the rendered ORG∪REPO learnings
// block to inject into the answer prompt, or "" (flag off / no repo mapping /
// unresolvable installation / load failure). Never throws.
//
// Cross-tenant: `installationId` comes ONLY from the trusted tenant / static
// installation mapping (never message content) — matching the org-teach capture
// block in mention-reply.ts — and the numeric `repoId` from the live D1 repo
// registry. SEAT/personal memory is never read here (org + repo scope only).

import { renderSurfaceMemoryForPrompt, resolveSurfaceMemoryApplyMode } from "@/src/features/learnings"
import { lookupRepoByFullName } from "@/src/features/tenancy"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"

export async function renderLinearSurfaceMemory(args: {
  env: Env
  teamRepo: { owner: string; repo: string } | null
  tenant: { installationId: number } | undefined
}): Promise<string> {
  const { env, teamRepo, tenant } = args
  // OFF is a true no-op: no installation resolution, no D1 lookup, no KV read.
  if (resolveSurfaceMemoryApplyMode(env) === "off" || !teamRepo) return ""

  // installationId resolution mirrors the org-teach capture block: the trusted
  // tenant first, else the static installation map (skipped for broker orgs,
  // whose static map is not authoritative).
  const inst = tenant
    ? { ok: true as const, installationId: tenant.installationId }
    : env.LINEAR_TOKEN_BROKER
      ? { ok: false as const }
      : resolveInstallation(teamRepo.owner, teamRepo.repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  if (!inst.ok) return ""

  // The D1 lookup is the one fallible await outside renderSurfaceMemoryForPrompt's
  // own try/catch — guard it so a D1 fault degrades to org-only (or ""), never
  // throwing into handleMention and dropping the whole reply (belt-and-suspenders,
  // matching org-apply.ts even though lookupRepoByFullName is contracted not to throw).
  try {
    const repoLookup = await lookupRepoByFullName(env, `${teamRepo.owner}/${teamRepo.repo}`)
    return await renderSurfaceMemoryForPrompt({
      env,
      installationId: inst.installationId,
      repoId: repoLookup?.repoId ?? null,
    })
  } catch {
    return ""
  }
}
