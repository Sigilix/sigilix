// SIG-196: unit tests for resolveSlackScope — EXACT-match channel→repo scope resolver.
// Scope-safety rule: an owner/repo is accepted ONLY if OPENCLAW_GITHUB_INSTALLATION_MAP
// has an EXACT "owner/repo" key. Owner-only entries do NOT authorize a repo. Fail-closed.

import { describe, expect, it } from "vitest"
import { resolveSlackScope } from "@/src/lib/slack/slack-scope"

const INSTALL = JSON.stringify({ "sigilix/sigilix": "111", acme: "222" })

describe("resolveSlackScope", () => {
  it("resolves an exact-match repo", () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"], linearTeam: "uuid-1" } })
    const r = resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T1", channelId: "C1" })
    expect(r).toEqual({ ok: true, scope: { teamId: "T1", channelId: "C1", repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }], linearTeam: "uuid-1" } })
  })
  it("DROPS a repo that only has an owner-only install entry (no owner fallback)", () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["acme/widgets"] } })  // map only has "acme" owner-level
    expect(resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T1", channelId: "C1" })).toEqual({ ok: false, reason: "no-installation" })
  })
  it("DROPS a repo with no install entry but keeps the exact one", () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix", "evil/repo"] } })
    const r = resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T1", channelId: "C1" })
    expect(r.ok && r.scope.repos.map((x) => x.repo)).toEqual(["sigilix"])
  })
  it("denies an unconfigured channel", () => {
    expect(resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: "{}", OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T9", channelId: "C9" })).toEqual({ ok: false, reason: "no-config" })
  })
  it("fails closed on malformed scope JSON", () => {
    expect(resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: "{nope", OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T1", channelId: "C1" }).ok).toBe(false)
  })
  it("DROPS a repo whose installation id is '0' → no-installation", () => {
    const install = JSON.stringify({ "sigilix/sigilix": "0" })
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"] } })
    expect(resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: install }, { teamId: "T1", channelId: "C1" })).toEqual({ ok: false, reason: "no-installation" })
  })
  it("returns parse-error (not throw) when repos is not an array", () => {
    const map = JSON.stringify({ "T1:C1": { repos: 42 } })
    expect(() => resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T1", channelId: "C1" })).not.toThrow()
    expect(resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL }, { teamId: "T1", channelId: "C1" })).toEqual({ ok: false, reason: "parse-error" })
  })
  it("fails closed → no-installation when OPENCLAW_GITHUB_INSTALLATION_MAP is malformed JSON", () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"] } })
    expect(resolveSlackScope({ SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: "{nope" }, { teamId: "T1", channelId: "C1" })).toEqual({ ok: false, reason: "no-installation" })
  })
})
