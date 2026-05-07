import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
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
