import { describe, expect, it } from "vitest"

import { buildExtractionPrompt, parseExtraction } from "@/src/features/learnings/domain/extractor"

describe("buildExtractionPrompt", () => {
  it("marks inline and top-level replies as proactive extraction surfaces", () => {
    const inline = buildExtractionPrompt({
      surface: "inline-reply",
      replyText: "False positive: our controllers intentionally call the service wrapper.",
      findingContext: "Finding: direct DB call in controller",
      changedPaths: ["src/controllers/user.ts"],
    })
    const topLevel = buildExtractionPrompt({
      surface: "top-level",
      replyText: "This finding is noise for generated API clients.",
    })

    expect(inline.system).toContain("inline-reply")
    expect(inline.system).toContain("proactively extract")
    expect(inline.user).toContain("direct DB call in controller")
    expect(inline.user).toContain("src/controllers/user.ts")
    expect(topLevel.system).toContain("top-level")
    expect(topLevel.system).toContain("proactively extract")
  })

  it("requires explicit remember intent for qa surface prompts", () => {
    const { system, user } = buildExtractionPrompt({
      surface: "qa",
      replyText: "Should we always use the service layer here?",
    })

    expect(system).toContain("qa")
    expect(system).toContain("ONLY")
    expect(system).toContain("explicitly signals")
    expect(system).toContain("remember")
    expect(system).toContain("going forward")
    expect(user).toContain("Should we always use the service layer here?")
  })

  it("asks the model to classify the 4-tier memory type", () => {
    const { system } = buildExtractionPrompt({ surface: "inline-reply", replyText: "auth lives in src/auth." })
    expect(system).toContain("memoryType")
    expect(system).toContain("durable_preference")
    expect(system).toContain("architectural_fact")
    expect(system).toContain("ephemeral_project")
    expect(system).toContain("transient_feedback")
  })
})

describe("parseExtraction", () => {
  it("mints and normalizes a teachable reply JSON", () => {
    expect(
      parseExtraction(
        JSON.stringify({
          remember: true,
          rule: "  remember: Always route database writes through service-layer helpers.  ",
          polarity: "require",
          category: "logic",
          pathGlob: "src/services/**",
        }),
      ),
    ).toEqual({
      rule: "Always route database writes through service-layer helpers.",
      polarity: "require",
      category: "logic",
      pathGlob: "src/services/**",
    })
  })

  it("includes a valid memoryType suggestion and ignores an unknown one", () => {
    expect(
      parseExtraction(
        JSON.stringify({
          remember: true,
          rule: "auth lives in src/auth.",
          memoryType: "architectural_fact",
        }),
      ),
    ).toEqual({
      rule: "auth lives in src/auth.",
      polarity: "context",
      category: null,
      pathGlob: null,
      memoryType: "architectural_fact",
    })
    // An unknown/garbage memoryType is dropped (advisory) — never rejects the extraction,
    // and the returned shape stays free of the key.
    expect(
      parseExtraction(JSON.stringify({ remember: true, rule: "auth lives in src/auth.", memoryType: "nonsense" })),
    ).toEqual({
      rule: "auth lives in src/auth.",
      polarity: "context",
      category: null,
      pathGlob: null,
    })
  })

  it("returns null on acks, pure questions, remember:false, and malformed model output", () => {
    expect(parseExtraction(JSON.stringify({ remember: true, rule: "thanks, fixed" }))).toBeNull()
    expect(parseExtraction(JSON.stringify({ remember: true, rule: "Should we always wrap DB calls?" }))).toBeNull()
    expect(parseExtraction(JSON.stringify({ remember: false, rule: "Always wrap DB calls." }))).toBeNull()
    expect(parseExtraction("not json")).toBeNull()
    expect(parseExtraction(JSON.stringify({ remember: true, rule: "" }))).toBeNull()
  })

  it("defaults missing polarity to context unless the rule is clearly require or suppress", () => {
    expect(
      parseExtraction(JSON.stringify({ remember: true, rule: "Billing invariants live in docs/billing.md." })),
    ).toMatchObject({
      rule: "Billing invariants live in docs/billing.md.",
      polarity: "context",
    })
    expect(
      parseExtraction(JSON.stringify({ remember: true, rule: "Always add tests for retry loops." })),
    ).toMatchObject({
      polarity: "require",
    })
    expect(
      parseExtraction(
        JSON.stringify({
          remember: true,
          rule: "Do not flag generated API clients for missing hand-written tests.",
          pathGlob: "src/generated/**",
        }),
      ),
    ).toMatchObject({
      polarity: "suppress",
      pathGlob: "src/generated/**",
    })
  })

  it("does not mint repo-wide suppress rules without explicit blanket language", () => {
    expect(
      parseExtraction(
        JSON.stringify({
          remember: true,
          rule: "Do not flag direct database calls in controllers.",
          polarity: "suppress",
        }),
      ),
    ).toBeNull()

    expect(
      parseExtraction(
        JSON.stringify({
          remember: true,
          rule: "Do not flag direct database calls in controllers.",
          polarity: "suppress",
          category: "logic",
          pathGlob: "src/controllers/**",
        }),
      ),
    ).toEqual({
      rule: "Do not flag direct database calls in controllers.",
      polarity: "suppress",
      category: "logic",
      pathGlob: "src/controllers/**",
    })

    expect(
      parseExtraction(
        JSON.stringify({
          remember: true,
          rule: "Repo-wide, do not flag generated files for missing hand-written tests.",
          polarity: "suppress",
        }),
      ),
    ).toEqual({
      rule: "Repo-wide, do not flag generated files for missing hand-written tests.",
      polarity: "suppress",
      category: null,
      pathGlob: null,
    })
  })
})
