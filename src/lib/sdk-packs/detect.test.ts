// SIG-298 follow-on — SDK guidance pack detection matrix: package.json
// dependency adds, import-specifier matches, the ≤3-pack cap, and
// relevance ordering (more matched files ranks higher).

import { describe, expect, it } from "vitest"

import { detectSdkPacks, MAX_MATCHED_PACKS } from "./detect"
import type { SdkPack } from "./types"

function pack(id: string, overrides: Partial<SdkPack> = {}): SdkPack {
  return {
    id,
    vendor: id,
    docsUrl: `https://example.com/${id}`,
    matchers: { packages: [id], importPatterns: [new RegExp(`from ["']${id}["']`)] },
    rules: [{ id: "r1", title: "t", guidance: "g", severityHint: "P2" }],
    ...overrides,
  }
}

function diffFile(path: string, addedLines: readonly string[]): string {
  const hunk = addedLines.map((l) => `+${l}`).join("\n")
  return [
    `diff --git a/${path} b/${path}`,
    "index 000..111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    hunk,
  ].join("\n")
}

describe("detectSdkPacks", () => {
  it("returns no matches for an empty or unrelated diff", () => {
    expect(detectSdkPacks("", [pack("stripe")])).toEqual([])
    const diff = diffFile("src/foo.ts", ["export const x = 1"])
    expect(detectSdkPacks(diff, [pack("stripe")])).toEqual([])
  })

  it("matches on a package.json dependency ADD", () => {
    const diff = diffFile("package.json", ['"stripe": "^14.0.0",'])
    const matched = detectSdkPacks(diff, [pack("stripe")])
    expect(matched).toHaveLength(1)
    expect(matched[0]!.pack.id).toBe("stripe")
    expect(matched[0]!.matchedPaths).toEqual(["package.json"])
  })

  it("scopes a package.json dependency match to package.json only — does not inflate matchedPaths to unrelated changed files", () => {
    const diff = [
      diffFile("package.json", ['"stripe": "^14.0.0",']),
      diffFile("src/unrelated.ts", ["export const y = 1"]),
    ].join("\n")
    const matched = detectSdkPacks(diff, [pack("stripe")])
    expect(matched).toHaveLength(1)
    // The package.json add is the only real signal — the unrelated file must
    // NOT appear in matchedPaths just because SOME file in the diff added
    // the dependency (code-reviewer catch: addedDeps is diff-wide).
    expect(matched[0]!.matchedPaths).toEqual(["package.json"])
  })

  it("does not match a package.json dependency that already existed (context line, not added)", () => {
    const diff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,3 +1,3 @@",
      ' "stripe": "^14.0.0",', // context line — no leading '+'
      "-  ",
      "+  ",
    ].join("\n")
    expect(detectSdkPacks(diff, [pack("stripe")])).toEqual([])
  })

  it("matches on an added import specifier", () => {
    const diff = diffFile("src/checkout.ts", ["import Stripe from 'stripe'", "const s = new Stripe(key)"])
    const matched = detectSdkPacks(diff, [pack("stripe")])
    expect(matched).toHaveLength(1)
    expect(matched[0]!.matchedPaths).toEqual(["src/checkout.ts"])
  })

  it("matches on pathGlobs when supplied", () => {
    const p = pack("nextjs", {
      matchers: { packages: [], importPatterns: [], pathGlobs: ["**/app/**/*.tsx"] },
    })
    const diff = diffFile("app/page.tsx", ["export default function Page() { return null }"])
    expect(detectSdkPacks(diff, [p])).toHaveLength(1)
    const diffOutsideGlob = diffFile("lib/page.tsx", ["export default function Page() { return null }"])
    expect(detectSdkPacks(diffOutsideGlob, [p])).toEqual([])
  })

  it("caps matched packs at MAX_MATCHED_PACKS even when more packs match", () => {
    const packs = Array.from({ length: MAX_MATCHED_PACKS + 3 }, (_, i) => pack(`vendor-${i}`))
    const diff = packs.map((p) => diffFile(`src/${p.id}.ts`, [`import x from '${p.id}'`])).join("\n")
    const matched = detectSdkPacks(diff, packs)
    expect(matched.length).toBe(MAX_MATCHED_PACKS)
  })

  it("ranks packs by the number of distinct matched files, most relevant first", () => {
    const stripe = pack("stripe")
    const openai = pack("openai-sdk")
    const diff = [
      diffFile("src/a.ts", ["import Stripe from 'stripe'"]),
      diffFile("src/b.ts", ["import Stripe from 'stripe'"]),
      diffFile("src/c.ts", ["import OpenAI from 'openai-sdk'"]),
    ].join("\n")
    const matched = detectSdkPacks(diff, [openai, stripe])
    expect(matched.map((m) => m.pack.id)).toEqual(["stripe", "openai-sdk"])
    expect(matched[0]!.matchedPaths).toHaveLength(2)
    expect(matched[1]!.matchedPaths).toHaveLength(1)
  })

  it("breaks a relevance tie by pack id for a deterministic order", () => {
    const a = pack("zebra")
    const b = pack("alpha")
    const diff = [
      diffFile("src/a.ts", ["import x from 'zebra'"]),
      diffFile("src/b.ts", ["import y from 'alpha'"]),
    ].join("\n")
    const matched = detectSdkPacks(diff, [a, b])
    expect(matched.map((m) => m.pack.id)).toEqual(["alpha", "zebra"])
  })

  it("never throws on a malformed diff", () => {
    expect(() => detectSdkPacks("not a real diff\n+++ garbage", [pack("stripe")])).not.toThrow()
  })
})
