// GitLab SCM provider — the event->review-trigger mapping + the plaintext-token
// verify adapter. Pins that GitLab's action vocabulary maps onto GitHub's and
// delegates to the SAME pure `decidePullRequestJobs`, so the trigger decision is
// byte-identical to GitHub's (notably `reopen` -> overview-only, no re-review).

import { describe, expect, it } from "vitest"
import {
  GitLabScmProvider,
  mapGitLabActionToGitHubAction,
  resolveGitLabProjectToken,
  isGitLabProjectAllowlisted,
} from "@/src/index-gitlab-scm-provider"
import type { ScmReviewEventInput } from "@/src/lib/ensemble/ports"
import type { Env } from "@/src/shared/types/env"

function envWith(over: Partial<Env> = {}, kv: Record<string, string> = {}): Env {
  return {
    OPENCLAW_STATE: { get: async (key: string) => kv[key] ?? null } as unknown as Env["OPENCLAW_STATE"],
    ...over,
  } as unknown as Env
}

const provider = new GitLabScmProvider()

function decide(action: string, over: Partial<ScmReviewEventInput> = {}) {
  return provider.parseReviewEvent({ action, draft: false, ...over })
}

describe("mapGitLabActionToGitHubAction", () => {
  it("maps the review-triggering actions onto the GitHub vocab", () => {
    expect(mapGitLabActionToGitHubAction("open")).toBe("opened")
    expect(mapGitLabActionToGitHubAction("reopen")).toBe("reopened")
    expect(mapGitLabActionToGitHubAction("update")).toBe("synchronize")
  })

  it("returns null (skip) for non-review actions", () => {
    for (const a of ["merge", "close", "approved", "unapproved", "approval", ""]) {
      expect(mapGitLabActionToGitHubAction(a)).toBeNull()
    }
  })
})

describe("GitLabScmProvider.parseReviewEvent", () => {
  it("open -> overview + review (first review)", () => {
    expect(decide("open")).toEqual({ overview: true, review: true })
  })

  it("update -> overview + review (re-review on push)", () => {
    expect(decide("update")).toEqual({ overview: true, review: true })
  })

  it("reopen -> overview ONLY, no re-review (GitHub `reopened` parity)", () => {
    expect(decide("reopen")).toEqual({ overview: true, review: false })
  })

  it("merge / close -> skip both", () => {
    expect(decide("merge")).toEqual({ overview: false, review: false })
    expect(decide("close")).toEqual({ overview: false, review: false })
  })

  it("a draft MR skips both regardless of action", () => {
    expect(decide("open", { draft: true })).toEqual({ overview: false, review: false })
    expect(decide("update", { draft: true })).toEqual({ overview: false, review: false })
  })

  it("a `@sigilix ignore` MR description opts out of all review routing", () => {
    expect(decide("open", { prBody: "@sigilix ignore" })).toEqual({ overview: false, review: false })
  })

  it("honors the release-promotion skip when enabled (dev -> main)", () => {
    expect(decide("update", { baseRef: "main", headRef: "develop", skipReleasePromotions: true })).toEqual({
      overview: true,
      review: false,
    })
  })
})

describe("GitLabScmProvider.verifyWebhook", () => {
  it("accepts a matching token, rejects a mismatch (token in the signature field)", async () => {
    await expect(provider.verifyWebhook({ rawBody: "{}", signature: "tok", secret: "tok" })).resolves.toBe(true)
    await expect(provider.verifyWebhook({ rawBody: "{}", signature: "wrong", secret: "tok" })).resolves.toBe(false)
  })
})

describe("resolveGitLabProjectToken (per-tenant token: KV-first, global fall-back)", () => {
  it("returns the per-project KV token when present", async () => {
    const env = envWith({ SIGILIX_GITLAB_TOKEN: "global" }, { "gitlab-project-token:42": "proj-tok" })
    await expect(resolveGitLabProjectToken(env, 42)).resolves.toEqual({ token: "proj-tok", source: "per-project" })
  })

  it("falls back to the global token when no per-project entry exists", async () => {
    const env = envWith({ SIGILIX_GITLAB_TOKEN: "global" })
    await expect(resolveGitLabProjectToken(env, 42)).resolves.toEqual({ token: "global", source: "global" })
  })

  it("returns null when neither is configured", async () => {
    await expect(resolveGitLabProjectToken(envWith(), 42)).resolves.toBeNull()
  })

  it("FAILS CLOSED (rejects) on a KV read error instead of silently using the global token", async () => {
    const env = {
      SIGILIX_GITLAB_TOKEN: "global",
      OPENCLAW_STATE: {
        get: async () => {
          throw new Error("kv down")
        },
      },
    } as unknown as Env
    await expect(resolveGitLabProjectToken(env, 42)).rejects.toThrow(/kv down/)
  })
})

describe("isGitLabProjectAllowlisted (pre-launch project gate)", () => {
  it("allows all projects when no allowlist is configured (back-compat)", () => {
    expect(isGitLabProjectAllowlisted(envWith(), 42, "grp/proj", false)).toBe(true)
  })

  it("restricts to listed projects when the allowlist is set (by id or path)", () => {
    const env = envWith({ SIGILIX_GITLAB_ALLOWED_PROJECTS: "42, grp/other" })
    expect(isGitLabProjectAllowlisted(env, 42, "grp/proj", false)).toBe(true) // id match
    expect(isGitLabProjectAllowlisted(env, 7, "grp/other", false)).toBe(true) // path match
    expect(isGitLabProjectAllowlisted(env, 7, "grp/proj", false)).toBe(false) // neither
  })

  it("a per-project token implicitly allowlists even when the project isn't listed", () => {
    const env = envWith({ SIGILIX_GITLAB_ALLOWED_PROJECTS: "999" })
    expect(isGitLabProjectAllowlisted(env, 42, "grp/proj", true)).toBe(true)
  })
})
