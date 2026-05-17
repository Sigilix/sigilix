// ARC-174 — `sigilix.json` per-repo config: parse + load behavior.
//
// Tests the pure parser (`parseSigilixConfig`) directly and the I/O
// wrapper (`loadSigilixConfig`) with a mocked GitHubClient. The
// fail-open contract is critical — a malformed config must NEVER
// break a PR review, only fall back to EMPTY_CONFIG.

import { describe, it, expect, vi } from "vitest"

import {
  parseSigilixConfig,
  parseSigilixConfigDetailed,
  passesLabelGate,
  resolveCommandConfig,
  resolveAstRulesConfig,
  resolveCostControlsConfig,
  resolveSarifEvidenceConfig,
  loadSigilixConfig,
  EMPTY_CONFIG,
  KNOWN_MODELS,
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

describe("parseSigilixConfig — describe.enabled (ARC-191)", () => {
  it("parses describe.enabled === true", () => {
    const result = parseSigilixConfig(JSON.stringify({
      describe: { enabled: true },
    }))
    expect(result).toEqual({ describe: { enabled: true } })
  })

  it("parses describe.enabled === false", () => {
    const result = parseSigilixConfig(JSON.stringify({
      describe: { enabled: false },
    }))
    expect(result).toEqual({ describe: { enabled: false } })
  })

  it('strips a string `"false"` (strict boolean — no JS truthy nonsense)', () => {
    const result = parseSigilixConfig(JSON.stringify({
      describe: { enabled: "false" },
    }))
    expect(result).toEqual({})
  })

  it("strips a number 0 (strict boolean)", () => {
    const result = parseSigilixConfig(JSON.stringify({
      describe: { enabled: 0 },
    }))
    expect(result).toEqual({})
  })

  it("strips a top-level describe value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ describe: "yes" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ describe: true }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ describe: [] }))).toEqual({})
  })

  it("ignores unknown subfields under describe (forward-compat)", () => {
    const result = parseSigilixConfig(JSON.stringify({
      describe: { enabled: false, futureField: "ignored" },
    }))
    expect(result).toEqual({ describe: { enabled: false } })
  })

  it("missing describe field → no field on output (handler treats as enabled)", () => {
    const result = parseSigilixConfig(JSON.stringify({ guidance: "x" }))
    expect(result).toEqual({ guidance: "x" })
    expect(result?.describe).toBeUndefined()
  })
})

describe("parseSigilixConfigDetailed — commands schema (ARC-185)", () => {
  // Use a real model name from the registry so happy-path tests don't
  // hit the unknown-model branch.
  const KNOWN = [...KNOWN_MODELS][0] ?? "qwen3-coder:480b-cloud"

  it("returns {ok: true} for an empty config", () => {
    const result = parseSigilixConfigDetailed("{}")
    expect(result).toEqual({ ok: true, config: {} })
  })

  it("captures commands.review.prompt.addendum", () => {
    const raw = JSON.stringify({
      commands: { review: { prompt: { addendum: "Be terse." } } },
    })
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.commands?.review?.prompt?.addendum).toBe("Be terse.")
  })

  it("captures commands.review.model.primary (after trim)", () => {
    const raw = JSON.stringify({
      commands: { review: { model: { primary: `  ${KNOWN}  ` } } },
    })
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.commands?.review?.model?.primary).toBe(KNOWN)
  })

  it("captures commands.review.model.fallbacks", () => {
    const fallbacks = [...KNOWN_MODELS].slice(0, 2)
    const raw = JSON.stringify({
      commands: { review: { model: { primary: KNOWN, fallbacks } } },
    })
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.commands?.review?.model?.fallbacks).toEqual(fallbacks)
  })

  it("rejects commands as a non-object (array)", () => {
    const result = parseSigilixConfigDetailed(JSON.stringify({ commands: ["review"] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/commands.*must be an object/i)
  })

  it("rejects commands as a non-object (string)", () => {
    const result = parseSigilixConfigDetailed(JSON.stringify({ commands: "review" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/commands.*must be an object/i)
  })

  it("rejects unknown command names (typo catching)", () => {
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { reviews: { prompt: { addendum: "x" } } },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown command/i)
    expect(result.reason).toContain("reviews")
  })

  it("rejects addendum > 4000 code points", () => {
    const long = "a".repeat(4001)
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { prompt: { addendum: long } } },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/addendum.*length|too long/i)
  })

  it("accepts addendum exactly 4000 code points", () => {
    const exact = "a".repeat(4000)
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { prompt: { addendum: exact } } },
    }))
    expect(result.ok).toBe(true)
  })

  it("counts addendum length in code points (surrogate-pair safe)", () => {
    // Each emoji is 2 UTF-16 code units but 1 code point.
    // 2001 emoji = 2001 code points (under cap), but 4002 UTF-16 units.
    const emoji = "😀"
    const addendum = emoji.repeat(2001)
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { prompt: { addendum } } },
    }))
    expect(result.ok).toBe(true)
  })

  it("rejects whitespace-only model.primary", () => {
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { model: { primary: "   " } } },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/model.primary/i)
  })

  it("rejects non-array fallbacks", () => {
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { model: { fallbacks: "x" } } },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/fallbacks.*array of strings/i)
  })

  it("rejects >4 fallback entries", () => {
    // Pad with duplicates if KNOWN_MODELS has fewer than 5 entries.
    const tooMany = [KNOWN, KNOWN, KNOWN, KNOWN, KNOWN]
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { model: { primary: KNOWN, fallbacks: tooMany } } },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/fallbacks.*4 entries|at most 4/i)
  })

  it("rejects unknown model names (not in registry)", () => {
    const result = parseSigilixConfigDetailed(JSON.stringify({
      commands: { review: { model: { primary: "definitely-not-a-real-model" } } },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown model|not in.*registry/i)
  })

  it("BACK-COMPAT: parseSigilixConfig still returns null on the same bad inputs", () => {
    const bad = JSON.stringify({ commands: ["review"] })
    expect(parseSigilixConfig(bad)).toBeNull()
    const bad2 = JSON.stringify({ commands: { review: { prompt: { addendum: "a".repeat(5000) } } } })
    expect(parseSigilixConfig(bad2)).toBeNull()
  })

  it("BACK-COMPAT: parseSigilixConfig still returns the parsed config on valid inputs (no .ok wrapper)", () => {
    const raw = JSON.stringify({
      commands: { review: { prompt: { addendum: "x" } } },
    })
    const result = parseSigilixConfig(raw)
    expect(result).toEqual({
      commands: { review: { prompt: { addendum: "x" } } },
    })
  })
})

describe("resolveCommandConfig (ARC-185)", () => {
  const KNOWN = [...KNOWN_MODELS][0] ?? "qwen3-coder:480b-cloud"

  it("null config → all defaults", () => {
    const out = resolveCommandConfig(null, "improve")
    expect(out).toEqual({
      promptAddendum: null,
      modelPrimary: null,
      modelFallbacks: { override: false },
    })
  })

  it("missing commands key → all defaults", () => {
    const out = resolveCommandConfig({}, "improve")
    expect(out.modelFallbacks).toEqual({ override: false })
  })

  it("missing per-command entry → all defaults", () => {
    const out = resolveCommandConfig({ commands: {} }, "improve")
    expect(out.modelFallbacks).toEqual({ override: false })
  })

  it("captures the addendum", () => {
    const out = resolveCommandConfig(
      { commands: { improve: { prompt: { addendum: "x" } } } },
      "improve",
    )
    expect(out.promptAddendum).toBe("x")
  })

  it("captures the model primary", () => {
    const out = resolveCommandConfig(
      { commands: { improve: { model: { primary: KNOWN } } } },
      "improve",
    )
    expect(out.modelPrimary).toBe(KNOWN)
  })

  it("EXPLICIT EMPTY fallbacks → use defaults (override: false)", () => {
    const out = resolveCommandConfig(
      { commands: { improve: { model: { fallbacks: [] } } } },
      "improve",
    )
    expect(out.modelFallbacks).toEqual({ override: false })
  })

  it("non-empty fallbacks → override: true with the array", () => {
    const fallbacks = [...KNOWN_MODELS].slice(0, 2)
    const out = resolveCommandConfig(
      { commands: { improve: { model: { fallbacks } } } },
      "improve",
    )
    expect(out.modelFallbacks).toEqual({ override: true, models: fallbacks })
  })

  it("each command resolves independently", () => {
    const config: SigilixConfig = {
      commands: {
        improve: { prompt: { addendum: "improve-text" } },
        describe: { prompt: { addendum: "describe-text" } },
      },
    }
    expect(resolveCommandConfig(config, "improve").promptAddendum).toBe("improve-text")
    expect(resolveCommandConfig(config, "describe").promptAddendum).toBe("describe-text")
    expect(resolveCommandConfig(config, "review").promptAddendum).toBeNull()
  })
})

describe("parseSigilixConfig — depVulnScan.enabled (ARC-186)", () => {
  it("captures depVulnScan.enabled: false", () => {
    const result = parseSigilixConfig(JSON.stringify({ depVulnScan: { enabled: false } }))
    expect(result?.depVulnScan?.enabled).toBe(false)
  })

  it("captures depVulnScan.enabled: true", () => {
    const result = parseSigilixConfig(JSON.stringify({ depVulnScan: { enabled: true } }))
    expect(result?.depVulnScan?.enabled).toBe(true)
  })

  it("STRICT-BOOL: string \"false\" does NOT disable", () => {
    const result = parseSigilixConfig(JSON.stringify({ depVulnScan: { enabled: "false" } }))
    expect(result?.depVulnScan).toBeUndefined()
  })

  it("STRICT-BOOL: numeric 0 does NOT disable", () => {
    const result = parseSigilixConfig(JSON.stringify({ depVulnScan: { enabled: 0 } }))
    expect(result?.depVulnScan).toBeUndefined()
  })

  it("missing depVulnScan field → undefined (handler defaults to enabled)", () => {
    const result = parseSigilixConfig(JSON.stringify({ guidance: "x" }))
    expect(result?.depVulnScan).toBeUndefined()
  })

  it("ignores unknown subfields under depVulnScan (forward-compat)", () => {
    const result = parseSigilixConfig(JSON.stringify({
      depVulnScan: { enabled: false, futureField: "ignored" },
    }))
    expect(result).toEqual({ depVulnScan: { enabled: false } })
  })

  it("strips a top-level depVulnScan value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ depVulnScan: "off" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ depVulnScan: false }))).toEqual({})
  })
})

describe("parseSigilixConfig — astRules (ARC-181)", () => {
  it("captures astRules.enabled: false", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { enabled: false } }))
    expect(r?.astRules?.enabled).toBe(false)
  })

  it("captures astRules.enabled: true", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { enabled: true } }))
    expect(r?.astRules?.enabled).toBe(true)
  })

  it("STRICT-BOOL: string \"false\" does NOT disable", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { enabled: "false" } }))
    expect(r?.astRules?.enabled).toBeUndefined()
  })

  it("captures severityThreshold for each known value", () => {
    for (const v of ["info", "warning", "error"] as const) {
      const r = parseSigilixConfig(JSON.stringify({ astRules: { severityThreshold: v } }))
      expect(r?.astRules?.severityThreshold).toBe(v)
    }
  })

  it("rejects unknown severityThreshold values", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { severityThreshold: "spicy" } }))
    expect(r?.astRules?.severityThreshold).toBeUndefined()
  })

  it("captures disabledRules string array", () => {
    const r = parseSigilixConfig(JSON.stringify({
      astRules: { disabledRules: ["no-eval-call", "no-throw-literal"] },
    }))
    expect(r?.astRules?.disabledRules).toEqual(["no-eval-call", "no-throw-literal"])
  })

  it("filters non-string entries from disabledRules", () => {
    const r = parseSigilixConfig(JSON.stringify({
      astRules: { disabledRules: ["no-eval-call", 42, null, ""] },
    }))
    expect(r?.astRules?.disabledRules).toEqual(["no-eval-call"])
  })

  it("rejects non-array disabledRules", () => {
    const r = parseSigilixConfig(JSON.stringify({
      astRules: { disabledRules: "no-eval-call" },
    }))
    expect(r?.astRules?.disabledRules).toBeUndefined()
  })

  it("captures autoInline: true", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { autoInline: true } }))
    expect(r?.astRules?.autoInline).toBe(true)
  })

  it("STRICT-BOOL: autoInline string is dropped", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { autoInline: "yes" } }))
    expect(r?.astRules?.autoInline).toBeUndefined()
  })

  it("ignores unknown subfields under astRules (forward-compat)", () => {
    const r = parseSigilixConfig(JSON.stringify({
      astRules: { enabled: true, futureField: "x" },
    }))
    expect(r?.astRules).toEqual({ enabled: true })
  })

  it("strips top-level astRules value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ astRules: "off" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ astRules: [] }))).toEqual({})
  })
})

describe("resolveAstRulesConfig (ARC-181)", () => {
  it("locks defaults when config is null", () => {
    expect(resolveAstRulesConfig(null)).toEqual({
      enabled: true,
      severityThreshold: "warning",
      disabledRules: [],
      autoInline: false,
    })
  })

  it("ABSENT-CONFIG: astRules undefined → defaults", () => {
    const cfg = parseSigilixConfig("{}")
    expect(resolveAstRulesConfig(cfg)).toEqual({
      enabled: true,
      severityThreshold: "warning",
      disabledRules: [],
      autoInline: false,
    })
  })

  it("EMPTY astRules: {} → defaults", () => {
    expect(resolveAstRulesConfig({ astRules: {} })).toEqual({
      enabled: true,
      severityThreshold: "warning",
      disabledRules: [],
      autoInline: false,
    })
  })

  it("autoInline default is false (not undefined, not true)", () => {
    expect(resolveAstRulesConfig({}).autoInline).toBe(false)
  })

  it("severityThreshold default is warning (not info)", () => {
    expect(resolveAstRulesConfig({}).severityThreshold).toBe("warning")
  })

  it("respects explicit enabled: false", () => {
    expect(resolveAstRulesConfig({ astRules: { enabled: false } }).enabled).toBe(false)
  })

  it("respects explicit autoInline: true", () => {
    expect(resolveAstRulesConfig({ astRules: { autoInline: true } }).autoInline).toBe(true)
  })

  it("returns user disabledRules array", () => {
    const out = resolveAstRulesConfig({ astRules: { disabledRules: ["a", "b"] } })
    expect(out.disabledRules).toEqual(["a", "b"])
  })
})

describe("parseSigilixConfig — sarifEvidence (ARC-188)", () => {
  it("captures sarifEvidence.enabled: false", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { enabled: false } }))
    expect(r?.sarifEvidence?.enabled).toBe(false)
  })

  it("captures sarifEvidence.path (trimmed)", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { path: "  custom/trivy.sarif.json  " } }))
    expect(r?.sarifEvidence?.path).toBe("custom/trivy.sarif.json")
  })

  it("rejects empty/whitespace-only path", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { path: "   " } }))
    expect(r?.sarifEvidence?.path).toBeUndefined()
  })

  it("captures sarifEvidence severityThreshold for each known value", () => {
    for (const v of ["info", "warning", "error"] as const) {
      const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { severityThreshold: v } }))
      expect(r?.sarifEvidence?.severityThreshold).toBe(v)
    }
  })

  it("rejects unknown sarifEvidence severityThreshold", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { severityThreshold: "spicy" } }))
    expect(r?.sarifEvidence?.severityThreshold).toBeUndefined()
  })

  it("trims + dedupes sarifEvidence disabledRules", () => {
    const r = parseSigilixConfig(JSON.stringify({
      sarifEvidence: { disabledRules: [" rule-1 ", "rule-1", "rule-2", "", 42 as unknown as string] },
    }))
    expect(r?.sarifEvidence?.disabledRules).toEqual(["rule-1", "rule-2"])
  })

  it("filters disabledCategories to known values + dedupes", () => {
    const r = parseSigilixConfig(JSON.stringify({
      sarifEvidence: { disabledCategories: ["license", "license", "vulnerability", "bogus", 42 as unknown as string] },
    }))
    expect(r?.sarifEvidence?.disabledCategories).toEqual(["license", "vulnerability"])
  })

  it("STRICT-BOOL: sarifEvidence enabled string \"false\" doesn't disable", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { enabled: "false" } }))
    expect(r?.sarifEvidence?.enabled).toBeUndefined()
  })

  it("ignores unknown sarifEvidence subfields (forward-compat)", () => {
    const r = parseSigilixConfig(JSON.stringify({
      sarifEvidence: { enabled: true, futureField: "x" },
    }))
    expect(r?.sarifEvidence).toEqual({ enabled: true })
  })

  it("strips top-level sarifEvidence value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ sarifEvidence: "on" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ sarifEvidence: [] }))).toEqual({})
  })
})

describe("resolveSarifEvidenceConfig (ARC-188)", () => {
  it("locks defaults when config is null", () => {
    expect(resolveSarifEvidenceConfig(null)).toEqual({
      enabled: true,
      path: ".sigilix/trivy.sarif.json",
      severityThreshold: "warning",
      disabledRules: [],
      disabledCategories: [],
    })
  })

  it("ABSENT-CONFIG: sarifEvidence undefined → defaults", () => {
    const cfg = parseSigilixConfig("{}")
    expect(resolveSarifEvidenceConfig(cfg)).toEqual({
      enabled: true,
      path: ".sigilix/trivy.sarif.json",
      severityThreshold: "warning",
      disabledRules: [],
      disabledCategories: [],
    })
  })

  it("EMPTY sarifEvidence: {} → defaults", () => {
    expect(resolveSarifEvidenceConfig({ sarifEvidence: {} })).toEqual({
      enabled: true,
      path: ".sigilix/trivy.sarif.json",
      severityThreshold: "warning",
      disabledRules: [],
      disabledCategories: [],
    })
  })

  it("respects explicit sarifEvidence enabled: false", () => {
    expect(resolveSarifEvidenceConfig({ sarifEvidence: { enabled: false } }).enabled).toBe(false)
  })

  it("respects custom sarifEvidence path", () => {
    expect(resolveSarifEvidenceConfig({ sarifEvidence: { path: "reports/x.sarif.json" } }).path).toBe("reports/x.sarif.json")
  })

  it("returns sarifEvidence user disabledRules + disabledCategories arrays", () => {
    const out = resolveSarifEvidenceConfig({
      sarifEvidence: { disabledRules: ["a", "b"], disabledCategories: ["license"] },
    })
    expect(out.disabledRules).toEqual(["a", "b"])
    expect(out.disabledCategories).toEqual(["license"])
  })
})

// ARC-273 — cost controls
describe("parseSigilixConfig — costControls", () => {
  it("parses maxPatchLength when in valid range", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 50_000 } }))
    expect(cfg?.costControls?.maxPatchLength).toBe(50_000)
  })

  it("rounds non-integer maxPatchLength values", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 50_000.7 } }))
    expect(cfg?.costControls?.maxPatchLength).toBe(50_001)
  })

  it("drops maxPatchLength below the floor", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 500 } }))
    expect(cfg?.costControls?.maxPatchLength).toBeUndefined()
  })

  it("drops maxPatchLength above the ceiling", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 500_000 } }))
    expect(cfg?.costControls?.maxPatchLength).toBeUndefined()
  })

  it("drops non-numeric maxPatchLength entirely", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: "many" } }))
    expect(cfg?.costControls?.maxPatchLength).toBeUndefined()
  })

  it("parses runOnLabels — trims, drops empties, dedupes", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      costControls: { runOnLabels: ["sigilix:review", "  needs-review  ", "", "sigilix:review", "ok"] },
    }))
    expect(cfg?.costControls?.runOnLabels?.sort()).toEqual(["needs-review", "ok", "sigilix:review"])
  })

  it("drops runOnLabels when every entry is non-string", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { runOnLabels: [1, 2, null] } }))
    expect(cfg?.costControls?.runOnLabels).toBeUndefined()
  })

  it("drops costControls entirely when nothing valid is present", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: -5, runOnLabels: [] } }))
    expect(cfg?.costControls).toBeUndefined()
  })

  it("returns null (not throw) on malformed costControls block", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: "oops" }))
    // costControls is dropped silently — top-level config still valid.
    expect(cfg).not.toBeNull()
    expect(cfg?.costControls).toBeUndefined()
  })
})

describe("resolveCostControlsConfig", () => {
  it("returns defaults when no config is set", () => {
    const out = resolveCostControlsConfig(null)
    expect(out.maxPatchLength).toBeGreaterThanOrEqual(1_000)
    expect(out.runOnLabels).toEqual([])
  })

  it("returns defaults when costControls is absent", () => {
    const out = resolveCostControlsConfig({})
    expect(out.maxPatchLength).toBeGreaterThanOrEqual(1_000)
    expect(out.runOnLabels).toEqual([])
  })

  it("honors operator overrides", () => {
    const out = resolveCostControlsConfig({
      costControls: { maxPatchLength: 25_000, runOnLabels: ["needs-review"] },
    })
    expect(out.maxPatchLength).toBe(25_000)
    expect(out.runOnLabels).toEqual(["needs-review"])
  })
})

describe("passesLabelGate", () => {
  it("returns true when runOnLabels is empty (no gating)", () => {
    expect(passesLabelGate([], [])).toBe(true)
    expect(passesLabelGate(["random"], [])).toBe(true)
  })

  it("returns false when PR has no labels but gate requires one", () => {
    expect(passesLabelGate([], ["sigilix:review"])).toBe(false)
  })

  it("returns true when PR carries a required label", () => {
    expect(passesLabelGate(["bug", "sigilix:review"], ["sigilix:review"])).toBe(true)
  })

  it("returns false when PR carries different labels than required", () => {
    expect(passesLabelGate(["bug", "feature"], ["sigilix:review"])).toBe(false)
  })

  it("matches case-insensitively (GitHub labels are case-sensitive but operators don't always match casing)", () => {
    expect(passesLabelGate(["Needs-Review"], ["needs-review"])).toBe(true)
    expect(passesLabelGate(["needs-review"], ["NEEDS-REVIEW"])).toBe(true)
  })

  it("passes when ANY required label matches (OR semantics, not AND)", () => {
    expect(passesLabelGate(["needs-review"], ["needs-review", "sigilix:review"])).toBe(true)
  })
})

// ARC-272 — docsReview config parsing
describe("parseSigilixConfig — docsReview", () => {
  it("parses a fully-populated docsReview block", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      docsReview: {
        enabled: true,
        architectureGlobs: ["src/lib/**", "wrangler.toml"],
        docPaths: ["README.md", "docs/**"],
      },
    }))
    expect(cfg?.docsReview?.enabled).toBe(true)
    expect(cfg?.docsReview?.architectureGlobs).toEqual(["src/lib/**", "wrangler.toml"])
    expect(cfg?.docsReview?.docPaths).toEqual(["README.md", "docs/**"])
  })

  it("strict-bool: only literal false disables", () => {
    const cfg1 = parseSigilixConfig(JSON.stringify({ docsReview: { enabled: false } }))
    expect(cfg1?.docsReview?.enabled).toBe(false)
    const cfg2 = parseSigilixConfig(JSON.stringify({ docsReview: { enabled: "false" } }))
    expect(cfg2?.docsReview?.enabled).toBeUndefined()
  })

  it("trims + dedupes glob entries", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      docsReview: { architectureGlobs: ["src/**", "  src/**  ", "lib/**"] },
    }))
    expect(cfg?.docsReview?.architectureGlobs?.sort()).toEqual(["lib/**", "src/**"])
  })

  it("drops non-string glob entries", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      docsReview: { architectureGlobs: ["src/**", 42, null, "lib/**"] },
    }))
    expect(cfg?.docsReview?.architectureGlobs?.sort()).toEqual(["lib/**", "src/**"])
  })

  it("drops docsReview entirely when nothing valid is present", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      docsReview: { architectureGlobs: [], docPaths: [] },
    }))
    expect(cfg?.docsReview).toBeUndefined()
  })

  it("returns config (not null) on malformed docsReview (silent drop)", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ docsReview: "oops" }))
    expect(cfg).not.toBeNull()
    expect(cfg?.docsReview).toBeUndefined()
  })
})
