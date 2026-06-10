import { describe, expect, it } from "vitest"

import {
  mergeSuggestedReviewers,
  ownersForPath,
  parseCodeowners,
  suggestedReviewersFromCodeowners,
} from "@/src/lib/codeowners"

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
    expect(ownersForPath(parsed.rules, "apps/index.ts")).toEqual(["@apps-owner"])
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

  it("records compile-failed when picomatch rejects a pattern", () => {
    // Picomatch's default maxLength guard rejects patterns longer than 65,536 chars.
    const tooLongPattern = "a".repeat(65_537)
    const parsed = parseCodeowners(`${tooLongPattern} @owner`)

    expect(parsed.rules).toEqual([])
    expect(parsed.skipped).toEqual([{ line: 1, pattern: tooLongPattern, reason: "compile-failed" }])
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

  it("includes team owners when requested", () => {
    const reviewers = suggestedReviewersFromCodeowners("*.ts @alice @acme/platform", ["app.ts"], {
      includeTeams: true,
      limit: 2,
    })

    expect(reviewers).toEqual(["alice", "acme/platform"])
  })

  it("accepts GitHub Enterprise Managed User owner suffixes", () => {
    const reviewers = suggestedReviewersFromCodeowners("*.ts @mona-cat_octo @plain-user", ["app.ts"], {
      limit: 2,
    })

    expect(reviewers).toEqual(["mona-cat_octo", "plain-user"])
  })

  it("accepts GitHub Enterprise Managed User suffixes in team owners when teams are included", () => {
    const reviewers = suggestedReviewersFromCodeowners("*.ts @org/team_user", ["app.ts"], {
      includeTeams: true,
      limit: 1,
    })

    expect(reviewers).toEqual(["org/team_user"])
  })

  it("checks team owner suffix length from the slug segment, not the full owner string", () => {
    const org = "o".repeat(39)
    const team = `${"t".repeat(30)}_octo`
    const reviewers = suggestedReviewersFromCodeowners(`*.ts @${org}/${team}`, ["app.ts"], {
      includeTeams: true,
      limit: 1,
    })

    expect(reviewers).toEqual([`${org}/${team}`])
  })

  it("does not accept GitHub Enterprise Managed User suffixes in team organization names", () => {
    const reviewers = suggestedReviewersFromCodeowners("*.ts @org_octo/platform @fallback", ["app.ts"], {
      includeTeams: true,
      limit: 2,
    })

    expect(reviewers).toEqual(["fallback"])
  })

  it("rejects malformed GitHub Enterprise Managed User suffix lengths", () => {
    const reviewers = suggestedReviewersFromCodeowners(
      "*.ts @mona-cat_ @mona-cat_ab @mona-cat_abcdefghi @valid-owner",
      ["app.ts"],
      { limit: 2 },
    )

    expect(reviewers).toEqual(["valid-owner"])
  })

  it("rejects GitHub Enterprise Managed User suffixes beyond the username length limit", () => {
    const maxLengthOwner = `${"a".repeat(34)}_octo`
    const overLengthOwner = `${"b".repeat(35)}_octo`
    const reviewers = suggestedReviewersFromCodeowners(`*.ts @${maxLengthOwner} @${overLengthOwner}`, ["app.ts"], {
      limit: 2,
    })

    expect(reviewers).toEqual([maxLengthOwner])
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
