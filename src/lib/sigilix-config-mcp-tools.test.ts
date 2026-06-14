import { describe, expect, it } from "vitest"

import { parseSigilixConfig, resolveSpecialistMcpTools } from "@/src/lib/sigilix-config"

describe("sigilix config MCP specialist tools", () => {
  it("parses per-specialist tool permissions and filters unknown roles/tools", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        mcp: {
          enabled: true,
          specialists: {
            security: { tools: ["file_grep", "observability_lookup", "file_grep", "not_a_tool"] },
            logic: { tools: ["docs_fetch"] },
            unknownRole: { tools: ["browser_check"] },
          },
          tools: {
            observability_lookup: { enabled: false },
            browser_check: { enabled: true },
            not_a_tool: { enabled: true },
          },
        },
      }),
    )

    expect(cfg?.mcp).toEqual({
      enabled: true,
      specialists: {
        security: { tools: ["file_grep", "observability_lookup"] },
        logic: { tools: ["docs_fetch"] },
      },
      tools: {
        observability_lookup: { enabled: false },
        browser_check: { enabled: true },
      },
    })
    expect(resolveSpecialistMcpTools(cfg, "security").toolIds).toEqual(["file_grep"])
    expect(resolveSpecialistMcpTools(cfg, "logic").toolIds).toEqual(["docs_fetch"])
    expect(resolveSpecialistMcpTools(cfg, "performance").toolIds).toEqual([])
  })

  it("hides every tool when MCP is disabled or absent", () => {
    expect(resolveSpecialistMcpTools(null, "security").toolIds).toEqual([])
    expect(resolveSpecialistMcpTools({}, "security").toolIds).toEqual([])
    expect(
      resolveSpecialistMcpTools(
        {
          mcp: {
            enabled: false,
            specialists: { security: { tools: ["file_grep"] } },
          },
        },
        "security",
      ).toolIds,
    ).toEqual([])
  })
})
