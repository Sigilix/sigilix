import { describe, expect, it } from "vitest"

import {
  RUNTIME_APP_IDS,
  isToolCompatibleWithRuntimeApp,
  parseLeadingRuntimeAppMention,
  publicRuntimeAppCatalog,
  resolveRuntimeApp,
  runtimeAppRouteError,
} from "@/src/shared/domain/runtime-app-registry"

describe("runtime app registry", () => {
  it("projects only safe public naming and surface metadata", () => {
    const catalog = publicRuntimeAppCatalog()

    expect(catalog.version).toBe(1)
    expect(catalog.apps.map((app) => app.id)).toEqual(RUNTIME_APP_IDS)
    for (const app of catalog.apps) {
      expect(Object.keys(app).sort()).toEqual(["aliases", "canonicalMention", "id", "name", "surfaces"])
      expect(app.canonicalMention).toBe(`@${app.name}`)
      expect(app.aliases.every((alias) => alias.startsWith("@"))).toBe(true)
      expect(app).not.toHaveProperty("vendor")
      expect(app).not.toHaveProperty("compatibleToolNames")
      expect(app).not.toHaveProperty("url")
      expect(app).not.toHaveProperty("grant")
    }

    expect(catalog.apps.find((app) => app.id === "github")?.surfaces).toEqual([])
    expect(catalog.apps.filter((app) => app.id !== "github").every((app) => app.surfaces.length === 3)).toBe(true)
  })

  it("returns fresh public arrays instead of mutable registry state", () => {
    const first = publicRuntimeAppCatalog()
    first.apps[0]?.aliases.push("@forged")
    first.apps[0]?.surfaces.splice(0)

    const second = publicRuntimeAppCatalog()
    expect(second.apps[0]?.aliases).not.toContain("@forged")
    expect(second.apps[0]?.surfaces).toEqual(["chat", "deep-research", "cli"])
  })

  it("resolves exact ids and keeps GitHub dark and non-MCP", () => {
    expect(resolveRuntimeApp("linear")).toMatchObject({
      id: "linear",
      kind: "mcp",
      executable: true,
      vendor: "linear",
    })
    expect(resolveRuntimeApp("github")).toMatchObject({
      id: "github",
      kind: "builtin",
      executable: false,
      vendor: null,
    })
    expect(resolveRuntimeApp("Linear")).toBeNull()
    expect(resolveRuntimeApp("unknown")).toBeNull()
    expect(resolveRuntimeApp(null)).toBeNull()
  })

  it("keeps Jira and Confluence on disjoint reviewed Atlassian tool subsets", () => {
    const jira = resolveRuntimeApp("jira")
    const confluence = resolveRuntimeApp("confluence")
    expect(jira).toMatchObject({ kind: "mcp", vendor: "atlassian" })
    expect(confluence).toMatchObject({ kind: "mcp", vendor: "atlassian" })
    if (!jira || jira.kind !== "mcp" || !confluence || confluence.kind !== "mcp") {
      throw new Error("expected Jira and Confluence MCP entries")
    }

    expect(jira.compatibleToolNames).not.toBeNull()
    expect(confluence.compatibleToolNames).not.toBeNull()
    const jiraTools = new Set(jira.compatibleToolNames ?? [])
    expect((confluence.compatibleToolNames ?? []).some((name) => jiraTools.has(name))).toBe(false)

    expect(isToolCompatibleWithRuntimeApp("jira", "atlassian", "getJiraIssue")).toBe(true)
    expect(isToolCompatibleWithRuntimeApp("jira", "atlassian", "getConfluencePage")).toBe(false)
    expect(isToolCompatibleWithRuntimeApp("confluence", "atlassian", "getConfluencePage")).toBe(true)
    expect(isToolCompatibleWithRuntimeApp("confluence", "atlassian", "getJiraIssue")).toBe(false)
    expect(isToolCompatibleWithRuntimeApp("jira", "atlassian", "atlassianUserInfo")).toBe(false)
  })

  it("requires vendor compatibility and never treats GitHub as MCP", () => {
    expect(isToolCompatibleWithRuntimeApp("linear", "linear", "list_comments")).toBe(true)
    expect(isToolCompatibleWithRuntimeApp("linear", "linear", "")).toBe(false)
    expect(isToolCompatibleWithRuntimeApp("linear", "sentry", "list_comments")).toBe(false)
    expect(isToolCompatibleWithRuntimeApp("github", "linear", "list_comments")).toBe(false)
    expect(isToolCompatibleWithRuntimeApp("unknown", "linear", "list_comments")).toBe(false)
  })

  it("publishes stable human-safe rejection copy for every public error code", () => {
    expect(runtimeAppRouteError("invalid_mention")).toEqual({
      error: "invalid_app_mention",
      message: "Use a supported @App mention at the start of your request.",
    })
    expect(runtimeAppRouteError("unknown_app")).toEqual({
      error: "unknown_app",
      message: "That app mention is not supported.",
    })
    expect(runtimeAppRouteError("empty_task")).toEqual({
      error: "missing_app_task",
      message: "Add a request after the app mention.",
    })
  })
})

describe("parseLeadingRuntimeAppMention", () => {
  it("resolves canonical names and exact aliases case-insensitively", () => {
    expect(parseLeadingRuntimeAppMention("@LiNeAr list my issues")).toEqual({
      kind: "resolved",
      appId: "linear",
      mention: "@LiNeAr",
      task: "list my issues",
    })
    expect(parseLeadingRuntimeAppMention("@CF search Workers documentation")).toEqual({
      kind: "resolved",
      appId: "cloudflare",
      mention: "@CF",
      task: "search Workers documentation",
    })
    expect(parseLeadingRuntimeAppMention("@gh inspect this pull request")).toEqual({
      kind: "resolved",
      appId: "github",
      mention: "@gh",
      task: "inspect this pull request",
    })
  })

  it("accepts only whitespace, colon, comma, or end as token separators", () => {
    expect(parseLeadingRuntimeAppMention("  @Linear: list issues  ")).toMatchObject({
      kind: "resolved",
      appId: "linear",
      task: "list issues",
    })
    expect(parseLeadingRuntimeAppMention("\n@Sentry, search errors")).toMatchObject({
      kind: "resolved",
      appId: "sentry",
      task: "search errors",
    })
    expect(parseLeadingRuntimeAppMention("@Notion\tfind the spec")).toMatchObject({
      kind: "resolved",
      appId: "notion",
      task: "find the spec",
    })
  })

  it("leaves a non-leading mention out of routing and trims the ordinary task", () => {
    expect(parseLeadingRuntimeAppMention("  compare this with @Linear  ")).toEqual({
      kind: "none",
      task: "compare this with @Linear",
    })
    expect(parseLeadingRuntimeAppMention("plain task")).toEqual({ kind: "none", task: "plain task" })
  })

  it("rejects a valid ASCII but unknown explicit alias", () => {
    expect(parseLeadingRuntimeAppMention("@MadeUp do something")).toEqual({
      kind: "rejected",
      reason: "unknown_app",
      mention: "@MadeUp",
    })
    expect(parseLeadingRuntimeAppMention("@linear-prod do something")).toEqual({
      kind: "rejected",
      reason: "unknown_app",
      mention: "@linear-prod",
    })
  })

  it.each([
    ["@github.evil inspect", "@github.evil"],
    ["@github/evil inspect", "@github/evil"],
    ["@github! inspect", "@github!"],
    ["@github; inspect", "@github;"],
    ["@LİNEAR inspect", "@LİNEAR"],
    ["@ıntercom inspect", "@ıntercom"],
    ["@Linear\u00a0inspect", "@Linear\u00a0inspect"],
    ["@Linear\u200binspect", "@Linear\u200binspect"],
    ["@@linear inspect", "@@linear"],
    ["@_linear inspect", "@_linear"],
    ["@-linear inspect", "@-linear"],
    ["@ task", "@"],
  ])("rejects invalid or non-ASCII leading tokens without prefix matching: %s", (input, mention) => {
    expect(parseLeadingRuntimeAppMention(input)).toEqual({
      kind: "rejected",
      reason: "invalid_mention",
      mention,
    })
  })

  it("captures an entire oversized token before rejecting it", () => {
    const mention = `@${"a".repeat(65)}`
    expect(parseLeadingRuntimeAppMention(`${mention} task`)).toEqual({
      kind: "rejected",
      reason: "invalid_mention",
      mention,
    })
  })

  it.each(["@Linear", "@Linear:", "@Linear,   ", "  @gh\n\t"])(
    "rejects a known mention whose cleaned task is empty: %s",
    (input) => {
      const result = parseLeadingRuntimeAppMention(input)
      expect(result).toMatchObject({ kind: "rejected", reason: "empty_task" })
    },
  )

  it("never resolves an app-name prefix", () => {
    expect(parseLeadingRuntimeAppMention("@linearx task")).toEqual({
      kind: "rejected",
      reason: "unknown_app",
      mention: "@linearx",
    })
    expect(parseLeadingRuntimeAppMention("@github.evil task")).not.toMatchObject({
      kind: "resolved",
      appId: "github",
    })
  })
})
