// SIG-477 PR-2 — the EXECUTION SANDBOX runner (DARK: capability only, no caller).
//
// Runs untrusted guest JavaScript inside a QuickJS WebAssembly interpreter with
// HARD memory / stack / CPU-deadline limits, returning a structured result instead
// of ever throwing. This is the engine the reproduce-by-execution arc (SIG-477)
// uses to re-run a finding's cited closure and observe the predicted failure —
// PR-3 wires the first harness in shadow, PR-5 flips it on. THIS PR ships ONLY the
// capability; nothing in the review path imports `runInSandbox`.
//
// ── SECURITY (the load-bearing property) ────────────────────────────────────
// A bare QuickJS context has NO host bindings by construction: no `fetch`, no
// `process`, no `require`, no filesystem, no network, no timers — they are simply
// absent unless a host explicitly injects them. quickjs-emscripten's own caveat is
// that it CAN expose host functions (e.g. a host `fetch`, which on Workers would
// carry host cookies) to guest code. We inject NONE. The guest sees only the
// `source` we eval and the `input` we pass as a JSON-serialized global. We never
// call `context.newFunction` / set any host bridge, so there is no escape surface
// to audit beyond "we added nothing". The runner-runs-guest tests assert the seal
// directly (`typeof fetch === "undefined"`, etc.).
//
// ── ISOLATION / LIFECYCLE ───────────────────────────────────────────────────
// The WASM module is compiled ONCE (a module-level memoized promise) and reused —
// instantiating a ~500KB WASM module per call would be wasteful. Each call gets a
// FRESH runtime + context (so no guest state leaks between runs) and disposes both
// in a `finally`, so a thrown guest, a timeout, or an OOM still frees the WASM-side
// allocations. `runInSandbox` NEVER throws: any unexpected failure returns
// `status: "error"`.

import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, shouldInterruptAfterDeadline } from "quickjs-emscripten"
import type { QuickJSWASMModule } from "quickjs-emscripten"
// The vendored RELEASE_SYNC QuickJS variant `.wasm`, committed under this dir. On
// Workers this import resolves to a compiled `WebAssembly.Module` natively; in
// node/vitest the bundler hands us the same module shape (see wasm-module.d.ts).
import quickjsWasmModule from "./quickjs-release-sync.wasm"

/** Hard limits applied to a SINGLE sandbox execution. */
export interface SandboxCaps {
  /** Runtime memory ceiling in bytes. Exceeding it aborts the guest with an
   *  out-of-memory error (→ status "oom"), never a host crash. */
  memoryBytes: number
  /** Max interpreter stack size in bytes (deep recursion → guest error). */
  maxStackBytes: number
  /** Wall-clock deadline in ms from the start of the eval. A guest that runs past
   *  it is interrupted (→ status "timed-out"). */
  deadlineMs: number
}

/** The structured outcome of a sandbox run. `runInSandbox` always resolves to one
 *  of these — it never rejects. */
export interface SandboxResult {
  /** ok — guest returned a value; threw — guest threw an error; timed-out — hit
   *  the deadline; oom — exceeded the memory cap; error — the runner itself failed
   *  unexpectedly (e.g. the WASM module couldn't initialize). */
  status: "ok" | "threw" | "timed-out" | "oom" | "error"
  /** The JSON-dumped return value, present only on status "ok". */
  value?: unknown
  /** A human-readable error message, present on "threw" / "error" (and best-effort
   *  on "timed-out" / "oom"). */
  error?: string
  /** Wall-clock time the eval took, in ms. */
  elapsedMs: number
}

/** Sensible default caps: 32MB memory, 256KB stack, 1s deadline. Small enough to
 *  bound a misbehaving guest, generous enough for a lifted pure closure. */
export const DEFAULT_SANDBOX_CAPS: SandboxCaps = {
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  deadlineMs: 1000,
}

/** The global the guest reads its (JSON-serialized) input from. */
const INPUT_GLOBAL = "__INPUT__"

// QuickJS-side error markers (from the interpreter, observed verbatim). A
// catastrophic-loop interrupt surfaces as `message: "interrupted"`; a memory-cap
// breach as `message: "out of memory"`. Anything else is a genuine guest throw.
const INTERRUPT_MARKER = "interrupted"
const OOM_MARKER = "out of memory"

/**
 * Memoized one-time WASM module init. The first caller compiles + instantiates the
 * vendored RELEASE_SYNC variant; every later caller awaits the SAME promise. The
 * module is stateless and reusable — only the per-call runtime/context carry guest
 * state. We memoize the PROMISE (not the resolved value) so concurrent first
 * callers don't double-instantiate.
 */
let modulePromise: Promise<QuickJSWASMModule> | null = null
function getQuickJSModule(): Promise<QuickJSWASMModule> {
  if (modulePromise === null) {
    const variant = newVariant(RELEASE_SYNC, { wasmModule: quickjsWasmModule })
    modulePromise = newQuickJSWASMModule(variant)
  }
  return modulePromise
}

/** Coerce a QuickJS error message into one of our terminal statuses. */
function statusForGuestError(message: string): "threw" | "timed-out" | "oom" {
  if (message.includes(INTERRUPT_MARKER)) return "timed-out"
  if (message.includes(OOM_MARKER)) return "oom"
  return "threw"
}

/**
 * Run `source` inside a fresh, fully-sealed QuickJS sandbox with the given caps,
 * exposing `input` to the guest as the JSON-serialized global `__INPUT__`. Returns
 * a structured {@link SandboxResult}; NEVER throws.
 *
 * The guest has NO host functions: no fetch / network / fs / process / require /
 * timers. It sees only `source` and `__INPUT__`. The eval is bounded by the
 * memory, stack, and wall-clock-deadline caps; a runaway loop is interrupted, an
 * over-allocation is OOM-aborted, and either way the runtime/context are disposed.
 *
 * @param source guest JavaScript to evaluate (the last expression's value is the
 *   result, per QuickJS eval semantics).
 * @param input host value exposed to the guest as `__INPUT__` (JSON round-tripped,
 *   so it must be JSON-serializable; a non-serializable input → status "error").
 * @param caps the per-call memory / stack / deadline limits.
 */
export async function runInSandbox(source: string, input: unknown, caps: SandboxCaps): Promise<SandboxResult> {
  const start = Date.now()
  const elapsed = () => Date.now() - start

  // Serialize the input OUTSIDE the try-that-owns-the-runtime so a bad input is a
  // clean "error" without ever touching the WASM. `undefined` → the guest sees
  // `__INPUT__ = undefined` (JSON.stringify(undefined) is undefined → emit "null"
  // so the injected statement stays valid JS).
  let inputJson: string
  try {
    const serialized = JSON.stringify(input)
    inputJson = serialized === undefined ? "null" : serialized
  } catch (err) {
    return {
      status: "error",
      error: `input-not-serializable: ${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: elapsed(),
    }
  }

  let QuickJS: QuickJSWASMModule
  try {
    QuickJS = await getQuickJSModule()
  } catch (err) {
    // If the module promise rejected, drop it so a later call can retry init.
    modulePromise = null
    return {
      status: "error",
      error: `module-init-failed: ${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: elapsed(),
    }
  }

  const runtime = QuickJS.newRuntime()
  let context: ReturnType<typeof runtime.newContext> | null = null
  try {
    // ── Caps ── memory + stack ceilings, then a wall-clock interrupt deadline.
    runtime.setMemoryLimit(caps.memoryBytes)
    runtime.setMaxStackSize(caps.maxStackBytes)
    // shouldInterruptAfterDeadline returns true once `Date.now() > deadline`,
    // interrupting the interpreter (QuickJS can't read wall-clock itself, so the
    // host-side handler is the standard deadline mechanism).
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + caps.deadlineMs))

    // ── Fresh context. NO host functions injected — the seal. ──
    context = runtime.newContext()

    // Inject the input as a JSON-parsed global. We build the parse expression with
    // the serialized JSON embedded as a string literal so the guest never sees a
    // host object reference — only its JSON round-trip. The eval that follows is
    // the caller's source, with the result being its last expression.
    const prelude = `globalThis.${INPUT_GLOBAL} = JSON.parse(${JSON.stringify(inputJson)});`
    const preludeResult = context.evalCode(prelude, "sandbox-prelude.js")
    if (preludeResult.error) {
      // Should never happen (we control the prelude), but treat it as a runner
      // error rather than a guest throw.
      const msg = String(context.dump(preludeResult.error))
      preludeResult.error.dispose()
      return { status: "error", error: `prelude-failed: ${msg}`, elapsedMs: elapsed() }
    }
    preludeResult.value.dispose()

    const result = context.evalCode(source, "sandbox-guest.js")
    if (result.error) {
      const dumped = context.dump(result.error)
      result.error.dispose()
      const message = errorMessageFromDump(dumped)
      return { status: statusForGuestError(message), error: message, elapsedMs: elapsed() }
    }
    const value = context.dump(result.value)
    result.value.dispose()
    return { status: "ok", value, elapsedMs: elapsed() }
  } catch (err) {
    // Any unexpected host-side failure (e.g. the interpreter aborts in a way that
    // surfaces as a thrown JS error rather than a VmCallResult error) → "error",
    // unless it's recognizably an interrupt/OOM, which we map to its status.
    const message = err instanceof Error ? err.message : String(err)
    const mapped = statusForGuestError(message)
    return { status: mapped === "threw" ? "error" : mapped, error: message, elapsedMs: elapsed() }
  } finally {
    // ALWAYS free the WASM-side allocations: context first, then runtime. The
    // memoized module is intentionally NOT disposed (it's reused across calls).
    if (context !== null) context.dispose()
    runtime.dispose()
  }
}

/** Best-effort human-readable message from a dumped QuickJS error value (which may
 *  be a structured `{name, message, stack}` object or a primitive). */
function errorMessageFromDump(dumped: unknown): string {
  if (dumped !== null && typeof dumped === "object") {
    const obj = dumped as { name?: unknown; message?: unknown }
    const name = typeof obj.name === "string" ? obj.name : ""
    const message = typeof obj.message === "string" ? obj.message : ""
    if (name && message) return `${name}: ${message}`
    if (message) return message
    if (name) return name
  }
  return String(dumped)
}
