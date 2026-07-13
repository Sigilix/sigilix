import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import type { ScmProviderKind } from "@/src/lib/ensemble/ports"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"

export async function resolveReviewClient(args: {
  scmProvider: ScmProviderKind
  env: Env
  installationId: number
  injectedClient?: GitHubClient
}): Promise<GitHubClient> {
  switch (args.scmProvider) {
    case "github":
      return args.injectedClient ?? (await buildClient(args.env, args.installationId))
    case "gitlab":
      if (args.injectedClient === undefined) {
        throw new Error("GitLab reviews require an injected GitLab client")
      }
      return args.injectedClient
    default:
      throw new Error(`Unsupported SCM provider: ${String(args.scmProvider satisfies never)}`)
  }
}
