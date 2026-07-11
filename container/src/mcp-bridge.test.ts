import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgentMcpBridge } from "./mcp-bridge.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("agent MCP loopback bridge", () => {
  it("binds loopback, injects the capability upstream, and forwards no secret downstream", async () => {
    const capability = "a".repeat(64);
    let upstreamHeader = "";
    const upstream = createServer((req, res) => {
      upstreamHeader = String(req.headers["x-sigilix-mcp-capability"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
    servers.push(upstream);
    await listen(upstream);
    const address = upstream.address() as AddressInfo;
    const bridge = await createAgentMcpBridge({
      endpoint: `http://127.0.0.1:${address.port}/`,
      capability,
    });

    expect(new URL(bridge.endpoint).hostname).toBe("127.0.0.1");
    const response = await fetch(bridge.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(capability);
    expect(upstreamHeader).toBe(capability);
    await bridge.close();
  });

  it("rejects every non-root path and stops accepting connections after close", async () => {
    const upstream = createServer((_req, res) => res.writeHead(500).end());
    servers.push(upstream);
    await listen(upstream);
    const address = upstream.address() as AddressInfo;
    const bridge = await createAgentMcpBridge({
      endpoint: `http://127.0.0.1:${address.port}/`,
      capability: "b".repeat(64),
    });

    expect((await fetch(new URL("other", bridge.endpoint))).status).toBe(404);
    await bridge.close();
    await expect(fetch(bridge.endpoint)).rejects.toThrow();
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
