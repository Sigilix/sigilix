// ARC-174 — `sigilix.json` per-repo config: parse + load behavior.
//
// Tests the pure parser (`parseSigilixConfig`) directly and the I/O
// wrapper (`loadSigilixConfig`) with a mocked GitHubClient. The
// fail-open contract is critical — a malformed config must NEVER
// break a PR review, only fall back to EMPTY_CONFIG.

import { describe, it, expect, vi } from "vitest"

import {
  parseSigilixConfig,
  resolvePathInstructionsForChangedPaths,
  renderPathInstructionsForPrompt,
  loadSigilixConfig,
  EMPTY_CONFIG,
  SIGILIX_CONFIG_PATH,
  type SigilixConfig,
} from "@/src/lib/sigilix-config"
import type { GitHubClient } from "@/src/shared/adapters/github"

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

  it("preserves an explicit empty customLabels allowlist", () => {
    const result = parseSigilixConfig(JSON.stringify({ customLabels: [] }))
    expect(result).toEqual({ customLabels: [] })
  })

  it("does not treat fully-invalid non-empty customLabels as an empty allowlist", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        customLabels: [{ name: "bug" }],
      }),
    )
    expect(result).toEqual({})
  })

  it("drops empty-string guidance (treats as absent)", () => {
    expect(parseSigilixConfig(JSON.stringify({ guidance: "" }))).toEqual({})
  })

  it("drops empty-string per-role rules (treats as absent)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        rules: { logic: "", security: "real" },
      }),
    )
    expect(result).toEqual({ rules: { security: "real" } })
  })

  it("drops the rules block entirely when every role is empty/absent", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        rules: { logic: "", security: "", performance: "", tests: "" },
      }),
    )
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
    const result = parseSigilixConfig(
      JSON.stringify({
        guidance: 42,
        rules: "not-an-object",
      }),
    )
    expect(result).toEqual({})
  })

  it("drops non-string per-role rule values", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        rules: { logic: 42, security: "real-string", performance: null, tests: ["array"] },
      }),
    )
    expect(result).toEqual({ rules: { security: "real-string" } })
  })

  it("ignores rule keys that aren't a known specialist role", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        rules: { logic: "real", unknownRole: "ignored" },
      }),
    )
    expect(result).toEqual({ rules: { logic: "real" } })
  })
})

// ─── ARC-176 v2 fields: pathFilters + profile ────────────────────────

describe("parseSigilixConfig — pathFilters (ARC-176)", () => {
  it("accepts an array of glob patterns", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        pathFilters: ["dist/**", "**/*.lock", "!critical/important.lock"],
      }),
    )
    expect(result?.pathFilters).toEqual(["dist/**", "**/*.lock", "!critical/important.lock"])
  })

  it("drops empty-string entries", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        pathFilters: ["", "dist/**", ""],
      }),
    )
    expect(result?.pathFilters).toEqual(["dist/**"])
  })

  it("drops the array entirely when all entries are empty/non-string", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        pathFilters: ["", null, 42, ""],
      }),
    )
    expect(result?.pathFilters).toBeUndefined()
  })

  it("ignores pathFilters when not an array", () => {
    expect(parseSigilixConfig(JSON.stringify({ pathFilters: "dist/**" }))?.pathFilters).toBeUndefined()
    expect(parseSigilixConfig(JSON.stringify({ pathFilters: { glob: "x" } }))?.pathFilters).toBeUndefined()
  })
})

describe("parseSigilixConfig — pathInstructions", () => {
  const codePoints = (s: string): number => [...s].length

  it("accepts path-scoped guidance with role-specific rules", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          {
            paths: [" src/auth/** ", "src/auth/**", "workers/**"],
            guidance: " Treat as security-sensitive request handling. ",
            rules: {
              security: "Block missing authorization checks.",
              tests: "Require integration tests for auth flows.",
              unknown: "ignored",
            },
          },
        ],
      }),
    )
    expect(result?.pathInstructions).toEqual([
      {
        paths: ["src/auth/**", "workers/**"],
        guidance: "Treat as security-sensitive request handling.",
        rules: {
          security: "Block missing authorization checks.",
          tests: "Require integration tests for auth flows.",
        },
      },
    ])
  })

  it("accepts CodeRabbit-shaped path/instructions aliases", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          {
            path: "tests/**",
            instructions: "Review test names and edge cases.",
          },
        ],
      }),
    )
    expect(result?.pathInstructions).toEqual([
      {
        paths: ["tests/**"],
        guidance: "Review test names and edge cases.",
      },
    ])
  })

  it("drops malformed or empty path instruction entries", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          null,
          { paths: [] },
          { paths: ["src/**"], guidance: "" },
          { paths: ["src/**"], rules: { security: "" } },
          { paths: ["src/**"], rules: { logic: "Real rule." } },
        ],
      }),
    )
    expect(result?.pathInstructions).toEqual([
      {
        paths: ["src/**"],
        rules: { logic: "Real rule." },
      },
    ])
  })

  it("caps pathInstructions at 20 entries", () => {
    const below = Array.from({ length: 19 }, (_, i) => ({
      paths: [`src/below-${i}/**`],
      guidance: "below",
    }))
    expect(parseSigilixConfig(JSON.stringify({ pathInstructions: below }))?.pathInstructions).toHaveLength(19)

    const at = Array.from({ length: 20 }, (_, i) => ({
      paths: [`src/at-${i}/**`],
      guidance: "at",
    }))
    expect(parseSigilixConfig(JSON.stringify({ pathInstructions: at }))?.pathInstructions).toHaveLength(20)

    const above = Array.from({ length: 21 }, (_, i) => ({
      paths: [`src/above-${i}/**`],
      guidance: "above",
    }))
    const result = parseSigilixConfig(JSON.stringify({ pathInstructions: above }))
    expect(result?.pathInstructions).toHaveLength(20)
    expect(resolvePathInstructionsForChangedPaths(result, ["src/above-19/file.ts"])).toHaveLength(1)
    expect(resolvePathInstructionsForChangedPaths(result, ["src/above-20/file.ts"])).toHaveLength(0)
  })

  it("caps each pathInstructions entry at 50 paths", () => {
    const makePaths = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `src/${prefix}/${i}/**`)
    const result = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          { paths: makePaths("below", 49), guidance: "below" },
          { paths: makePaths("at", 50), guidance: "at" },
          { paths: makePaths("above", 51), guidance: "above" },
        ],
      }),
    )

    expect(result?.pathInstructions?.[0]?.paths).toHaveLength(49)
    expect(result?.pathInstructions?.[1]?.paths).toHaveLength(50)
    expect(result?.pathInstructions?.[2]?.paths).toHaveLength(50)
    expect(resolvePathInstructionsForChangedPaths(result, ["src/above/49/file.ts"])).toHaveLength(1)
    expect(resolvePathInstructionsForChangedPaths(result, ["src/above/50/file.ts"])).toHaveLength(0)
  })

  it("truncates pathInstructions guidance and role rules to 4000 code points", () => {
    const below = "b".repeat(3999)
    const at = "a".repeat(4000)
    const above = "x".repeat(4001)
    const result = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          { paths: ["src/below/**"], guidance: below, rules: { security: below } },
          { paths: ["src/at/**"], guidance: at, rules: { security: at } },
          { paths: ["src/above/**"], guidance: above, rules: { security: above } },
        ],
      }),
    )

    expect(codePoints(result?.pathInstructions?.[0]?.guidance ?? "")).toBe(3999)
    expect(codePoints(result?.pathInstructions?.[0]?.rules?.security ?? "")).toBe(3999)
    expect(codePoints(result?.pathInstructions?.[1]?.guidance ?? "")).toBe(4000)
    expect(codePoints(result?.pathInstructions?.[1]?.rules?.security ?? "")).toBe(4000)
    expect(codePoints(result?.pathInstructions?.[2]?.guidance ?? "")).toBe(4000)
    expect(codePoints(result?.pathInstructions?.[2]?.rules?.security ?? "")).toBe(4000)

    const matches = resolvePathInstructionsForChangedPaths(result, ["src/above/file.ts"])
    const block = renderPathInstructionsForPrompt(matches, "security")
    expect(block).toContain(`Guidance: ${"x".repeat(4000)}`)
    expect(block).toContain(`security rule: ${"x".repeat(4000)}`)
  })
})

describe("resolvePathInstructionsForChangedPaths", () => {
  it("returns only instructions whose globs match changed paths", () => {
    const config = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          { paths: ["src/auth/**"], guidance: "Auth rules." },
          { paths: ["docs/**"], guidance: "Docs rules." },
        ],
      }),
    )
    const matches = resolvePathInstructionsForChangedPaths(config, [
      "src/auth/login.ts",
      "src/auth/session.ts",
      "src/ui/button.ts",
    ])
    expect(matches).toEqual([
      {
        paths: ["src/auth/**"],
        matchedPaths: ["src/auth/login.ts", "src/auth/session.ts"],
        guidance: "Auth rules.",
      },
    ])
  })
})

describe("renderPathInstructionsForPrompt", () => {
  it("renders role-specific rules without leaking unrelated role rules", () => {
    const config = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          {
            paths: ["src/auth/**"],
            rules: {
              security: "Block unsafe token handling.",
              tests: "Require auth-flow coverage.",
            },
          },
        ],
      }),
    )
    const matches = resolvePathInstructionsForChangedPaths(config, ["src/auth/login.ts"])
    const securityBlock = renderPathInstructionsForPrompt(matches, "security")
    expect(securityBlock).toContain("[PATH-SCOPED REVIEW GUIDANCE (from sigilix.json)]")
    expect(securityBlock).toContain("security rule: Block unsafe token handling.")
    expect(securityBlock).not.toContain("tests rule")

    const logicBlock = renderPathInstructionsForPrompt(matches, "logic")
    expect(logicBlock).toBe("")
  })

  it("renders all matched role rules for the synthesizer", () => {
    const config = parseSigilixConfig(
      JSON.stringify({
        pathInstructions: [
          {
            paths: ["src/auth/**"],
            guidance: "Auth code is sensitive.",
            rules: {
              security: "Block unsafe token handling.",
              tests: "Require auth-flow coverage.",
            },
          },
        ],
      }),
    )
    const matches = resolvePathInstructionsForChangedPaths(config, ["src/auth/login.ts"])
    const block = renderPathInstructionsForPrompt(matches)
    expect(block).toContain("Guidance: Auth code is sensitive.")
    expect(block).toContain("security rule: Block unsafe token handling.")
    expect(block).toContain("tests rule: Require auth-flow coverage.")
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
    const client = fakeClient(
      vi.fn().mockResolvedValue(
        JSON.stringify({
          guidance: "Be terse.",
          rules: { logic: "Flag long fns." },
        }),
      ),
    )
    const result = await loadSigilixConfig(client, "owner", "repo", "deadbeef")
    expect(result).toEqual<SigilixConfig>({
      guidance: "Be terse.",
      rules: { logic: "Flag long fns." },
    })
  })
})
