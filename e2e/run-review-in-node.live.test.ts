// SIG-304 (review CLI) — Phase-0 seam proof: the review engine runs HEADLESS in
// Node (no Cloudflare bindings), returns a built verdict via the `dryRun` payload,
// and POSTS NOTHING. Live (needs GITHUB_TOKEN + OPENROUTER_API_KEY) → SKIPS in CI
// (`npm run build`) so the gate stays green; run manually to validate the seam.
//
//   GITHUB_TOKEN="$(gh auth token)" \
//   OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY' .dev.vars | cut -d= -f2-)" \
//   npx vitest run e2e/run-review-in-node.live.test.ts
//
// Override the fixture PR with REVIEW_FIXTURE_OWNER/REPO/PR (default: the closed
// recall-probe PR Sigilix/sigilix-monitor#70, which has a small multi-bug diff).

import { describe, it, expect } from "vitest"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { GitHubClient } from "@/src/shared/adapters/github"
import { createLocalEnv } from "@/src/cli/adapters/local-env"

const GH_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const OR_KEY = process.env.OPENROUTER_API_KEY
const FIXTURE = {
  owner: process.env.REVIEW_FIXTURE_OWNER ?? "Sigilix",
  repo: process.env.REVIEW_FIXTURE_REPO ?? "sigilix-monitor",
  prNumber: Number(process.env.REVIEW_FIXTURE_PR ?? 70),
}

// READ methods pass through to the real client; EVERYTHING else (create/submit/
// update/delete/dismiss/add/reply/resolve …) is recorded + NO-OP'd, so a stray write
// on any code path can neither post to GitHub nor escape the assertion.
const READ_PREFIX = /^(get|list|search|restGet|fetch)/

function recordingClient(real: GitHubClient): { client: GitHubClient; writeCalls: string[] } {
  const writeCalls: string[] = []
  const client = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function" || typeof prop !== "string") return value
      if (READ_PREFIX.test(prop)) return (value as (...a: unknown[]) => unknown).bind(target)
      return (...args: unknown[]) => {
        writeCalls.push(`${prop}(${args.length})`)
        return Promise.resolve(undefined)
      }
    },
  })
  return { client, writeCalls }
}

describe.skipIf(!GH_TOKEN || !OR_KEY)("SIG-304 — headless dry-run review (engine decoupling seam)", () => {
  it("runs the engine in Node, returns a verdict, and posts NOTHING", async () => {
    const real = new GitHubClient({ token: GH_TOKEN! })
    const meta = await real.getPullRequest(FIXTURE.owner, FIXTURE.repo, FIXTURE.prNumber)
    const headSha = meta.head?.sha
    expect(headSha, "fixture PR must resolve a head sha").toBeTruthy()

    const { client, writeCalls } = recordingClient(real)
    const env = createLocalEnv({
      processEnv: { ...process.env, OPENROUTER_API_KEY: OR_KEY, OLLAMA_CHAT_ENABLE: "on" },
    })

    const result = await handlePrReviewEnsemble({
      owner: FIXTURE.owner,
      repo: FIXTURE.repo,
      prNumber: FIXTURE.prNumber,
      headSha: headSha!,
      installationId: 0, // unused: githubClient is injected → buildClient is bypassed
      env,
      githubClient: client,
      dryRun: true,
      forceFullCoverage: true, // single-shot CLI: no cross-run KV → avoid SIG-459 empty-delta
    })

    // The dry-run cut returns "skipped" with the built review attached.
    expect(result.status).toBe("skipped")
    expect(result.dryRunReview, "dry-run must return the built review").toBeDefined()
    expect(result.dryRunReview!.verdict.findings.length).toBeGreaterThan(0)
    // The whole point: a headless dry-run performs ZERO GitHub writes.
    expect(writeCalls).toEqual([])
  }, 300_000)
})
