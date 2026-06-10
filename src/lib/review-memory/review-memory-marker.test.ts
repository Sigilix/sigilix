// ARC-189 — Sigilix comment marker tests (Task 2).

import { describe, it, expect } from "vitest"
import {
  buildSigilixMarker,
  extractSigilixMarker,
  computeFid,
  computePathSha256,
  computeClaimId,
  hydrateClaimIds,
  truncateHashHex,
  categoryFromRoleHint,
  markerSeverityFromScore,
} from "@/lib/review-memory/marker"

describe("buildSigilixMarker — determinism + sensitivity", () => {
  it("emits the same marker for the same inputs", async () => {
    const args = {
      ruleId: "no-eval-call",
      path: "src/lib/foo.ts",
      line: 42,
      headline: "Avoid eval()",
      category: "security" as const,
      severity: "error" as const,
    }
    const a = await buildSigilixMarker(args)
    const b = await buildSigilixMarker(args)
    expect(a).toBe(b)
  })

  it("differs when ruleId changes", async () => {
    const base = {
      path: "src/lib/foo.ts",
      line: 42,
      headline: "Avoid eval()",
      category: "security" as const,
      severity: "error" as const,
    }
    const a = await buildSigilixMarker({ ...base, ruleId: "no-eval-call" })
    const b = await buildSigilixMarker({ ...base, ruleId: "no-throw-literal" })
    expect(a).not.toBe(b)
  })

  it("differs when path changes (different fid AND different path-hash)", async () => {
    const base = {
      ruleId: null,
      line: 42,
      headline: "Avoid eval()",
      category: "security" as const,
      severity: "error" as const,
    }
    const a = await buildSigilixMarker({ ...base, path: "src/lib/a.ts" })
    const b = await buildSigilixMarker({ ...base, path: "src/lib/b.ts" })
    expect(a).not.toBe(b)
  })

  it("differs when line changes", async () => {
    const base = {
      ruleId: "x",
      path: "src/lib/foo.ts",
      headline: "h",
      category: "logic" as const,
      severity: "warning" as const,
    }
    const a = await buildSigilixMarker({ ...base, line: 10 })
    const b = await buildSigilixMarker({ ...base, line: 11 })
    expect(a).not.toBe(b)
  })

  it("differs when headline changes", async () => {
    const base = {
      ruleId: "x",
      path: "src/lib/foo.ts",
      line: 1,
      category: "logic" as const,
      severity: "warning" as const,
    }
    const a = await buildSigilixMarker({ ...base, headline: "first" })
    const b = await buildSigilixMarker({ ...base, headline: "second" })
    expect(a).not.toBe(b)
  })

  it("treats null ruleId as the literal sentinel `none` (Codex MINOR on plan v2)", async () => {
    const base = {
      path: "src/lib/foo.ts",
      line: 1,
      headline: "h",
      category: "logic" as const,
      severity: "info" as const,
    }
    const nullVariant = await buildSigilixMarker({ ...base, ruleId: null })
    const sentinelVariant = await buildSigilixMarker({ ...base, ruleId: "none" })
    // Both must be a stable marker (not crash), but they collide
    // because we canonicalize null → "none". This is an acceptable
    // collision: a finding with no ruleId AND a finding with literal
    // ruleId="none" produce the same fid bucket. Documented in the
    // spec.
    expect(nullVariant).toBe(sentinelVariant)
    const otherRule = await buildSigilixMarker({ ...base, ruleId: "X" })
    expect(nullVariant).not.toBe(otherRule)
  })

  it("emits exactly the canonical 16-char fid + 12-char path hex widths", async () => {
    const m = await buildSigilixMarker({
      ruleId: "no-eval-call",
      path: "src/lib/foo.ts",
      line: 42,
      headline: "Avoid eval()",
      category: "security",
      severity: "error",
    })
    // <!-- sigilix:fid:<16hex>:cat:<cat>:sev:<sev>:path:<12hex> -->
    expect(m).toMatch(
      /^<!-- sigilix:fid:[0-9a-f]{16}:cat:(security|logic|performance|tests):sev:(info|warning|error):path:[0-9a-f]{12} -->$/,
    )
  })
})

describe("extractSigilixMarker — happy paths", () => {
  it("parses a well-formed marker on its own line at end of body", async () => {
    const body = [
      "## Performance concern",
      "",
      "Consider memoizing this.",
      "",
      "<!-- sigilix:fid:abc1234567890def:cat:performance:sev:warning:path:d4e5f6a7b8c9 -->",
    ].join("\n")
    const m = extractSigilixMarker(body)
    expect(m).not.toBeNull()
    expect(m).toEqual({
      fid: "abc1234567890def",
      cat: "performance",
      sev: "warning",
      pathSha12: "d4e5f6a7b8c9",
    })
  })

  it("returns the LAST sigilix marker if multiple are present (defensive)", () => {
    const body = [
      "<!-- sigilix:fid:1111111111111111:cat:logic:sev:info:path:111111111111 -->",
      "Some text",
      "<!-- sigilix:fid:2222222222222222:cat:security:sev:error:path:222222222222 -->",
    ].join("\n")
    const m = extractSigilixMarker(body)
    expect(m?.fid).toBe("2222222222222222")
  })

  it("coexists with ARC-181 AST audit markers", () => {
    const body = [
      "<!-- ast/no-eval-call/abc1234/42 -->",
      "<!-- sigilix:fid:abc1234567890def:cat:security:sev:error:path:d4e5f6a7b8c9 -->",
    ].join("\n")
    const m = extractSigilixMarker(body)
    expect(m?.cat).toBe("security")
  })
})

describe("extractSigilixMarker — rejection paths", () => {
  it("returns null for empty body", () => {
    expect(extractSigilixMarker("")).toBeNull()
  })

  it("returns null for body without any marker", () => {
    expect(extractSigilixMarker("Some text without markers.")).toBeNull()
  })

  it("returns null when fid is the wrong length (15 hex)", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890de:cat:security:sev:error:path:d4e5f6a7b8c9 -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })

  it("returns null when path-hash is the wrong length (11 hex)", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:security:sev:error:path:d4e5f6a7b8c -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })

  it("returns null when fid contains non-hex chars", () => {
    const body =
      "<!-- sigilix:fid:zzzzzzzzzzzzzzzz:cat:security:sev:error:path:d4e5f6a7b8c9 -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })

  it("returns null when category is unknown", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:bogus:sev:error:path:d4e5f6a7b8c9 -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })

  it("returns null when severity is unknown", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:security:sev:critical:path:d4e5f6a7b8c9 -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })

  it("returns null when a field is missing", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:security:path:d4e5f6a7b8c9 -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })

  it("ignores ARC-181 AST markers (different format, no false-positive match)", () => {
    const body = "<!-- ast/no-eval-call/abc1234/42 -->"
    expect(extractSigilixMarker(body)).toBeNull()
  })
})

describe("SIG-276 — claims marker segment (build + round-trip)", () => {
  const base = {
    ruleId: null,
    path: "src/lib/foo.ts",
    line: 42,
    headline: "Helper has no test",
    category: "tests" as const,
    severity: "warning" as const,
  }

  it("appends a :claims: segment when claims are provided", async () => {
    const m = await buildSigilixMarker({
      ...base,
      claims: [
        { type: "structural-glue-not-test-target", confidence: 0.85, extractorVersion: 1 },
      ],
    })
    expect(m).toContain(":claims:structural-glue-not-test-target~85~1")
    expect(m.endsWith(" -->")).toBe(true)
  })

  it("omits the :claims: segment for an empty claims array", async () => {
    const m = await buildSigilixMarker({ ...base, claims: [] })
    expect(m).not.toContain(":claims:")
  })

  it("round-trips a single claim through build → extract", async () => {
    const m = await buildSigilixMarker({
      ...base,
      claims: [
        { type: "auth-gate-is-boundary", confidence: 0.6, extractorVersion: 1 },
      ],
    })
    const parsed = extractSigilixMarker(m)
    expect(parsed?.claims).toEqual([
      { type: "auth-gate-is-boundary", confidence: 0.6, extractorVersion: 1 },
    ])
  })

  it("round-trips multiple claims preserving order", async () => {
    const m = await buildSigilixMarker({
      ...base,
      claims: [
        { type: "structural-glue-not-test-target", confidence: 0.9, extractorVersion: 2 },
        { type: "rethrowing-catch-not-swallowed", confidence: 0.55, extractorVersion: 2 },
      ],
    })
    const parsed = extractSigilixMarker(m)
    expect(parsed?.claims).toEqual([
      { type: "structural-glue-not-test-target", confidence: 0.9, extractorVersion: 2 },
      { type: "rethrowing-catch-not-swallowed", confidence: 0.55, extractorVersion: 2 },
    ])
  })

  it("caps serialization at 3 claims even if more are passed", async () => {
    const m = await buildSigilixMarker({
      ...base,
      claims: [
        { type: "auth-gate-is-boundary", confidence: 0.9, extractorVersion: 1 },
        { type: "structural-glue-not-test-target", confidence: 0.9, extractorVersion: 1 },
        { type: "globally-unique-id-is-tenant-isolation", confidence: 0.9, extractorVersion: 1 },
        { type: "rethrowing-catch-not-swallowed", confidence: 0.9, extractorVersion: 1 },
      ],
    })
    const parsed = extractSigilixMarker(m)
    expect(parsed?.claims).toHaveLength(3)
  })

  it("coexists with a :loc: segment (both parse)", async () => {
    const m = await buildSigilixMarker({
      ...base,
      loc: "inline",
      claims: [
        { type: "auth-gate-is-boundary", confidence: 0.7, extractorVersion: 1 },
      ],
    })
    const parsed = extractSigilixMarker(m)
    expect(parsed?.loc).toBe("inline")
    expect(parsed?.claims).toEqual([
      { type: "auth-gate-is-boundary", confidence: 0.7, extractorVersion: 1 },
    ])
  })

  it("legacy marker (no claims) parses WITHOUT a claims key", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:performance:sev:warning:path:d4e5f6a7b8c9 -->"
    const parsed = extractSigilixMarker(body)
    expect(parsed).toEqual({
      fid: "abc1234567890def",
      cat: "performance",
      sev: "warning",
      pathSha12: "d4e5f6a7b8c9",
    })
    expect(parsed).not.toHaveProperty("claims")
  })

  it("drops an unknown claim type on parse (forward-compat)", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:tests:sev:warning:path:d4e5f6a7b8c9:claims:future-claim-not-yet-known~80~3,auth-gate-is-boundary~70~1 -->"
    const parsed = extractSigilixMarker(body)
    expect(parsed?.claims).toEqual([
      { type: "auth-gate-is-boundary", confidence: 0.7, extractorVersion: 1 },
    ])
  })

  it("drops the whole claims key when every entry is malformed", () => {
    const body =
      "<!-- sigilix:fid:abc1234567890def:cat:tests:sev:warning:path:d4e5f6a7b8c9:claims:bogus~zz~q -->"
    const parsed = extractSigilixMarker(body)
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty("claims")
  })
})

describe("computeFid + computePathSha256 — primitives", () => {
  it("computeFid produces 16 lowercase hex chars", async () => {
    const fid = await computeFid({
      ruleId: "x",
      path: "p",
      line: 1,
      headline: "h",
    })
    expect(fid).toMatch(/^[0-9a-f]{16}$/)
  })

  it("computeFid is stable for the same input", async () => {
    const args = { ruleId: "x", path: "p", line: 1, headline: "h" }
    const a = await computeFid(args)
    const b = await computeFid(args)
    expect(a).toBe(b)
  })

  it("computeFid differs across input changes", async () => {
    const a = await computeFid({ ruleId: "x", path: "p", line: 1, headline: "h" })
    const b = await computeFid({ ruleId: "y", path: "p", line: 1, headline: "h" })
    expect(a).not.toBe(b)
  })

  it("computePathSha256 produces a full 64-hex digest", async () => {
    const h = await computePathSha256("src/lib/foo.ts")
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it("computePathSha256 stable for the same path", async () => {
    const a = await computePathSha256("src/lib/foo.ts")
    const b = await computePathSha256("src/lib/foo.ts")
    expect(a).toBe(b)
  })

  it("computePathSha256 differs for different paths", async () => {
    const a = await computePathSha256("src/lib/foo.ts")
    const b = await computePathSha256("src/lib/bar.ts")
    expect(a).not.toBe(b)
  })
})

describe("truncateHashHex — strict literal width", () => {
  it("truncates to 12 hex chars", () => {
    const full = "abcdef0123456789abcdef0123456789"
    expect(truncateHashHex(full, 12)).toBe("abcdef012345")
  })
  it("truncates to 16 hex chars", () => {
    const full = "abcdef0123456789abcdef0123456789"
    expect(truncateHashHex(full, 16)).toBe("abcdef0123456789")
  })
})

describe("categoryFromRoleHint — 1:1 role/category mapping", () => {
  it.each([
    ["security", "security"],
    ["logic", "logic"],
    ["performance", "performance"],
    ["tests", "tests"],
  ] as const)(`maps role %s → category %s`, (role, cat) => {
    expect(categoryFromRoleHint(role)).toBe(cat)
  })
})

describe("markerSeverityFromScore — score → severity-tier banding", () => {
  it("score 5 → error", () => {
    expect(markerSeverityFromScore(5)).toBe("error")
  })
  it("score 4 → warning", () => {
    expect(markerSeverityFromScore(4)).toBe("warning")
  })
  it("score 3 → warning", () => {
    expect(markerSeverityFromScore(3)).toBe("warning")
  })
  it("score 2 → info", () => {
    expect(markerSeverityFromScore(2)).toBe("info")
  })
  it("score 1 → info", () => {
    expect(markerSeverityFromScore(1)).toBe("info")
  })
  it("clamps out-of-range high (score 99) → error", () => {
    expect(markerSeverityFromScore(99)).toBe("error")
  })
  it("clamps out-of-range low (score 0) → info", () => {
    expect(markerSeverityFromScore(0)).toBe("info")
  })
})

describe("SIG-276 PR B — claim id hydration", () => {
  it("computeClaimId returns 16 lowercase hex chars", async () => {
    const id = await computeClaimId({
      type: "auth-gate-is-boundary",
      confidence: 0.8,
      extractorVersion: 1,
    })
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("computeClaimId is stable for the same type+version and ignores confidence", async () => {
    const a = await computeClaimId({ type: "auth-gate-is-boundary", confidence: 0.8, extractorVersion: 1 })
    const b = await computeClaimId({ type: "auth-gate-is-boundary", confidence: 0.2, extractorVersion: 1 })
    expect(a).toBe(b)
  })

  it("computeClaimId differs by type", async () => {
    const a = await computeClaimId({ type: "auth-gate-is-boundary", confidence: 0.8, extractorVersion: 1 })
    const b = await computeClaimId({ type: "rethrowing-catch-not-swallowed", confidence: 0.8, extractorVersion: 1 })
    expect(a).not.toBe(b)
  })

  it("computeClaimId differs by extractorVersion", async () => {
    const a = await computeClaimId({ type: "auth-gate-is-boundary", confidence: 0.8, extractorVersion: 1 })
    const b = await computeClaimId({ type: "auth-gate-is-boundary", confidence: 0.8, extractorVersion: 2 })
    expect(a).not.toBe(b)
  })

  it("hydrateClaimIds adds a 16-hex id and preserves the other fields", async () => {
    const out = await hydrateClaimIds([
      { type: "auth-gate-is-boundary", confidence: 0.7, extractorVersion: 1 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: "auth-gate-is-boundary",
      confidence: 0.7,
      extractorVersion: 1,
    })
    expect(out[0]!.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("hydrateClaimIds([]) returns []", async () => {
    expect(await hydrateClaimIds([])).toEqual([])
  })

  it("round-trips marker claims → extract → hydrate into full claims", async () => {
    const m = await buildSigilixMarker({
      ruleId: null,
      path: "src/x.ts",
      line: 1,
      headline: "h",
      category: "tests",
      severity: "warning",
      claims: [{ type: "structural-glue-not-test-target", confidence: 0.9, extractorVersion: 1 }],
    })
    const parsed = extractSigilixMarker(m)
    const hydrated = await hydrateClaimIds(parsed!.claims!)
    const expectedId = await computeClaimId({
      type: "structural-glue-not-test-target",
      confidence: 0.9,
      extractorVersion: 1,
    })
    expect(hydrated).toEqual([
      {
        id: expectedId,
        type: "structural-glue-not-test-target",
        confidence: 0.9,
        extractorVersion: 1,
      },
    ])
  })
})
