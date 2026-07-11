import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentMcpConfig } from "./mcp-client.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 256_000;
const UPSTREAM_TIMEOUT_MS = 12_000;

export interface AgentMcpBridge {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * Keep the tenant capability in the trusted parent process. The full CLI child
 * sees only this loopback URL; the bridge injects the bearer on the immutable
 * upstream Worker endpoint.
 */
export function createAgentMcpBridge(config: AgentMcpConfig): Promise<AgentMcpBridge> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.url !== "/" || !req.method || !["GET", "POST", "DELETE"].includes(req.method)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = req.method === "POST" ? await readRequest(req) : undefined;
        if (body === null) {
          res.writeHead(413).end();
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        let upstream: Response;
        let responseBody: Buffer | null;
        try {
          const accept = firstHeader(req.headers.accept);
          const contentType = firstHeader(req.headers["content-type"]);
          const protocolVersion = firstHeader(req.headers["mcp-protocol-version"]);
          upstream = await fetch(config.endpoint, {
            method: req.method,
            headers: {
              ...(accept ? { accept } : {}),
              ...(contentType ? { "content-type": contentType } : {}),
              ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
              "x-sigilix-mcp-capability": config.capability,
            },
            ...(body !== undefined ? { body: body.toString("utf8") } : {}),
            signal: controller.signal,
          });
          responseBody = await readResponse(upstream, controller.signal);
        } finally {
          clearTimeout(timer);
        }
        if (responseBody === null) {
          res.writeHead(502).end();
          return;
        }
        const headers: Record<string, string> = {};
        const contentType = upstream.headers.get("content-type");
        if (contentType) headers["content-type"] = contentType;
        res.writeHead(upstream.status, headers);
        res.end(responseBody);
      } catch {
        res.writeHead(502).end();
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        endpoint: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readRequest(req: AsyncIterable<unknown>): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    void reader.cancel();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
