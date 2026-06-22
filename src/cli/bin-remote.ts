#!/usr/bin/env node
// SIG-304 Phase 2.3 — the PUBLISHED thin-client entrypoint. Unlike bin.ts (the
// full-engine dev CLI), this ships NO engine: its whole graph is the hosted review
// path (cli-main-remote → run-review-remote + renderers + splash), so it needs no
// `cloudflare:workers` shim and no engine-telemetry buffering. esbuild bundles this
// file into the single published artifact; the bundle grep-gate proves no engine /
// model key leaked. The user supplies only $SIGILIX_API_KEY — the moat stays on the
// server.

import { cliMainRemote } from "@/src/cli/app/cli-main-remote"

cliMainRemote(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
