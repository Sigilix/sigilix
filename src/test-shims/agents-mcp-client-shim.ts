// sig-mcp-connections-p1 vitest shim for `agents/mcp/client`.
//
// The real module transitively imports `partyserver`, whose entry point does
// `import { DurableObject, env } from "cloudflare:workers"` at module scope.
// `src/index.ts` statically exports `McpConnectionsAgent` (which imports
// `agents/mcp/client`), so that import chain runs for EVERY test that loads
// the worker entry — the webhook/index suites, none of which touch MCP
// functionality at all. Vitest externalizes `node_modules` packages by
// default, so once resolution enters `agents`'s own dependency graph, Node's
// native ESM loader handles the rest and never consults this project's
// `cloudflare:workers` alias (that alias only fires for Vite-transformed,
// first-party specifiers) — hence the raw "Received protocol 'cloudflare:'"
// crash. Exactly like the `@cloudflare/containers` shim, we alias the
// package AT THE SPECIFIER OUR OWN CODE IMPORTS (`agents/mcp/client`, from
// first-party `mcp-connections-do.ts`) to this minimal stand-in instead.
//
// mcp-connections-do.test.ts (and routes.test.ts, transitively) exercises
// real MCPClientManager *behavior* via its own `vi.mock("agents/mcp/client", …)`
// factory, which wins over this alias for that file only — this shim only
// needs to exist so unrelated tests can import the worker entry without
// crashing.

export class MCPClientManager {
  constructor(..._args: unknown[]) {}
}
