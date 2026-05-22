import { defineConfig } from "vitest/config"
import path from "node:path"
import { createRequire } from "node:module"

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
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // ARC-190: Cloudflare's `cloudflare:workers` virtual module is
      // only resolvable at Workers runtime. In vitest (Node) we
      // alias it to a tiny shim that exports a DurableObject base
      // class with the surface tests need. Production builds via
      // wrangler ignore the alias.
      "cloudflare:workers": path.resolve(
        __dirname,
        "./tests/_shims/cloudflare-workers-shim.ts",
      ),
    },
  },
})
