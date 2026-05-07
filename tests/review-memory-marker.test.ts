// ARC-189 — Sigilix comment marker tests (Task 2).

import { describe, it, expect } from "vitest"
import {
  buildSigilixMarker,
  extractSigilixMarker,
  computeFid,
  computePathSha256,
  truncateHashHex,
  categoryFromRoleHint,
  markerSeverityFromScore,
} from "../src/lib/review-memory/marker"

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
