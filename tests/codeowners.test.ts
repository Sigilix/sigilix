import { describe, expect, it } from "vitest"

import {
  mergeSuggestedReviewers,
  ownersForPath,
  parseCodeowners,
  suggestedReviewersFromCodeowners,
} from "../src/lib/codeowners"

describe("CODEOWNERS parsing and owner resolution", () => {
  it("uses last-match-wins precedence and supports empty-owner overrides", () => {
    const parsed = parseCodeowners(`
* @global
/src/** @src
/src/private
`)

    expect(ownersForPath(parsed.rules, "README.md")).toEqual(["@global"])
    expect(ownersForPath(parsed.rules, "src/app.ts")).toEqual(["@src"])
    expect(ownersForPath(parsed.rules, "src/private/secret.ts")).toEqual([])
  })

  it("matches GitHub CODEOWNERS basename, anchored directory, and unanchored directory patterns", () => {
    const parsed = parseCodeowners(`
*.js @js-owner
/docs/ @docs-owner
apps/ @apps-owner
**/logs @logs-owner
docs/* @docs-one-level
`)

    expect(ownersForPath(parsed.rules, "src/client.js")).toEqual(["@js-owner"])
    expect(ownersForPath(parsed.rules, "docs/guide/setup.md")).toEqual(["@docs-owner"])
    expect(ownersForPath(parsed.rules, "packages/web/apps/index.ts")).toEqual(["@apps-owner"])
    expect(ownersForPath(parsed.rules, "services/api/logs/app.log")).toEqual(["@logs-owner"])
    expect(ownersForPath(parsed.rules, "docs/README.md")).toEqual(["@docs-one-level"])
    expect(ownersForPath(parsed.rules, "docs/nested/README.md")).toEqual(["@docs-owner"])
  })

  it("skips unsupported negation and character-class patterns instead of treating them as exclusions", () => {
    const parsed = parseCodeowners(`
*.ts @all-ts
!src/private/** @nobody
src/[ab].ts @bad-pattern
`)

    expect(parsed.skipped).toEqual([
      { line: 3, pattern: "!src/private/**", reason: "negation" },
      { line: 4, pattern: "src/[ab].ts", reason: "character-class" },
    ])
    expect(ownersForPath(parsed.rules, "src/private/key.ts")).toEqual(["@all-ts"])
  })

  it("dedupes and filters CODEOWNERS owners for the existing reviewer contract", () => {
    const reviewers = suggestedReviewersFromCodeowners(
      `
*.ts @alice alice@example.com @acme/platform @alice @bad- @bob
*.md @docs
`,
      ["src/app.ts", "README.md"],
      { exclude: ["bob"], limit: 2 },
    )

    expect(reviewers).toEqual(["alice", "docs"])
  })

  it("ignores impossible traversal or oversized paths before glob matching", () => {
    const parsed = parseCodeowners("*.ts @all-ts")

    expect(ownersForPath(parsed.rules, "../src/app.ts")).toEqual([])
    expect(ownersForPath(parsed.rules, `${"deep/".repeat(257)}app.ts`)).toEqual([])
    expect(ownersForPath(parsed.rules, "src/app.ts")).toEqual(["@all-ts"])
  })

  it("merges one deterministic CODEOWNERS reviewer before model reviewers without hiding model signal", () => {
    expect(mergeSuggestedReviewers(["alice", "bob"], ["carol", "alice"], 2)).toEqual(["alice", "carol"])
    expect(mergeSuggestedReviewers([], ["carol"], 2)).toEqual(["carol"])
    expect(mergeSuggestedReviewers([], undefined, 2)).toBeUndefined()
  })
})
