// SIG-107 audit fix — end-to-end coverage for config-parse-error VISIBILITY
// on the main (webhook-driven) PR-review path.
//
// Before this fix, `fetchDiffAndConfig` swallowed a present-but-malformed
// `sigilix.json` with ZERO signal (no log, no comment) — worse than the
// slash-command dispatch path (`/improve`, `/describe`), which already posts
// an idempotent parse-error PR comment via `postConfigErrorComment`
// (`sigilix-config-error-comment.ts`). This suite proves the review path now
// reuses that SAME mechanism, while staying fail-open (EMPTY_CONFIG either
// way) and NOT changing behavior for an absent or a valid config.

import { describe, expect, it, vi } from "vitest"

import { fetchDiffAndConfig, type FetchDiffTelemetry } from "@/src/lib/ensemble/app/context/fetch-and-pack"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { ListOpenPullsItem, IssueComment } from "@/src/shared/types/github"

function makeEnv(): Env {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { OPENCLAW_STATE: kv } as unknown as Env
}

/** A minimal `GitHubClient` stub: `sigilix.json` resolves to `configRaw` (or
 * 404/null), everything else needed by `fetchDiffAndConfig` + a fired
 * `postConfigErrorComment` is a cheap no-network stub. */
function makeClient(configRaw: string | null): { client: GitHubClient; createIssueComment: ReturnType<typeof vi.fn> } {
  const createIssueComment = vi.fn(async () => ({ id: 1 }))
  const client = {
    getPullRequestDiff: async () => "",
    listOpenPullRequests: async (): Promise<ListOpenPullsItem[]> => [],
    getFileContent: async (_owner: string, _repo: string, path: string): Promise<string | null> =>
      path === "sigilix.json" ? configRaw : null,
    listIssueComments: async (): Promise<IssueComment[]> => [],
    createIssueComment,
  } as unknown as GitHubClient
  return { client, createIssueComment }
}

const ARGS_BASE = {
  scmProvider: "github" as const,
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "h".repeat(40),
  ensembleConfig: parseEnsembleConfig({}),
}

describe("fetchDiffAndConfig — config parse-error visibility (SIG-107)", () => {
  it("present-but-malformed config: posts the visible parse-error PR comment, still fails open", async () => {
    const { client, createIssueComment } = makeClient("{ not valid json")
    const telemetry: FetchDiffTelemetry = {}

    const result = await fetchDiffAndConfig({ env: makeEnv(), client, ...ARGS_BASE, telemetry })

    // Fail-open: the review proceeds on EMPTY_CONFIG regardless.
    expect(result.sigilixConfig).toEqual({})
    // Visible: the SAME idempotent comment mechanism the slash-command path
    // uses fires here too (fire-and-forget — wait for the async post).
    await vi.waitFor(() => expect(createIssueComment).toHaveBeenCalledTimes(1))
    const [, , , body] = createIssueComment.mock.calls[0] as [string, string, number, string]
    expect(body).toContain("Sigilix config parse error")
    expect(body).toContain("couldn't be parsed")
  })

  it("absent config (no sigilix.json): normal — posts nothing", async () => {
    const { client, createIssueComment } = makeClient(null)
    const telemetry: FetchDiffTelemetry = {}

    const result = await fetchDiffAndConfig({ env: makeEnv(), client, ...ARGS_BASE, telemetry })

    expect(result.sigilixConfig).toEqual({})
    // Give any stray async work a chance to run before asserting silence.
    await new Promise((r) => setTimeout(r, 0))
    expect(createIssueComment).not.toHaveBeenCalled()
  })

  it("valid config: posts nothing and resolves the real fields", async () => {
    const { client, createIssueComment } = makeClient(JSON.stringify({ guidance: "be nice" }))
    const telemetry: FetchDiffTelemetry = {}

    const result = await fetchDiffAndConfig({ env: makeEnv(), client, ...ARGS_BASE, telemetry })

    expect(result.sigilixConfig.guidance).toBe("be nice")
    await new Promise((r) => setTimeout(r, 0))
    expect(createIssueComment).not.toHaveBeenCalled()
  })
})
