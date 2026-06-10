import { describe, expect, it } from "vitest"
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

// Sigilix bot P1 (PR #176): the badge glyph generator is a thin
// node-side script around opentype.js. End-to-end unit testing would
// require running the font extraction + comparing pixel output, which
// is out of scope. These structural checks pin that the three moving
// parts (generator script, source TTF, generated module) all exist
// and that the generated module identifies its origin — enough to
// catch an accidental deletion or a hand-edit that drops the
// "DO NOT EDIT BY HAND" banner.
describe("badge glyph generator — structural sanity (SIG-216 fix-up)", () => {
  const REPO_ROOT = resolve(__dirname, "..")
  const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/generate-badge-glyph-paths.ts")
  const FONT_PATH = resolve(REPO_ROOT, "assets/fonts/GeistMono-Medium.ttf")
  const GENERATED_PATH = resolve(REPO_ROOT, "src/lib/badge-glyph-paths.ts")

  it("generator script exists at scripts/generate-badge-glyph-paths.ts", () => {
    expect(statSync(SCRIPT_PATH).isFile()).toBe(true)
  })

  it("Geist Mono Medium TTF source exists at assets/fonts/GeistMono-Medium.ttf", () => {
    expect(statSync(FONT_PATH).isFile()).toBe(true)
  })

  it("generated module exists at src/lib/badge-glyph-paths.ts", () => {
    expect(statSync(GENERATED_PATH).isFile()).toBe(true)
  })

  it("generated module's header identifies the generator script", () => {
    const source = readFileSync(GENERATED_PATH, "utf8")
    expect(source).toContain("generate-badge-glyph-paths.ts")
  })
})
