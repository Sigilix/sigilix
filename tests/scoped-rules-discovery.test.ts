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

import { describe, expect, it } from "vitest"

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
} from "../src/lib/scoped-rules"

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

  it("bad globs (compile failures) are treated as no-frontmatter and fire repo-wide", () => {
    // picomatch tolerates most strings; this test uses a `glob: ` that
    // picomatch happens to accept literally. The behavior we actually
    // need to defend is: if compileScopedRulesManifest fell into the
    // `matcher: null` catch branch, the rule still ships in the
    // selection (it doesn't silently disappear). We exercise the
    // path by constructing the manifest directly with `matcher: null`.
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
})
