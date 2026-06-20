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

## Harnesses

A harness lifts a finding's cited code, runs it in the sandbox, and returns an
OBJECTIVE verdict — so `reproduced` means "we ran it and saw the bug", never model
judgment. Each is pure-ish (calls `runInSandbox`) and NEVER throws.

- **`harness-redos.ts`** (SIG-477 PR-3, the first) — catastrophic-backtracking
  (ReDoS). Extracts the first RegExpLiteral from the cited code (AST), then runs a
  deterministic **two-sided** test: a BENIGN short input must return fast, AND a small
  ADVERSARIAL pump input (`pumpChar.repeat(N) + mismatch`) must TIME OUT at small N
  *and reproduce on a re-run*. Only then → `reproduced`. A SAFE regex never trips side
  two → `inconclusive` (the FP-safety; the harness NEVER refutes). No extractable
  regex / over-budget / any error → `skipped`.
  > ⚠️ **ReDoS does NOT reproduce in QuickJS** (live-confirmed, probes ×2). QuickJS's
  > regex engine (libregexp) ≠ V8's, so a V8-catastrophic regex isn't necessarily
  > catastrophic here, and a regex match is a single C call the cycle-interrupt can't
  > subdivide → textbook catastrophic regexes return `inconclusive`. The harness is
  > retained (FP-safe, never reproduces a safe regex) but is **not** the v1 wedge.
  > Faithful ReDoS reproduction needs a JS-level step-bounded backtracking simulator
  > (deferred), not engine-timeout.

- **`harness-purelogic.ts`** (SIG-477 PR-4, **the v1 wedge**) — pure-function logic
  divergence (off-by-one / fence-post / boundary / coercion). Lifts BOTH the BUGGY
  function (from `failureExample` / `astEvidence` / body fences) AND the corrected
  function (from `suggestedReplacement` / `fixExample`) into callable expressions (AST
  slice; a declaration is wrapped to yield its value), then runs both over a
  boundary-biased input **battery** in the sandbox and tallies agree/diverge. The
  **two-sided** test: `reproduced` only when they **AGREE on ≥1** input (same function
  bar a targeted defect) **AND DIVERGE on ≥1** input (the buggy code returns a
  different value somewhere) **AND** the tally re-runs identically. all-agree →
  `inconclusive` (no-divergence); all-diverge → `inconclusive` (wholesale rewrite, FP-
  safe); arity mismatch / no liftable pair / error → `skipped`. **Why this, not
  ReDoS:** a pure function's output is ENGINE-INDEPENDENT (identical in QuickJS and
  V8), the signal is a deterministic output comparison (no timeout flakiness), and a
  runaway buggy loop is BYTECODE — exactly what the opcode-cycle interrupt bounds.

Both harnesses are dispatched by `run-reproduce-pass.ts` (the eligibility loop +
per-class harness, extracted from `verify-and-build.ts`) in **SHADOW** (measure-only,
the `reproduce_eligibility` + `reproduce_result` corpora; no tier mutation, no pill).
The customer flip (annotate the `reproduced-by-execution` tier in mode `on`, render the
REPRODUCED pill) is PR-5, gated on a confirmed live reproduction + a clean shadow soak.
