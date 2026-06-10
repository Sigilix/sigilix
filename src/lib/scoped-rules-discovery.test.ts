// SIG-172 — discovery + matching for directory-scoped (SIGILIX.md)
// and glob-scoped (.sigilix/rules/*.md) rule files.
//
// The interesting cases (cross-checked against the SIG-172 spec):
//   - Root-level SIGILIX.md applies to every changed file.
//   - A deeper SIGILIX.md (e.g. src/payments/SIGILIX.md) applies only
//     when at least one changed file lives under that directory.
//   - When both exist, both apply and the DEEPER one is rendered LAST
//     in the prompt so the AGENTS.md "deeper wins on conflict" model
//     maps to "later wins" in the LLM's flat-list attention budget.
//   - A glob-keyed rule with frontmatter `glob: src/**/auth*.ts`
//     applies only when at least one changed file matches the glob.
//   - Multiple matching glob rules are concatenated in lexicographic
//     path order (stable, debuggable).
//   - Walk depth is capped at 8 ancestors so a hostile/buggy repo
//     with deeply nested SIGILIX.md files can't blow the prompt
//     budget.
//   - The frontmatter parser handles bare body, frontmatter without
//     glob, malformed frontmatter (falls back to body-only), and
//     trailing whitespace.

import { describe, expect, it, vi } from "vitest"

import {
  ancestorDirs,
  buildScopedRulesManifest,
  classifyRuleFilePath,
  compileScopedRulesManifest,
  dirnamePosix,
  MAX_ANCESTORS,
  parseRuleFrontmatter,
  renderScopedRulesForPrompt,
  resolveScopedRulesForChangedPaths,
  walkScopedRuleFiles,
} from "@/src/lib/scoped-rules"
import {
  loadCompiledScopedRulesManifest,
  readScopedRulesManifest,
  scopedRulesKey,
} from "@/src/lib/scoped-rules-kv"
import type { Env } from "@/src/shared/types/env"

describe("parseRuleFrontmatter", () => {
  it("returns the body verbatim when no frontmatter is present", () => {
    const text = "Just a body, no header.\nSecond line."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBeUndefined()
    expect(result.body).toBe("Just a body, no header.\nSecond line.")
  })

  it("extracts the glob field from well-formed frontmatter", () => {
    const text = "---\nglob: src/**/auth*.ts\n---\nBody text here."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("src/**/auth*.ts")
    expect(result.body).toBe("Body text here.")
  })

  it("strips frontmatter even when no glob is declared", () => {
    const text = "---\ndescription: A future field\n---\nThe rule body."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBeUndefined()
    expect(result.body).toBe("The rule body.")
  })

  it("treats a header-less leading delimiter as not-frontmatter", () => {
    // Missing the closing `---` — the body should be returned in
    // full, not silently truncated.
    const text = "---\nglob: foo\nBody starts here."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBeUndefined()
    expect(result.body).toBe(text)
  })

  it("ignores nested mapping values inside frontmatter (flat-scalar contract)", () => {
    // The hand-rolled parser doc-strings the contract that frontmatter
    // MUST be flat scalars. A nested mapping shouldn't crash; it just
    // doesn't parse the inner value. The outer `glob` line still
    // resolves normally.
    const text = "---\nglob: tests/**/*.ts\nnested:\n  inner: value\n---\nbody."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("tests/**/*.ts")
    expect(result.body).toBe("body.")
  })

  it("trims trailing whitespace from frontmatter values", () => {
    const text = "---\nglob:   src/**/*.ts   \n---\nbody"
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("src/**/*.ts")
  })

  it("treats an empty glob field as missing", () => {
    // `glob: ` (no value) shouldn't be returned — the rule should
    // then behave as no-frontmatter (always-on) rather than match
    // every path via a phantom empty glob.
    const text = "---\nglob:\n---\nbody"
    const result = parseRuleFrontmatter(text)
    // Empty value fails the `(\w+):\s*(.+)$` regex so the field
    // isn't populated and `glob` stays undefined.
    expect(result.glob).toBeUndefined()
    expect(result.body).toBe("body")
  })

  // SIG-172 H1 (fix-up) — CRLF + lone-CR line endings are normalised
  // BEFORE matching. A Windows-authored .sigilix/rules/*.md previously
  // fell through to body-only mode AND leaked its raw YAML header into
  // the LLM prompt.
  it("parses CRLF (\\r\\n) line-ended frontmatter correctly", () => {
    const text = "---\r\nglob: src/**/*.ts\r\n---\r\nBody text here."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("src/**/*.ts")
    expect(result.body).toBe("Body text here.")
  })

  it("parses lone-CR (\\r) line-ended frontmatter correctly", () => {
    // Classic-Mac line endings are vanishingly rare in practice but
    // the normalisation is cheap and the fix-up brief asked for it.
    const text = "---\rglob: src/**/*.ts\r---\rBody text here."
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("src/**/*.ts")
    expect(result.body).toBe("Body text here.")
  })

  it("parses frontmatter-only files (no body after the closing delim)", () => {
    // `---\nfoo: bar\n---` with no trailing newline + no body —
    // previously fell through to body-only because the regex required
    // a trailing `\n([\s\S]*)`. Now the trailing newline + body capture
    // is optional, so this returns the parsed field + empty body.
    const text = "---\nglob: src/**/*.ts\n---"
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("src/**/*.ts")
    expect(result.body).toBe("")
  })

  it("parses frontmatter-only files with trailing newline (no body) correctly", () => {
    // `---\nfoo: bar\n---\n` (closing delim followed by a newline but
    // nothing else). Should yield empty body, not body===text.
    const text = "---\nglob: src/**/*.ts\n---\n"
    const result = parseRuleFrontmatter(text)
    expect(result.glob).toBe("src/**/*.ts")
    expect(result.body).toBe("")
  })
})

describe("classifyRuleFilePath", () => {
  it("recognizes SIGILIX.md at any depth", () => {
    expect(classifyRuleFilePath("SIGILIX.md")).toBe("sigilix-md")
    expect(classifyRuleFilePath("src/SIGILIX.md")).toBe("sigilix-md")
    expect(classifyRuleFilePath("src/payments/checkout/SIGILIX.md")).toBe("sigilix-md")
  })

  it("recognizes .sigilix/rules/*.md at any depth", () => {
    expect(classifyRuleFilePath(".sigilix/rules/security.md")).toBe("glob-rule")
    expect(classifyRuleFilePath("packages/api/.sigilix/rules/db.md")).toBe("glob-rule")
  })

  it("rejects unrelated files", () => {
    expect(classifyRuleFilePath("README.md")).toBeNull()
    expect(classifyRuleFilePath("sigilix.md")).toBeNull() // wrong case
    expect(classifyRuleFilePath(".sigilix/rules/notes.txt")).toBeNull()
    expect(classifyRuleFilePath(".sigilix/something/foo.md")).toBeNull()
    expect(classifyRuleFilePath("")).toBeNull()
  })
})

describe("ancestorDirs", () => {
  it("returns [parent..., root] closest-first for a nested path", () => {
    expect(ancestorDirs("a/b/c/file.ts", MAX_ANCESTORS)).toEqual([
      "a/b/c",
      "a/b",
      "a",
      "",
    ])
  })

  it("returns just [root] for a file at repo root", () => {
    expect(ancestorDirs("file.ts", MAX_ANCESTORS)).toEqual([""])
  })

  it("caps the walk at MAX_ANCESTORS, keeping the deepest entries", () => {
    // 12 dir levels — the 8 deepest should survive, the 4 shallowest
    // (including root) get dropped.
    const path = "a/b/c/d/e/f/g/h/i/j/k/l/file.ts"
    const ancestors = ancestorDirs(path, MAX_ANCESTORS)
    expect(ancestors).toHaveLength(MAX_ANCESTORS)
    expect(ancestors[0]).toBe("a/b/c/d/e/f/g/h/i/j/k/l")
    expect(ancestors).not.toContain("")
    expect(ancestors).not.toContain("a")
  })
})

describe("dirnamePosix", () => {
  it("returns the parent directory for a file in a directory", () => {
    expect(dirnamePosix("src/payments/checkout.ts")).toBe("src/payments")
    expect(dirnamePosix("src/SIGILIX.md")).toBe("src")
  })

  it("returns the empty string for a file at the repo root", () => {
    expect(dirnamePosix("SIGILIX.md")).toBe("")
    expect(dirnamePosix("README.md")).toBe("")
  })
})

describe("walkScopedRuleFiles", () => {
  it("picks rule files out of a tree-entry list and skips everything else", () => {
    const entries = [
      { path: "SIGILIX.md", type: "blob", size: 100 },
      { path: "README.md", type: "blob", size: 200 },
      { path: "src/payments/SIGILIX.md", type: "blob", size: 150 },
      { path: ".sigilix/rules/security.md", type: "blob", size: 300 },
      { path: ".sigilix/rules/", type: "tree", size: 0 },
      { path: ".sigilix/other/foo.md", type: "blob", size: 50 },
    ]
    const found = walkScopedRuleFiles(entries)
    const paths = found.map((f) => f.path).sort()
    expect(paths).toEqual([
      ".sigilix/rules/security.md",
      "SIGILIX.md",
      "src/payments/SIGILIX.md",
    ])
  })

  it("rejects oversized rule files (defends prompt budget)", () => {
    const huge = 100 * 1024
    const entries = [
      { path: "SIGILIX.md", type: "blob", size: huge },
      { path: "src/SIGILIX.md", type: "blob", size: 500 },
    ]
    const found = walkScopedRuleFiles(entries)
    expect(found.map((f) => f.path)).toEqual(["src/SIGILIX.md"])
  })
})

describe("resolveScopedRulesForChangedPaths — closest-ancestor (SIGILIX.md)", () => {
  it("a root SIGILIX.md applies to every changed file", () => {
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      { path: "SIGILIX.md", content: "Repo-wide rule body." },
    ]))
    const selection = resolveScopedRulesForChangedPaths(manifest, [
      "anywhere.ts",
      "src/deep/nested/file.ts",
    ])
    expect(selection.perDirectoryRules).toHaveLength(1)
    expect(selection.perDirectoryRules[0]!.dirPath).toBe("")
  })

  it("a src/payments/SIGILIX.md applies only when a changed file is under src/payments", () => {
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      { path: "src/payments/SIGILIX.md", content: "Payment-area rule." },
    ]))
    // Off-target changed file → no match.
    expect(resolveScopedRulesForChangedPaths(manifest, [
      "src/users/profile.ts",
    ]).perDirectoryRules).toHaveLength(0)
    // On-target changed file → match.
    const hit = resolveScopedRulesForChangedPaths(manifest, [
      "src/payments/checkout.ts",
    ])
    expect(hit.perDirectoryRules.map((r) => r.dirPath)).toEqual([
      "src/payments",
    ])
  })

  it("renders ancestor SIGILIX.md files with the DEEPEST positioned LAST", () => {
    // Both root + deeper exist; both apply when the changed file is
    // under src/payments. The deepest (src/payments) should be the
    // last entry in the rendered prompt so the AGENTS.md "deeper
    // wins on conflict" model translates into "later wins in the
    // LLM's flat-list attention."
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      { path: "SIGILIX.md", content: "Root rule." },
      { path: "src/payments/SIGILIX.md", content: "Payments rule." },
    ]))
    const selection = resolveScopedRulesForChangedPaths(manifest, [
      "src/payments/checkout.ts",
    ])
    expect(selection.perDirectoryRules.map((r) => r.dirPath)).toEqual([
      "",                 // shallowest (rendered FIRST)
      "src/payments",     // deepest (rendered LAST — wins on conflict)
    ])
    const rendered = renderScopedRulesForPrompt(selection)
    const idxRoot = rendered.indexOf("Root rule.")
    const idxDeep = rendered.indexOf("Payments rule.")
    expect(idxRoot).toBeGreaterThan(-1)
    expect(idxDeep).toBeGreaterThan(idxRoot)
  })

  // SIG-172 fix-up: the per-directory comparator must sort by directory
  // DEPTH (segment count), not string length. Siblings with different
  // name lengths but the SAME depth must tie + fall through to
  // lexicographic order — a length-sort would shuffle them by name byte
  // count, producing nondeterministic-feeling ordering for repos like
  // `src/a` + `src/abc`.
  it("sorts per-directory rules by depth (segments), not string length, with lexicographic tie-break", () => {
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      // Root + two same-depth siblings of different name lengths.
      { path: "SIGILIX.md", content: "ROOT" },
      { path: "src/a/SIGILIX.md", content: "SRC-A" },
      { path: "src/abc/SIGILIX.md", content: "SRC-ABC" },
    ]))
    // Two changed files, one under each sibling, so both fire.
    const selection = resolveScopedRulesForChangedPaths(manifest, [
      "src/a/file.ts",
      "src/abc/file.ts",
    ])
    // Expected render order: shallowest first (root depth 0), then the
    // two same-depth siblings in lexicographic order. A length-sort
    // would put `src/a` before `src/abc` for an unrelated reason
    // (shorter string) and could flip cross-depth pairs (e.g. a depth-1
    // "foo" vs a depth-2 "src/a").
    expect(selection.perDirectoryRules.map((r) => r.dirPath)).toEqual([
      "",
      "src/a",
      "src/abc",
    ])
  })

  it("dedupes ancestor SIGILIX.md when multiple changed files share it", () => {
    // Two changed files both under src/payments share the same
    // src/payments/SIGILIX.md. The deduped manifest must contain
    // each SIGILIX.md exactly once.
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      { path: "src/payments/SIGILIX.md", content: "Payments rule." },
    ]))
    const selection = resolveScopedRulesForChangedPaths(manifest, [
      "src/payments/checkout.ts",
      "src/payments/refund.ts",
    ])
    expect(selection.perDirectoryRules).toHaveLength(1)
  })

  it("caps the SIGILIX.md walk at 8 ancestors", () => {
    // Synthetic fixture: a 12-deep nested layout with a SIGILIX.md
    // at every level. The 8 deepest survive; the 4 shallowest
    // (including the repo root) get dropped before injection.
    const segs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]
    const entries: Array<{ path: string; content: string }> = []
    // Root SIGILIX.md so we can confirm it gets DROPPED.
    entries.push({ path: "SIGILIX.md", content: "ROOT-RULE" })
    // 12 nested SIGILIX.md, each labeled with its depth.
    for (let i = 1; i <= segs.length; i++) {
      const dir = segs.slice(0, i).join("/")
      entries.push({ path: `${dir}/SIGILIX.md`, content: `LVL-${i}` })
    }
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest(entries))
    const changedFile = `${segs.join("/")}/file.ts`
    const selection = resolveScopedRulesForChangedPaths(manifest, [changedFile])
    // 12-deep file: file's dir is segs.join("/") (len 12), ancestors
    // include 12 dirs + root = 13 candidates. Cap to 8 deepest.
    expect(selection.perDirectoryRules).toHaveLength(MAX_ANCESTORS)
    const rendered = renderScopedRulesForPrompt(selection)
    expect(rendered).not.toContain("ROOT-RULE")
    expect(rendered).toContain("LVL-12") // deepest survives
    expect(rendered).toContain("LVL-5")  // 8th-deepest survives
    expect(rendered).not.toContain("LVL-4") // dropped (shallower than cap)
  })
})

describe("resolveScopedRulesForChangedPaths — glob rules (.sigilix/rules/*.md)", () => {
  it("a glob-keyed rule applies only when a changed file matches the glob", () => {
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      {
        path: ".sigilix/rules/security.md",
        content: "---\nglob: src/**/auth*.ts\n---\nAuth-security rule body.",
      },
    ]))
    // No changed file matches the glob → rule doesn't fire.
    expect(resolveScopedRulesForChangedPaths(manifest, [
      "src/payments/checkout.ts",
      "README.md",
    ]).globRules).toHaveLength(0)
    // At least one changed file matches → rule fires.
    const hit = resolveScopedRulesForChangedPaths(manifest, [
      "src/users/auth-login.ts",
      "README.md",
    ])
    expect(hit.globRules.map((g) => g.rulePath)).toEqual([
      ".sigilix/rules/security.md",
    ])
  })

  it("a rule without `glob:` frontmatter always applies", () => {
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      { path: ".sigilix/rules/general.md", content: "Always-on rule body." },
    ]))
    const hit = resolveScopedRulesForChangedPaths(manifest, [
      "anywhere.ts",
    ])
    expect(hit.globRules).toHaveLength(1)
  })

  it("multiple matching glob rules are concatenated in lexicographic order", () => {
    const manifest = compileScopedRulesManifest(buildScopedRulesManifest([
      // Three globs that all match the same changed file. Intentionally
      // inserted in non-alphabetical order; render order should be A→B→C.
      {
        path: ".sigilix/rules/c-zeta.md",
        content: "---\nglob: src/**/*.ts\n---\nZ body.",
      },
      {
        path: ".sigilix/rules/a-alpha.md",
        content: "---\nglob: src/**/*.ts\n---\nA body.",
      },
      {
        path: ".sigilix/rules/b-beta.md",
        content: "---\nglob: src/**/*.ts\n---\nB body.",
      },
    ]))
    const selection = resolveScopedRulesForChangedPaths(manifest, [
      "src/foo.ts",
    ])
    expect(selection.globRules.map((g) => g.rulePath)).toEqual([
      ".sigilix/rules/a-alpha.md",
      ".sigilix/rules/b-beta.md",
      ".sigilix/rules/c-zeta.md",
    ])
  })

  it("bad globs (compile failures) are suppressed (don't fire) — typo'd globs would otherwise leak repo-wide", () => {
    // SIG-172 H2 (fix-up): renamed from the prior misleading title.
    // The assertion already checks the correct behavior (suppress, not
    // fire); the comment + title were inverted.
    //
    // Picomatch is permissive — most "weird" strings still compile.
    // We exercise the documented matcher:null+non-null-glob branch by
    // constructing the resolved manifest directly. The lower-level
    // compile-failure telemetry test exercises the real catch branch
    // via a non-string `glob` cast through unknown.
    const selection = resolveScopedRulesForChangedPaths(
      {
        perDirectoryRules: [],
        globRules: [
          {
            rulePath: ".sigilix/rules/bad.md",
            glob: "completely::broken[",
            matcher: null,
            body: "Bad-glob body still rendered.",
          },
        ],
      },
      ["anywhere.ts"],
    )
    // matcher:null + glob set: doc says "don't fire" — see resolveScopedRulesForChangedPaths.
    // Verify the documented behavior: matcher:null + non-null glob =
    // suppress (otherwise typo'd globs leak repo-wide). But for
    // glob:null + matcher:null (no frontmatter) it MUST fire. Confirm:
    expect(selection.globRules).toHaveLength(0)
  })

  it("compileScopedRulesManifest emits `scoped-rules-glob-compile-failed` telemetry when picomatch throws", () => {
    // SIG-172 H2 (fix-up). Picomatch throws on non-string input
    // ("Expected pattern to be a non-empty string"). We coerce a
    // non-string glob through unknown so the catch branch runs even
    // though `ScopedRulesManifest` types `glob` as `string | null`.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const manifest = compileScopedRulesManifest({
      perDirectoryRules: [],
      globRules: [
        {
          rulePath: ".sigilix/rules/typo.md",
          // The runtime call into picomatch throws on a non-string —
          // simulating a manifest that drifted from the schema (or a
          // future schema extension that landed a non-string value).
          glob: 123 as unknown as string,
          body: "Body.",
        },
      ],
    })
    expect(manifest.globRules).toHaveLength(1)
    expect(manifest.globRules[0]!.matcher).toBeNull()
    const events = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
    const compileFailed = events.find((e) => e.event === "scoped-rules-glob-compile-failed")
    expect(compileFailed).toBeDefined()
    expect(compileFailed.rulePath).toBe(".sigilix/rules/typo.md")
    expect(typeof compileFailed.err).toBe("string")
    warnSpy.mockRestore()
  })
})

describe("renderScopedRulesForPrompt", () => {
  it("returns the empty string when no rules apply", () => {
    expect(renderScopedRulesForPrompt({
      perDirectoryRules: [],
      globRules: [],
    })).toBe("")
  })

  it("labels the repo-root SIGILIX.md as <repo root> for readability", () => {
    const rendered = renderScopedRulesForPrompt({
      perDirectoryRules: [
        { dirPath: "", body: "Root body." },
      ],
      globRules: [],
    })
    expect(rendered).toContain("[SIGILIX.md — <repo root>]")
    expect(rendered).toContain("Root body.")
  })

  it("includes the explicit override-language sentence in the header", () => {
    // SIG-172 research §Q7: positional + lexical defense. The block
    // must SAY (not just imply by position) that it defers to
    // SHARED_NEGATIVE_CONSTRAINTS.
    const rendered = renderScopedRulesForPrompt({
      perDirectoryRules: [{ dirPath: "", body: "Body." }],
      globRules: [],
    })
    expect(rendered).toContain("[SCOPED RULES")
    expect(rendered).toContain("SHARED_NEGATIVE_CONSTRAINTS")
    expect(rendered.toUpperCase()).toContain("MUST DEFER")
  })

  // SIG-172 M1 (fix-up) — aggregate byte cap defends the prompt budget
  // when a handful of in-range (<= MAX_RULE_FILE_BYTES) rule files
  // combine to exceed the per-block budget.
  //
  // SIG-172 fix-up: the cap now drops the SHALLOWEST entries
  // (lowest priority under AGENTS.md model) and KEEPS the deepest, AND
  // the preamble byte count is included in the budget so the rendered
  // block stays under the cap including header bytes.
  it("caps the rendered block at MAX_RENDERED_SCOPED_RULES_BYTES (including preamble) and emits truncation telemetry; deepest rules are KEPT, shallowest are dropped", async () => {
    const { MAX_RENDERED_SCOPED_RULES_BYTES } = await import("@/src/lib/scoped-rules")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    // Build 6 per-directory rules of 4KB each = 24KB raw, well past
    // the 16KB cap. Use distinct dir paths so dedup doesn't collapse
    // them. Per the selection contract order is shallowest -> deepest,
    // so the LAST entries are the highest-priority rules; the cap must
    // drop from the FRONT (shallowest first) to preserve AGENTS.md
    // deepest-wins priority.
    const big = "x".repeat(4 * 1024)
    const perDirectoryRules = [
      { dirPath: "", body: `ROOT-${big}` },          // shallowest — dropped first
      { dirPath: "z/y/x", body: `ZYX-${big}` },
      { dirPath: "a", body: `A-${big}` },
      { dirPath: "a/b", body: `AB-${big}` },
      { dirPath: "a/b/c", body: `ABC-${big}` },
      { dirPath: "a/b/c/d", body: `ABCD-${big}` },   // deepest — kept
    ]
    const rendered = renderScopedRulesForPrompt({
      perDirectoryRules,
      globRules: [],
    })
    const renderedBytes = new TextEncoder().encode(rendered).length
    // Preamble is now counted toward the cap, so the rendered block
    // (preamble + kept bodies + separators) must stay UNDER the cap
    // ignoring the truncation marker line. A few-hundred-byte marker
    // is appended after the cap-bound loop, so allow a small slack.
    expect(renderedBytes).toBeLessThan(MAX_RENDERED_SCOPED_RULES_BYTES + 512)
    expect(rendered).toContain("scoped rules truncated at")
    // Deepest entries are KEPT.
    expect(rendered).toContain("ABCD-")
    expect(rendered).toContain("ABC-")
    // Shallowest entries are DROPPED.
    expect(rendered).not.toContain("ROOT-")
    const events = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
    const truncated = events.find((e) => e.event === "scoped-rules-block-truncated")
    expect(truncated).toBeDefined()
    expect(truncated.droppedCount).toBeGreaterThan(0)
    expect(truncated.capBytes).toBe(MAX_RENDERED_SCOPED_RULES_BYTES)
    // renderedBytes telemetry reflects the actual byte count of the
    // rendered output minus the truncation marker (which is appended
    // after the cap math).
    expect(typeof truncated.renderedBytes).toBe("number")
    expect(truncated.renderedBytes).toBeLessThanOrEqual(MAX_RENDERED_SCOPED_RULES_BYTES)
    warnSpy.mockRestore()
  })

  it("does NOT emit truncation telemetry when the block fits under the cap", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    renderScopedRulesForPrompt({
      perDirectoryRules: [{ dirPath: "src", body: "Small body." }],
      globRules: [],
    })
    const events = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
    expect(events.find((e) => e.event === "scoped-rules-block-truncated")).toBeUndefined()
    warnSpy.mockRestore()
  })
})

// SIG-172 H3 (fix-up) — KV-read failure must NEVER fail the review.
// `readScopedRulesManifest` tags the throw as `kv-error`;
// `loadCompiledScopedRulesManifest` emits the read-failed telemetry
// event + returns an empty compiled manifest so the orchestrator
// falls through to the "no scoped rules" path.
describe("scoped-rules KV read fails open on transient errors", () => {
  function makeEnvWithFailingGet(message: string): Env {
    return {
      OPENCLAW_STATE: {
        get: async (_key: string) => {
          throw new Error(message)
        },
      } as unknown as KVNamespace,
    } as unknown as Env
  }

  it("readScopedRulesManifest tags KV throws as kind=kv-error (does not propagate)", async () => {
    const env = makeEnvWithFailingGet("KV outage")
    const result = await readScopedRulesManifest(env, "Sigilix", "sigilix")
    expect(result.kind).toBe("kv-error")
    if (result.kind === "kv-error") {
      expect(result.err).toContain("KV outage")
    }
  })

  it("loadCompiledScopedRulesManifest returns an empty manifest + emits telemetry on KV throw", async () => {
    const env = makeEnvWithFailingGet("transient KV failure")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const compiled = await loadCompiledScopedRulesManifest(env, "Sigilix", "sigilix")
    // Empty manifest — orchestrator treats this as "no scoped rules
    // configured", same as the missing/invalid cases.
    expect(compiled.perDirectoryRules).toEqual([])
    expect(compiled.globRules).toEqual([])
    // Telemetry surfaced so dashboards see persistent KV trouble even
    // though no review failed.
    const events = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
    const readFailed = events.find((e) => e.event === "scoped-rules-manifest-read-failed")
    expect(readFailed).toBeDefined()
    expect(readFailed.owner).toBe("Sigilix")
    expect(readFailed.repo).toBe("sigilix")
    expect(typeof readFailed.err).toBe("string")
    warnSpy.mockRestore()
  })

  it("scopedRulesKey lowercases owner/repo so the read uses the canonical key", () => {
    // Sanity that the imported helper still produces the documented
    // shape — pinning the key contract so a future rename to the KV
    // prefix doesn't silently drift between writer + reader.
    expect(scopedRulesKey("Sigilix", "Sigilix")).toBe(
      "repo-index-rules:sigilix/sigilix",
    )
  })
})
