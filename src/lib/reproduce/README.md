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
  divergence (off-by-one / fence-post / boundary / coercion). Runs the BUGGY function and
  the corrected function side-by-side over a boundary-biased input **battery** and tallies
  agree/diverge. Decision: `reproduced` iff they **DIVERGE on ≥1** input AND the tally
  re-runs identically; all-AGREE (diverge=0) → `inconclusive` (the fix is a no-op on the
  battery — the FP-safety floor: a behavior-PRESERVING change never reproduces). all-DIVERGE
  is NOT special-cased — under reconstruction (below) the two are never unrelated functions,
  so all-diverge is a real constant-offset bug. Lifting **strips TS types** and selects the
  OUTERMOST function. **Why this, not ReDoS:** a pure function's output is ENGINE-INDEPENDENT
  (identical in QuickJS and V8), the signal is a deterministic output comparison (no timeout
  flakiness), and a runaway loop is BYTECODE — exactly what the opcode-cycle interrupt bounds.
  - **Type-aware battery**: each param is swept over an IN-TYPE pool from its TS annotation
    (+ the function's own numeric literals ±1 for boundary comparisons); an `any`/untyped
    param gets the full mixed pool. Plus a CANONICAL (object-key-order-insensitive) result
    serializer. Together these stop a type-correct equivalent rewrite (`x*2` vs `x+x`) or an
    object-key reorder (`{x,y}` vs `{y,x}`) from FALSELY diverging.

- **`../ensemble/app/reconstruct-pure-logic.ts`** (SIG-477 PR-4b) — the INPUT layer. Real
  findings cite code at the LINE level (a one-line `suggestedReplacement`), not a whole
  function. So reconstruct the pair from the full NEW-side file source: find the smallest
  function enclosing `finding.line` (the BUGGY fn), splice the suggestion in (the FIXED fn),
  feed the harness that pair. Fail-opens to skip on a LEFT anchor / missing source / no
  enclosing fn / unchanged fn. Without this the harness never fires on real findings.

The harnesses are dispatched by `../ensemble/app/run-reproduce-pass.ts` (eligibility loop +
reconstruction + per-class harness). FP-safety + recall are measured by the corpus eval
`e2e/reproduce-fp-eval.test.ts` (`npm run reproduce-fp-eval`): **100% recall, 0% over-fire**
on behavior-preserving changes, modelfp=100% worst-case (the harness proves divergence, not
wrongness — REPRODUCED therefore requires the finding to be GROUNDED first). Customer flip
(SIG-477 PR-5): annotate the `reproduced-by-execution` tier in mode `on`, render the
REPRODUCED pill, suppress the model-authored `failureExample` overclaim.
