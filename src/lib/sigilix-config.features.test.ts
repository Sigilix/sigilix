// ARC-174 — `sigilix.json` config: per-feature toggle parsing.
//
// overview.enabled / evidence.visible / labels.enabled / describe.enabled /
// commands schema + resolveCommandConfig / depVulnScan.enabled.

import { describe, it, expect } from "vitest"
import {
  isPrOverviewEnabled,
  isFindingEvidenceVisible,
  isPrLabelsEnabled,
  parseSigilixConfig,
  parseSigilixConfigDetailed,
  resolveCommandConfig,
  KNOWN_MODELS,
  type SigilixConfig,
} from "@/src/lib/sigilix-config"

describe("parseSigilixConfig — overview.enabled (SIG-84)", () => {
  it("parses overview.enabled === true", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        overview: { enabled: true },
      }),
    )
    expect(result).toEqual({ overview: { enabled: true } })
  })

  it("parses overview.enabled === false", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        overview: { enabled: false },
      }),
    )
    expect(result).toEqual({ overview: { enabled: false } })
  })

  it('strips a string `"false"` (strict boolean — no JS truthy nonsense)', () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        overview: { enabled: "false" },
      }),
    )
    expect(result).toEqual({})
  })

  it("strips a number 0 (strict boolean)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        overview: { enabled: 0 },
      }),
    )
    expect(result).toEqual({})
  })

  it("strips a top-level overview value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ overview: "yes" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ overview: true }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ overview: [] }))).toEqual({})
  })

  it("ignores unknown subfields under overview (forward-compat)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        overview: { enabled: false, profile: "future-field" },
      }),
    )
    expect(result).toEqual({ overview: { enabled: false } })
  })

  describe("isPrOverviewEnabled resolver — defaults to ENABLED (opt-OUT polarity)", () => {
    it("missing config → enabled", () => {
      expect(isPrOverviewEnabled(null)).toBe(true)
      expect(isPrOverviewEnabled({})).toBe(true)
    })

    it("config without `overview` field → enabled", () => {
      expect(isPrOverviewEnabled({ guidance: "x" })).toBe(true)
    })

    it("overview with no `enabled` flag → enabled (default)", () => {
      expect(isPrOverviewEnabled({ overview: {} })).toBe(true)
    })

    it("overview.enabled === true → enabled", () => {
      expect(isPrOverviewEnabled({ overview: { enabled: true } })).toBe(true)
    })

    it("overview.enabled === false → disabled", () => {
      expect(isPrOverviewEnabled({ overview: { enabled: false } })).toBe(false)
    })
  })
})

describe("parseSigilixConfig — evidence.visible (SIG-112)", () => {
  it("parses evidence.visible === true", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        evidence: { visible: true },
      }),
    )
    expect(result).toEqual({ evidence: { visible: true } })
  })

  it("parses evidence.visible === false", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        evidence: { visible: false },
      }),
    )
    expect(result).toEqual({ evidence: { visible: false } })
  })

  it("strips non-boolean evidence.visible values", () => {
    expect(parseSigilixConfig(JSON.stringify({ evidence: { visible: "true" } }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ evidence: { visible: 1 } }))).toEqual({})
  })

  it("strips a top-level evidence value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ evidence: "on" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ evidence: true }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ evidence: [] }))).toEqual({})
  })

  it("ignores unknown subfields under evidence (forward-compat)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        evidence: { visible: true, density: "future-field" },
      }),
    )
    expect(result).toEqual({ evidence: { visible: true } })
  })

  describe("isFindingEvidenceVisible resolver — defaults to HIDDEN", () => {
    it("missing config + missing env → hidden", () => {
      expect(isFindingEvidenceVisible(null, {})).toBe(false)
      expect(isFindingEvidenceVisible({}, {})).toBe(false)
    })

    it("evidence.visible === true → visible", () => {
      expect(isFindingEvidenceVisible({ evidence: { visible: true } }, {})).toBe(true)
    })

    it("evidence.visible === false → hidden unless env forces it", () => {
      expect(isFindingEvidenceVisible({ evidence: { visible: false } }, {})).toBe(false)
      expect(isFindingEvidenceVisible({ evidence: { visible: false } }, { OPENCLAW_SHOW_EVIDENCE: "on" })).toBe(true)
    })

    it("env override is exact and case-sensitive", () => {
      expect(isFindingEvidenceVisible(null, { OPENCLAW_SHOW_EVIDENCE: "on" })).toBe(true)
      expect(isFindingEvidenceVisible(null, { OPENCLAW_SHOW_EVIDENCE: "ON" })).toBe(false)
    })
  })
})

describe("parseSigilixConfig — labels.enabled (SIG-135)", () => {
  it("parses labels.enabled === true", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        labels: { enabled: true },
      }),
    )
    expect(result).toEqual({ labels: { enabled: true } })
  })

  it("parses labels.enabled === false", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        labels: { enabled: false },
      }),
    )
    expect(result).toEqual({ labels: { enabled: false } })
  })

  it('strips a string `"false"` (strict boolean)', () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        labels: { enabled: "false" },
      }),
    )
    expect(result).toEqual({})
  })

  it("strips a top-level labels value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ labels: "off" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ labels: false }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ labels: [] }))).toEqual({})
  })

  it("ignores unknown subfields under labels (forward-compat)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        labels: { enabled: false, strategy: "future-field" },
      }),
    )
    expect(result).toEqual({ labels: { enabled: false } })
  })

  describe("isPrLabelsEnabled resolver — defaults to ENABLED (opt-OUT polarity)", () => {
    it("missing config → enabled", () => {
      expect(isPrLabelsEnabled(null)).toBe(true)
      expect(isPrLabelsEnabled({})).toBe(true)
    })

    it("labels with no `enabled` flag → enabled (default)", () => {
      expect(isPrLabelsEnabled({ labels: {} })).toBe(true)
    })

    it("labels.enabled === true → enabled", () => {
      expect(isPrLabelsEnabled({ labels: { enabled: true } })).toBe(true)
    })

    it("labels.enabled === false → disabled", () => {
      expect(isPrLabelsEnabled({ labels: { enabled: false } })).toBe(false)
    })
  })
})

describe("parseSigilixConfig — describe.enabled (ARC-191)", () => {
  it("parses describe.enabled === true", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        describe: { enabled: true },
      }),
    )
    expect(result).toEqual({ describe: { enabled: true } })
  })

  it("parses describe.enabled === false", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        describe: { enabled: false },
      }),
    )
    expect(result).toEqual({ describe: { enabled: false } })
  })

  it('strips a string `"false"` (strict boolean — no JS truthy nonsense)', () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        describe: { enabled: "false" },
      }),
    )
    expect(result).toEqual({})
  })

  it("strips a number 0 (strict boolean)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        describe: { enabled: 0 },
      }),
    )
    expect(result).toEqual({})
  })

  it("strips a top-level describe value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ describe: "yes" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ describe: true }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ describe: [] }))).toEqual({})
  })

  it("ignores unknown subfields under describe (forward-compat)", () => {
    const result = parseSigilixConfig(
      JSON.stringify({
        describe: { enabled: false, futureField: "ignored" },
      }),
    )
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

  it("accepts Kimi K2.7 Code as a current command model override", () => {
    const raw = JSON.stringify({
      commands: { review: { model: { primary: "kimi-k2.7-code:cloud" } } },
    })
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.commands?.review?.model?.primary).toBe("kimi-k2.7-code:cloud")
  })

  it("rejects retired Kimi K2.6 as a command model override", () => {
    const raw = JSON.stringify({
      commands: { review: { model: { primary: "kimi-k2.6:cloud" } } },
    })
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown model|not in.*registry/i)
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
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { reviews: { prompt: { addendum: "x" } } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown command/i)
    expect(result.reason).toContain("reviews")
  })

  it("rejects addendum > 4000 code points", () => {
    const long = "a".repeat(4001)
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { prompt: { addendum: long } } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/addendum.*length|too long/i)
  })

  it("accepts addendum exactly 4000 code points", () => {
    const exact = "a".repeat(4000)
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { prompt: { addendum: exact } } },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it("counts addendum length in code points (surrogate-pair safe)", () => {
    // Each emoji is 2 UTF-16 code units but 1 code point.
    // 2001 emoji = 2001 code points (under cap), but 4002 UTF-16 units.
    const emoji = "😀"
    const addendum = emoji.repeat(2001)
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { prompt: { addendum } } },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it("rejects whitespace-only model.primary", () => {
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { model: { primary: "   " } } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/model.primary/i)
  })

  it("rejects non-array fallbacks", () => {
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { model: { fallbacks: "x" } } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/fallbacks.*array of strings/i)
  })

  it("rejects >4 fallback entries", () => {
    // Pad with duplicates if KNOWN_MODELS has fewer than 5 entries.
    const tooMany = [KNOWN, KNOWN, KNOWN, KNOWN, KNOWN]
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { model: { primary: KNOWN, fallbacks: tooMany } } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/fallbacks.*4 entries|at most 4/i)
  })

  it("rejects unknown model names (not in registry)", () => {
    const result = parseSigilixConfigDetailed(
      JSON.stringify({
        commands: { review: { model: { primary: "definitely-not-a-real-model" } } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown model|not in.*registry/i)
  })

  it("BACK-COMPAT: parseSigilixConfig still returns null on the same bad inputs", () => {
    const bad = JSON.stringify({ commands: ["review"] })
    expect(parseSigilixConfig(bad)).toBeNull()
    const bad2 = JSON.stringify({
      commands: { review: { prompt: { addendum: "a".repeat(5000) } } },
    })
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
    const out = resolveCommandConfig({ commands: { improve: { prompt: { addendum: "x" } } } }, "improve")
    expect(out.promptAddendum).toBe("x")
  })

  it("captures the model primary", () => {
    const out = resolveCommandConfig({ commands: { improve: { model: { primary: KNOWN } } } }, "improve")
    expect(out.modelPrimary).toBe(KNOWN)
  })

  it("EXPLICIT EMPTY fallbacks → use defaults (override: false)", () => {
    const out = resolveCommandConfig({ commands: { improve: { model: { fallbacks: [] } } } }, "improve")
    expect(out.modelFallbacks).toEqual({ override: false })
  })

  it("non-empty fallbacks → override: true with the array", () => {
    const fallbacks = [...KNOWN_MODELS].slice(0, 2)
    const out = resolveCommandConfig({ commands: { improve: { model: { fallbacks } } } }, "improve")
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

  it('STRICT-BOOL: string "false" does NOT disable', () => {
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
    const result = parseSigilixConfig(
      JSON.stringify({
        depVulnScan: { enabled: false, futureField: "ignored" },
      }),
    )
    expect(result).toEqual({ depVulnScan: { enabled: false } })
  })

  it("strips a top-level depVulnScan value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ depVulnScan: "off" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ depVulnScan: false }))).toEqual({})
  })
})
