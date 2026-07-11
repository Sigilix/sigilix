import { afterEach, describe, expect, it, vi } from "vitest";
import { callAgentMcpTool, loadAgentMcpTools } from "./mcp-client.js";

const config = {
  endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp",
  capability: "c".repeat(64),
};

afterEach(() => vi.unstubAllGlobals());

describe("trusted parent MCP client", () => {
  it("sends the capability only as a header and accepts bounded local tool names", async () => {
    let capturedHeader = "";
    let capturedBody = "";
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      capturedHeader = String(new Headers(init?.headers).get("x-sigilix-mcp-capability"));
      capturedBody = String(init?.body);
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "mcp_0", description: "approved", inputSchema: { type: "object" } },
            { name: "remote-write", description: "blocked", inputSchema: { type: "object" } },
            { name: "mcp_1", description: "malformed", inputSchema: { type: "string" } },
          ],
        },
      });
    });

    const tools = await loadAgentMcpTools(config, 30_000);

    expect(tools).toEqual([{ name: "mcp_0", description: "approved", inputSchema: { type: "object" } }]);
    expect(capturedHeader).toBe(config.capability);
    expect(capturedBody).not.toContain(config.capability);
  });

  it("maps MCP isError and transport failure to a local tool error", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "budget exhausted" }], isError: true },
      }),
    );
    expect(await callAgentMcpTool(config, "mcp_0", {}, 30_000)).toBe("error: budget exhausted");

    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    expect(await callAgentMcpTool(config, "mcp_0", {}, 30_000)).toContain("temporarily unavailable");
  });
});
