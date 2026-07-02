import { defineConfig } from "vitest/config"
import path from "node:path"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"

// SIG-138: node:sqlite is an experimental Node 22 built-in that Vite
// (running in ESM mode) doesn't recognise as external because `sqlite`
// is absent from Node's `builtinModules` list. Without intervention,
// Vite strips the `node:` prefix and then fails to resolve bare `sqlite`.
//
// We use a virtual-module plugin: intercept the import, return a
// virtual module ID, and in the `load` hook emit a CJS-require proxy
// that loads the built-in at runtime. This lets vitest run with the
// real SQLite engine while staying in its normal ESM pipeline.
const _require = createRequire(import.meta.url)
const VIRTUAL_ID = "\0node-sqlite-virtual"

// Proxy source: load node:sqlite via createRequire so Node's native
// module loader handles it, bypassing Vite's bundler entirely.
const NODE_SQLITE_PROXY = `
import { createRequire } from 'node:module';
const _r = createRequire(import.meta.url);
const _m = _r('node:sqlite');
export const DatabaseSync = _m.DatabaseSync;
export const StatementSync = _m.StatementSync;
`

export default defineConfig({
  plugins: [
    {
      name: "node-sqlite-virtual",
      enforce: "pre",
      resolveId(id: string) {
        // Intercept both the original `node:sqlite` import and `sqlite`
        // (what Vite's esbuild transform rewrites it to).
        if (id === "node:sqlite" || id === "sqlite") {
          return VIRTUAL_ID
        }
      },
      load(id: string) {
        if (id === VIRTUAL_ID) {
          return NODE_SQLITE_PROXY
        }
      },
    },
    {
      // SIG-477: `.wasm` imports. Cloudflare Workers resolves `import m from
      // "./x.wasm"` to a compiled `WebAssembly.Module` natively (wrangler/esbuild
      // treats `.wasm` as a module asset). Vite (under vitest) doesn't support
      // that ESM-WASM proposal, so we mirror the Workers semantics: read the bytes
      // at build time, compile them at module-eval, and default-export the
      // resulting `WebAssembly.Module`. This lets the QuickJS sandbox runner load
      // the SAME vendored module in tests that it loads in production.
      name: "wasm-module-default-export",
      enforce: "pre",
      load(id: string) {
        const clean = id.split("?")[0] ?? id
        if (!clean.endsWith(".wasm")) return
        const bytes = readFileSync(clean)
        // Embed the bytes as base64 so the emitted module is self-contained, then
        // compile synchronously to a WebAssembly.Module on first eval.
        const b64 = bytes.toString("base64")
        return `const __bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
export default new WebAssembly.Module(__bytes);`
      },
    },
  ],
  test: {
    include: ["src/**/*.test.ts", "evals/**/*.test.ts", "e2e/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // SIG-366: `@/*` → repo root (mirrors tsconfig `paths`) so vitest resolves
      // `@/...` imports the same way tsc + the wrangler/esbuild bundle do. The
      // alias is root-anchored — `@/src/...`, `@/scripts/...`, `@/e2e/...` all
      // resolve from the repo root, so one alias reaches the whole tree and the
      // path shows the exact file. `@rollup/plugin-alias` only matches a `@`
      // that is exact or followed by `/`, so npm-scoped packages like
      // `@cloudflare/*` are unaffected.
      "@": path.resolve(__dirname, "."),
      // ARC-190: Cloudflare's `cloudflare:workers` virtual module is
      // only resolvable at Workers runtime. In vitest (Node) we
      // alias it to a tiny shim that exports a DurableObject base
      // class with the surface tests need. Production builds via
      // wrangler ignore the alias.
      "cloudflare:workers": path.resolve(__dirname, "./src/test-shims/cloudflare-workers-shim.ts"),
      // SIG-545 B1: the `@cloudflare/containers` package's `Container` base
      // extends the Workers DurableObject and crashes on import in Node/vitest.
      // src/index.ts statically exports AgentRunnerContainer (extends Container),
      // so without this shim every worker-entry-importing test fails to load.
      "@cloudflare/containers": path.resolve(__dirname, "./src/test-shims/cloudflare-containers-shim.ts"),
      // sig-mcp-connections-p1: `agents/mcp/client` (McpConnectionsAgent's
      // dependency) transitively imports `partyserver`, which does
      // `import ... from "cloudflare:workers"` at module scope — same
      // externalized-node_modules problem as @cloudflare/containers above.
      // Aliased at the specifier our OWN code imports (mcp-connections-do.ts
      // imports "agents/mcp/client" directly) so Vite's resolver — not
      // Node's native loader — handles it; a deeper alias on `partyserver`
      // itself doesn't work because by the time resolution reaches a
      // dependency-of-a-dependency inside node_modules, Vite has already
      // externalized the whole subtree to Node's loader.
      "agents/mcp/client": path.resolve(__dirname, "./src/test-shims/agents-mcp-client-shim.ts"),
    },
  },
})
