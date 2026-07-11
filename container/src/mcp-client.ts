/** Short-lived Worker-owned MCP capability supplied to the trusted container. */
export interface AgentMcpConfig {
  endpoint: string;
  capability: string;
}

export interface AgentMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MAX_TOOLS = 16;
const MAX_RESPONSE_BYTES = 256_000;
const REQUEST_TIMEOUT_MS = 12_000;

export async function loadAgentMcpTools(
  config: AgentMcpConfig,
  remainingMs: number,
): Promise<AgentMcpTool[]> {
  const result = await callJsonRpc(config, "tools/list", {}, remainingMs);
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return [];
  const tools: AgentMcpTool[] = [];
  const seen = new Set<string>();
  for (const candidate of result.tools) {
    if (tools.length >= MAX_TOOLS) break;
    if (!isPlainObject(candidate)) continue;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const description = typeof candidate.description === "string" ? candidate.description : "";
    const inputSchema =
      isPlainObject(candidate.inputSchema) &&
      candidate.inputSchema.type === "object" &&
      (candidate.inputSchema.properties === undefined || isPlainObject(candidate.inputSchema.properties))
        ? candidate.inputSchema
        : null;
    if (!/^mcp_(?:[0-9]|1[0-5])$/.test(name) || !description || !inputSchema || seen.has(name)) continue;
    seen.add(name);
    tools.push({ name, description, inputSchema });
  }
  return tools;
}

export async function callAgentMcpTool(
  config: AgentMcpConfig,
  name: string,
  args: Record<string, unknown>,
  remainingMs: number,
): Promise<string> {
  const result = await callJsonRpc(config, "tools/call", { name, arguments: args }, remainingMs);
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return "error: connected data is temporarily unavailable; continue without it";
  }
  const text = result.content
    .filter((item): item is { type: "text"; text: string } =>
      isPlainObject(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
  if (result.isError === true) return `error: ${text || "connected data is unavailable"}`;
  return text || "(no connected data returned)";
}

async function callJsonRpc(
  config: AgentMcpConfig,
  method: string,
  params: Record<string, unknown>,
  remainingMs: number,
): Promise<unknown | null> {
  const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-sigilix-mcp-capability": config.capability,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const raw = await readCapped(response, controller.signal);
    if (raw === null) return null;
    const message = JSON.parse(raw) as unknown;
    return isPlainObject(message) && !message.error ? message.result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
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
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
