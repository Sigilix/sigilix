import { describe, expect, it } from "vitest"
import {
  listTeamRepoMappings,
  parseTeamGithubRepo,
  resolveInstallation,
} from "../src/lib/github-installation"

describe("resolveInstallation", () => {
  it("prefers exact owner/repo over owner-only fallback", () => {
    const map = JSON.stringify({
      "Arc-and-Anchor/rema-portal": "12345",
      "Arc-and-Anchor": "9999",
    })
    expect(resolveInstallation("Arc-and-Anchor", "rema-portal", map)).toEqual({
      ok: true,
      installationId: 12345,
    })
  })

  it("falls back to owner-only when no exact match", () => {
    const map = JSON.stringify({ "Arc-and-Anchor": "9999" })
    expect(resolveInstallation("Arc-and-Anchor", "other-repo", map)).toEqual({
      ok: true,
      installationId: 9999,
    })
  })

  it("returns no_installation on bad JSON (soft-fail)", () => {
    expect(resolveInstallation("o", "r", "{not json")).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("returns no_installation on empty/missing env", () => {
    expect(resolveInstallation("o", "r", undefined)).toEqual({
      ok: false,
      reason: "no_installation",
    })
    expect(resolveInstallation("o", "r", "")).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("accepts numeric IDs", () => {
    const map = JSON.stringify({ "o/r": 555 })
    expect(resolveInstallation("o", "r", map)).toEqual({ ok: true, installationId: 555 })
  })

  it("rejects non-numeric / zero IDs", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "abc" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "0" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects digit-prefixed strings like '123abc' (parseInt would silently truncate)", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "123abc" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects fractional numbers like 1.5 (would route auth to wrong installation)", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": 1.5 }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects negative / Infinity / NaN numbers", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": -1 }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
    // Note: JSON.stringify(NaN) and JSON.stringify(Infinity) both produce "null",
    // so we test those by hand-crafting the JSON.
    expect(resolveInstallation("o", "r", '{"o/r": null}')).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects whitespace-padded numeric strings", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": " 123" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "123 " }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })
})

describe("listTeamRepoMappings", () => {
  it("emits one entry per team", () => {
    const json = JSON.stringify({
      ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      RFD: { owner: "Arc-and-Anchor", repo: "rubberfit-desktop" },
    })
    expect(listTeamRepoMappings(json)).toEqual([
      { teamKey: "ARC", owner: "Arc-and-Anchor", repo: "rema-portal" },
      { teamKey: "RFD", owner: "Arc-and-Anchor", repo: "rubberfit-desktop" },
    ])
  })

  it("returns empty for missing/empty env", () => {
    expect(listTeamRepoMappings(undefined)).toEqual([])
    expect(listTeamRepoMappings("")).toEqual([])
  })

  it("returns empty for malformed JSON", () => {
    expect(listTeamRepoMappings("{not json")).toEqual([])
  })

  it("skips entries that don't have both owner and repo", () => {
    const json = JSON.stringify({
      ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      BAD: { owner: "only-owner" },
    })
    expect(listTeamRepoMappings(json)).toEqual([
      { teamKey: "ARC", owner: "Arc-and-Anchor", repo: "rema-portal" },
    ])
  })
})

describe("parseTeamGithubRepo", () => {
  it("returns the mapping for the requested team", () => {
    const json = JSON.stringify({
      ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
    })
    expect(parseTeamGithubRepo(json, "ARC")).toEqual({
      owner: "Arc-and-Anchor",
      repo: "rema-portal",
    })
  })

  it("returns null when team not present", () => {
    const json = JSON.stringify({ ARC: { owner: "x", repo: "y" } })
    expect(parseTeamGithubRepo(json, "OTHER")).toBeNull()
  })

  it("returns null when teamKey is null", () => {
    const json = JSON.stringify({ ARC: { owner: "x", repo: "y" } })
    expect(parseTeamGithubRepo(json, null)).toBeNull()
  })

  it("returns null on missing/empty/malformed env", () => {
    expect(parseTeamGithubRepo(undefined, "ARC")).toBeNull()
    expect(parseTeamGithubRepo("", "ARC")).toBeNull()
    expect(parseTeamGithubRepo("{not json", "ARC")).toBeNull()
  })
})
