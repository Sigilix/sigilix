// ARC-176 — shared glob compiler tests. The semantics here are
// load-bearing for both `sigilix.json` pathFilters and
// `deterministic-checks` per-rule paths; sigilix-bot caught the
// segment-boundary bug on PR #52 that we then fixed and centralized.

import { describe, it, expect } from "vitest"

import { compileGlob, pathMatchesAny, shouldReview } from "@/shared/util/path-glob"

describe("compileGlob — globstar segment boundaries", () => {
  it("`src/<gs>/foo.ts` matches src/foo.ts AND nested but NOT partial", () => {
    const r = compileGlob("src/**/foo.ts")
    expect(r.test("src/foo.ts")).toBe(true)
    expect(r.test("src/sub/foo.ts")).toBe(true)
    expect(r.test("src/a/b/c/foo.ts")).toBe(true)
    // The bug: prior `**` → `.*` translation matched these
    expect(r.test("src/barfoo.ts")).toBe(false)
    expect(r.test("src/foo.tsx")).toBe(false)
    expect(r.test("vendor/foo.ts")).toBe(false)
  })

  it("`dist/<gs>` matches dist itself AND descendants", () => {
    const r = compileGlob("dist/**")
    expect(r.test("dist")).toBe(true)
    expect(r.test("dist/index.js")).toBe(true)
    expect(r.test("dist/sub/file.js")).toBe(true)
    expect(r.test("distinct/foo.js")).toBe(false)
    expect(r.test("vendor/dist/file.js")).toBe(false)
  })

  it("bare `*` is segment-bounded", () => {
    const r = compileGlob("src/*.ts")
    expect(r.test("src/foo.ts")).toBe(true)
    expect(r.test("src/bar.ts")).toBe(true)
    // single * shouldn't cross a /
    expect(r.test("src/sub/foo.ts")).toBe(false)
  })

  it("`?` is exactly one non-slash character", () => {
    const r = compileGlob("a?c")
    expect(r.test("abc")).toBe(true)
    expect(r.test("axc")).toBe(true)
    expect(r.test("a/c")).toBe(false)
    expect(r.test("ac")).toBe(false)
    expect(r.test("abbc")).toBe(false)
  })

  it("escapes regex metacharacters in literal segments", () => {
    const r = compileGlob("a.b+c")
    expect(r.test("a.b+c")).toBe(true)
    expect(r.test("axbxc")).toBe(false)
  })
})

describe("pathMatchesAny", () => {
  it("returns true on empty pattern list (no filter = match all)", () => {
    expect(pathMatchesAny("anything", [])).toBe(true)
  })

  it("returns true if any pattern matches", () => {
    expect(pathMatchesAny("src/foo.ts", ["dist/**", "src/**"])).toBe(true)
  })

  it("returns false if no pattern matches", () => {
    expect(pathMatchesAny("vendor/foo.ts", ["dist/**", "src/**"])).toBe(false)
  })

  it("skips bad-glob patterns silently", () => {
    // Empty/malformed patterns shouldn't throw or affect the others.
    expect(pathMatchesAny("src/foo.ts", ["", "src/**"])).toBe(true)
  })
})

describe("shouldReview — pathFilters semantics", () => {
  it("returns true on empty filter list", () => {
    expect(shouldReview("anything", [])).toBe(true)
  })

  it("excludes a path matched by an exclude pattern", () => {
    expect(shouldReview("dist/foo.js", ["dist/**"])).toBe(false)
    expect(shouldReview("src/foo.ts", ["dist/**"])).toBe(true)
  })

  it("re-includes a path with `!pattern` override", () => {
    const filters = ["**/*.lock", "!critical/important.lock"]
    expect(shouldReview("yarn.lock", filters)).toBe(false)
    expect(shouldReview("package-lock.json", filters)).toBe(true)  // not a .lock pattern match
    expect(shouldReview("critical/important.lock", filters)).toBe(true)  // re-included
  })

  it("respects order — later `!pat` overrides earlier exclude", () => {
    expect(shouldReview("config/secret.json", [
      "config/**",
      "!config/secret.json",
    ])).toBe(true)
  })

  it("but later exclude beats earlier `!include`", () => {
    expect(shouldReview("dist/foo.js", [
      "!dist/foo.js",  // include without prior exclude is no-op
      "dist/**",       // then exclude
    ])).toBe(false)
  })

  it("ignores a `!` with no body", () => {
    expect(shouldReview("anything", ["!"])).toBe(true)
  })

  it("skips bad-glob patterns silently", () => {
    expect(shouldReview("src/foo.ts", ["", "dist/**"])).toBe(true)
  })

  it("skips bad-glob negation patterns silently", () => {
    expect(shouldReview("src/foo.ts", ["src/**", "!"])).toBe(false)  // exclude still applies
  })
})
