// ARC-183 — repository sensitivity controls.

import { describe, it, expect } from "vitest"

import { parseSensitiveRepos, isRepoSensitive } from "@/lib/repo-policy"

describe("parseSensitiveRepos", () => {
  it("returns empty set for undefined", () => {
    expect(parseSensitiveRepos(undefined).size).toBe(0)
  })

  it("returns empty set for empty / whitespace strings", () => {
    expect(parseSensitiveRepos("").size).toBe(0)
    expect(parseSensitiveRepos("   ").size).toBe(0)
    expect(parseSensitiveRepos(",,,").size).toBe(0)
  })

  it("parses a single entry", () => {
    const set = parseSensitiveRepos("Arc-and-Anchor/private")
    expect(set.has("arc-and-anchor/private")).toBe(true)
    expect(set.size).toBe(1)
  })

  it("parses comma-separated list, trims whitespace, lowercases", () => {
    const set = parseSensitiveRepos("Org/A, Org/B  ,Org/C")
    expect(set.has("org/a")).toBe(true)
    expect(set.has("org/b")).toBe(true)
    expect(set.has("org/c")).toBe(true)
    expect(set.size).toBe(3)
  })

  it("drops empty entries from middle/trailing commas", () => {
    expect(parseSensitiveRepos("a/b,,,c/d,").size).toBe(2)
  })
})

describe("isRepoSensitive", () => {
  it("returns false when env is unset (no sensitive repos by default)", () => {
    expect(isRepoSensitive(undefined, "Arc-and-Anchor", "anything")).toBe(false)
    expect(isRepoSensitive("", "Arc-and-Anchor", "anything")).toBe(false)
  })

  it("returns true for an exact-match sensitive repo", () => {
    expect(isRepoSensitive("Arc-and-Anchor/private", "Arc-and-Anchor", "private")).toBe(true)
  })

  it("matches case-insensitively", () => {
    expect(isRepoSensitive("ORG/SECRET", "org", "secret")).toBe(true)
    expect(isRepoSensitive("org/secret", "ORG", "SECRET")).toBe(true)
  })

  it("returns false when only one of (owner, repo) matches", () => {
    expect(isRepoSensitive("org/secret", "org", "different")).toBe(false)
    expect(isRepoSensitive("org/secret", "different", "secret")).toBe(false)
  })

  it("returns true when one entry in a multi-repo list matches", () => {
    const env = "org/a, ORG/SECRET, OTHER/repo"
    expect(isRepoSensitive(env, "org", "secret")).toBe(true)
    expect(isRepoSensitive(env, "org", "a")).toBe(true)
    expect(isRepoSensitive(env, "other", "repo")).toBe(true)
    expect(isRepoSensitive(env, "org", "public")).toBe(false)
  })
})
