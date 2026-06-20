# `reproduce/` — execution sandbox (SIG-477)

The QuickJS-WASM execution sandbox that powers the `reproduced-by-execution` trust
tier: run an audited harness over a finding's cited pure code and observe an
objective failure, so REPRODUCED means "we ran it and saw the bug" (never model
judgment). See `~/sigilix-execution-sandbox-design.md` + Linear SIG-477.

## Vendored binary: `quickjs-release-sync.wasm`

- **Source:** `@jitl/quickjs-wasmfile-release-sync@0.32.0` → `dist/emscripten-module.wasm`
  (a sub-package of [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten), MIT).
- **Why vendored:** Cloudflare Workers can't fetch the `.wasm` from node_modules at
  runtime — the documented CF pattern is to import a copied `.wasm` as a
  `WebAssembly.Module` (`newVariant(RELEASE_SYNC, { wasmModule })`). RELEASE_SYNC =
  smallest prod variant, no source maps. ~491 KB (~250 KB gzip in-bundle).
- **Re-vendor / verify:** copy the file from the installed package and byte-compare:
  `cmp src/lib/reproduce/quickjs-release-sync.wasm node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm`
  (must be IDENTICAL). Bump `quickjs-emscripten` in package.json → re-copy → re-verify.
- Committed (CI/deploy needs it) + prettier-ignored (binary).

## Security boundary (the seal)

`runInSandbox` injects **NO host functions** — a bare QuickJS context with
`DefaultIntrinsics` (pure JS only: no fetch/fs/network/process/timers/require). The
guest sees ONLY the eval'd source + a JSON-cloned `__INPUT__` global. quickjs-emscripten's
one documented danger (exposing host `fetch` with cookies) is avoided by never wiring
any host bridge. Caps (memory / max-stack / deadline-interrupt) are set on the runtime
BEFORE any `evalCode`; context + runtime disposed in `finally` on every path;
`runInSandbox` never throws. Per-PR aggregate budget in `sandbox-budget.ts`.
