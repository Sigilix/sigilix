// ARC-174 — `sigilix.json` per-repo config: parse + load behavior.
//
// Tests the pure parser (`parseSigilixConfig`) directly and the I/O
// wrapper (`loadSigilixConfig`) with a mocked GitHubClient. The
// fail-open contract is critical — a malformed config must NEVER
// break a PR review, only fall back to EMPTY_CONFIG.

import { describe, it, expect, vi } from "vitest"

import {
  parseSigilixConfig,
  loadSigilixConfig,
  EMPTY_CONFIG,
  SIGILIX_CONFIG_PATH,
  type SigilixConfig,
} from "../src/lib/sigilix-config"
import type { GitHubClient } from "../src/lib/github"

// Build a minimal stub of GitHubClient that only implements the one
// method we exercise. Cast through `unknown` because we don't want to
// pull in the full client surface (auth, JWT, octokit shape, etc.).
function fakeClient(getFileContent: GitHubClient["getFileContent"]): GitHubClient {
  return { getFileContent } as unknown as GitHubClient
}

describe("parseSigilixConfig — happy paths", () => {
  it("returns guidance + rules for a fully populated config", () => {
    const raw = JSON.stringify({
      guidance: "This repo is a TS Cloudflare Worker. Reject any new class declarations.",
      rules: {
        logic: "Flag any function over 50 lines.",
        security: "Always check token handling.",
        performance: "Reject sync I/O in request handlers.",
        tests: "Require at least one test per new exported function.",
      },
    })
    const result = parseSigilixConfig(raw)
    expect(result).toEqual({
      guidance: "This repo is a TS Cloudflare Worker. Reject any new class declarations.",
      rules: {
        logic: "Flag any function over 50 lines.",
        security: "Always check token handling.",
        performance: "Reject sync I/O in request handlers.",
        tests: "Require at least one test per new exported function.",
      },
    })
  })

  it("accepts guidance-only configs", () => {
    const result = parseSigilixConfig(JSON.stringify({ guidance: "Be terse." }))
    expect(result).toEqual({ guidance: "Be terse." })
  })

  it("accepts rules-only configs", () => {
    const result = parseSigilixConfig(JSON.stringify({ rules: { security: "X" } }))
    expect(result).toEqual({ rules: { security: "X" } })
  })

  it("accepts an empty object as a valid (no-op) config", () => {
    const result = parseSigilixConfig("{}")
    expect(result).toEqual({})
  })

  it("ignores unknown top-level fields (forward-compat)", () => {
    const raw = JSON.stringify({
      guidance: "X",
      futureField: "ignored",
      ignore: ["should/not/error.ts"], // future scope, currently dropped
    })
    const result = parseSigilixConfig(raw)
    expect(result).toEqual({ guidance: "X" })
  })

  it("drops empty-string guidance (treats as absent)", () => {
    expect(parseSigilixConfig(JSON.stringify({ guidance: "" }))).toEqual({})
  })

  it("drops empty-string per-role rules (treats as absent)", () => {
    const result = parseSigilixConfig(JSON.stringify({
      rules: { logic: "", security: "real" },
    }))
    expect(result).toEqual({ rules: { security: "real" } })
  })

  it("drops the rules block entirely when every role is empty/absent", () => {
    const result = parseSigilixConfig(JSON.stringify({
      rules: { logic: "", security: "", performance: "", tests: "" },
    }))
    expect(result).toEqual({})
  })
})

describe("parseSigilixConfig — defensive returns null", () => {
  it("returns null on invalid JSON", () => {
    expect(parseSigilixConfig("not json {")).toBeNull()
    expect(parseSigilixConfig("")).toBeNull()
  })

  it("returns null on a top-level array (must be an object)", () => {
    expect(parseSigilixConfig("[]")).toBeNull()
    expect(parseSigilixConfig('[{"guidance":"X"}]')).toBeNull()
  })

  it("returns null on a top-level scalar", () => {
    expect(parseSigilixConfig("42")).toBeNull()
    expect(parseSigilixConfig('"hello"')).toBeNull()
    expect(parseSigilixConfig("null")).toBeNull()
    expect(parseSigilixConfig("true")).toBeNull()
  })

  it("silently drops fields with the wrong type rather than failing", () => {
    // Non-string guidance, non-object rules, non-string rule values —
    // all dropped without erroring (forward-compat: unknown future
    // shapes shouldn't break review pipelines).
    const result = parseSigilixConfig(JSON.stringify({
      guidance: 42,
      rules: "not-an-object",
    }))
    expect(result).toEqual({})
  })

  it("drops non-string per-role rule values", () => {
    const result = parseSigilixConfig(JSON.stringify({
      rules: { logic: 42, security: "real-string", performance: null, tests: ["array"] },
    }))
    expect(result).toEqual({ rules: { security: "real-string" } })
  })

  it("ignores rule keys that aren't a known specialist role", () => {
    const result = parseSigilixConfig(JSON.stringify({
      rules: { logic: "real", unknownRole: "ignored" },
    }))
    expect(result).toEqual({ rules: { logic: "real" } })
  })
})

// ─── ARC-176 v2 fields: pathFilters + profile ────────────────────────

describe("parseSigilixConfig — pathFilters (ARC-176)", () => {
  it("accepts an array of glob patterns", () => {
    const result = parseSigilixConfig(JSON.stringify({
      pathFilters: ["dist/**", "**/*.lock", "!critical/important.lock"],
    }))
    expect(result?.pathFilters).toEqual(["dist/**", "**/*.lock", "!critical/important.lock"])
  })

  it("drops empty-string entries", () => {
    const result = parseSigilixConfig(JSON.stringify({
      pathFilters: ["", "dist/**", ""],
    }))
    expect(result?.pathFilters).toEqual(["dist/**"])
  })

  it("drops the array entirely when all entries are empty/non-string", () => {
    const result = parseSigilixConfig(JSON.stringify({
      pathFilters: ["", null, 42, ""],
    }))
    expect(result?.pathFilters).toBeUndefined()
  })

  it("ignores pathFilters when not an array", () => {
    expect(parseSigilixConfig(JSON.stringify({ pathFilters: "dist/**" }))?.pathFilters).toBeUndefined()
    expect(parseSigilixConfig(JSON.stringify({ pathFilters: { glob: "x" } }))?.pathFilters).toBeUndefined()
  })
})

describe("parseSigilixConfig — profile (ARC-176)", () => {
  it("accepts 'chill'", () => {
    expect(parseSigilixConfig(JSON.stringify({ profile: "chill" }))?.profile).toBe("chill")
  })

  it("accepts 'assertive'", () => {
    expect(parseSigilixConfig(JSON.stringify({ profile: "assertive" }))?.profile).toBe("assertive")
  })

  it("rejects unknown values (omits the field)", () => {
    expect(parseSigilixConfig(JSON.stringify({ profile: "savage" }))?.profile).toBeUndefined()
    expect(parseSigilixConfig(JSON.stringify({ profile: 42 }))?.profile).toBeUndefined()
    expect(parseSigilixConfig(JSON.stringify({ profile: null }))?.profile).toBeUndefined()
  })
})

describe("loadSigilixConfig — fail-open contract", () => {
  it("returns EMPTY_CONFIG when the file is missing (404 → null)", async () => {
    const client = fakeClient(vi.fn().mockResolvedValue(null))
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toBe(EMPTY_CONFIG)
  })

  it("returns EMPTY_CONFIG when the file is empty", async () => {
    const client = fakeClient(vi.fn().mockResolvedValue(""))
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toBe(EMPTY_CONFIG)
  })

  it("returns EMPTY_CONFIG when the file is whitespace only", async () => {
    const client = fakeClient(vi.fn().mockResolvedValue("   \n\t  "))
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toBe(EMPTY_CONFIG)
  })

  it("returns EMPTY_CONFIG when the JSON is malformed (no throw)", async () => {
    const client = fakeClient(vi.fn().mockResolvedValue("{not json"))
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toBe(EMPTY_CONFIG)
  })

  it("returns EMPTY_CONFIG when getFileContent throws (transient GitHub error)", async () => {
    const client = fakeClient(vi.fn().mockRejectedValue(new Error("EAI_AGAIN")))
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toBe(EMPTY_CONFIG)
  })

  it("fetches sigilix.json at the requested ref (head SHA, not the default branch)", async () => {
    const getFile = vi.fn().mockResolvedValue('{"guidance":"X"}')
    const client = fakeClient(getFile)
    await loadSigilixConfig(client, "myorg", "myrepo", "abc1234")
    expect(getFile).toHaveBeenCalledWith("myorg", "myrepo", SIGILIX_CONFIG_PATH, "abc1234")
  })

  it("returns the parsed config on the happy path", async () => {
    const client = fakeClient(vi.fn().mockResolvedValue(JSON.stringify({
      guidance: "Be terse.",
      rules: { logic: "Flag long fns." },
    })))
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toEqual<SigilixConfig>({
      guidance: "Be terse.",
      rules: { logic: "Flag long fns." },
    })
  })
})

// ─── prompt-builder integration ──────────────────────────────────────

import {
  buildSpecialistInitialMessage,
  buildSynthesizerInitialMessage,
} from "../src/prompts/pr-review-specialists"

describe("buildSpecialistInitialMessage — sigilix.json guidance injection", () => {
  const baseCtx = {
    prNumber: 42,
    title: "feat: add thing",
    body: "Adds a thing.",
    diff: "diff --git a/x.ts b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1",
    retrievalSnapshot: "",
    namespace: "myrepo",
  }

  it("renders without guidance when none is provided (current behavior)", () => {
    const msg = buildSpecialistInitialMessage(baseCtx)
    expect(msg).not.toContain("REPO GUIDANCE")
    expect(msg).toContain("[PR] #42 — feat: add thing")
  })

  it("prepends guidance in a labeled block when present", () => {
    const msg = buildSpecialistInitialMessage({
      ...baseCtx,
      guidance: "Reject any new class declarations.",
    })
    expect(msg).toContain("[REPO GUIDANCE — applies to ALL specialists (from sigilix.json)]")
    expect(msg).toContain("Reject any new class declarations.")
    // Guidance must appear BEFORE the PR header so the model treats it
    // as authoritative context, not as something to reason about.
    expect(msg.indexOf("REPO GUIDANCE")).toBeLessThan(msg.indexOf("[PR]"))
  })

  // ARC-176: profile rendering
  it("renders [REVIEW PROFILE — chill] when profile=chill", () => {
    const msg = buildSpecialistInitialMessage({ ...baseCtx, profile: "chill" })
    expect(msg).toContain("[REVIEW PROFILE — chill]")
    expect(msg).toContain("must-fix")
    expect(msg.indexOf("REVIEW PROFILE")).toBeLessThan(msg.indexOf("[PR]"))
  })

  it("renders [REVIEW PROFILE — assertive] when profile=assertive", () => {
    const msg = buildSpecialistInitialMessage({ ...baseCtx, profile: "assertive" })
    expect(msg).toContain("[REVIEW PROFILE — assertive]")
    expect(msg).toContain("nits")
  })

  it("omits the REVIEW PROFILE block entirely when profile is unset", () => {
    const msg = buildSpecialistInitialMessage(baseCtx)
    expect(msg).not.toContain("REVIEW PROFILE")
  })
})

describe("buildSynthesizerInitialMessage — sigilix.json guidance injection", () => {
  const baseCtx = {
    prNumber: 42,
    diff: "diff --git a/x.ts b/x.ts\n@@ ...",
    specialistVerdictsBlock: "=== LOGIC ===\n{}",
  }

  it("renders without guidance when none is provided (current behavior)", () => {
    const msg = buildSynthesizerInitialMessage(baseCtx)
    expect(msg).not.toContain("REPO GUIDANCE")
    expect(msg).toContain("[PR] #42")
  })

  it("prepends guidance in a labeled block when present", () => {
    const msg = buildSynthesizerInitialMessage({
      ...baseCtx,
      guidance: "Always promote security findings to score=5.",
    })
    expect(msg).toContain("[REPO GUIDANCE (from sigilix.json)]")
    expect(msg).toContain("Always promote security findings to score=5.")
    expect(msg.indexOf("REPO GUIDANCE")).toBeLessThan(msg.indexOf("[PR]"))
  })
})
