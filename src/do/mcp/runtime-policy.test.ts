import { describe, expect, it } from "vitest"
import { curatedReadToolForVendor, effectiveMcpPolicy, narrowMcpPolicy, vendorPolicyForUrl } from "./runtime-policy"

describe("MCP server-owned runtime policy", () => {
  it("matches only exact HTTPS official endpoints", () => {
    expect(vendorPolicyForUrl("https://mcp.linear.app/mcp")?.vendor).toBe("linear")
    expect(vendorPolicyForUrl("https://mcp.linear.app/mcp/")?.vendor).toBe("linear")
    expect(vendorPolicyForUrl("http://mcp.linear.app/mcp")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.linear.app.evil.example/mcp")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.linear.app:8443/mcp")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.linear.app/mcp?tool=read")).toBeNull()
  })

  it("gives custom MCP servers zero runtime surfaces and tools", () => {
    expect(effectiveMcpPolicy("https://example.com/mcp")).toEqual({
      vendor: "custom",
      version: 0,
      enabled: false,
      chatEnabled: false,
      deepResearchEnabled: false,
      allowedReadTools: [],
      availableReadTools: [],
      maxCallsPerRun: 0,
    })
  })

  it("never grants an unknown or write-looking tool from remote metadata", () => {
    const policy = effectiveMcpPolicy("https://mcp.linear.app/mcp")
    expect(policy.allowedReadTools).not.toContain("create_issue")
    expect(policy.allowedReadTools).toContain("list_comments")
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces: { chat: true, deepResearch: true },
        allowedReadTools: ["list_issues"],
        maxCallsPerRun: 4,
      }),
    ).toEqual({ ok: false, error: "unsupported_tool" })
  })

  it("lets internal consumers independently verify the exact vendor/tool tuple", () => {
    expect(curatedReadToolForVendor("linear", "list_comments")?.description).toMatch(/read linear comments/i)
    expect(curatedReadToolForVendor("linear", "create_issue")).toBeNull()
    expect(curatedReadToolForVendor("custom", "list_comments")).toBeNull()
  })

  it("accepts a strict narrowing to no surfaces and no tools", () => {
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: false,
        surfaces: { chat: false, deepResearch: false },
        allowedReadTools: [],
        maxCallsPerRun: 0,
      }),
    ).toEqual({
      ok: true,
      policy: {
        version: 1,
        enabled: false,
        chatEnabled: false,
        deepResearchEnabled: false,
        allowedReadTools: [],
        maxCallsPerRun: 0,
      },
    })
  })

  it("rejects a stale optimistic-concurrency version", () => {
    expect(
      narrowMcpPolicy(
        "https://mcp.linear.app/mcp",
        {
          version: 0,
          enabled: true,
          surfaces: { chat: true, deepResearch: true },
          allowedReadTools: [],
          maxCallsPerRun: 1,
        },
        2,
      ),
    ).toEqual({ ok: false, error: "stale_version" })
  })
})
