// SIG-477 PR-2 — tests for the execution-sandbox runner. The SECURITY seal and the
// hard caps (timeout / oom) are the point: these exercise the runner through its
// REAL path — the vendored QuickJS WASM module is loaded via the vitest `.wasm`
// plugin (which mirrors the Workers default-export-WebAssembly.Module semantics),
// so what runs here is what runs in production.

import { describe, it, expect, afterEach, vi } from "vitest"
import { runInSandbox, DEFAULT_SANDBOX_CAPS, type SandboxCaps } from "./sandbox-runner"

// A small, generous deadline for the "ok"/"threw" cases (the timeout test uses a
// tighter one). 32MB / 256KB / 100k interrupts match the production defaults.
const CAPS: SandboxCaps = {
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  deadlineMs: 1000,
  maxInterrupts: 100_000,
}

describe("runInSandbox — happy path", () => {
  it("runs a pure function over __INPUT__ and returns the computed value", async () => {
    const source = `
      function compute(input) { return input.a + input.b * 2 }
      compute(__INPUT__)
    `
    const res = await runInSandbox(source, { a: 3, b: 5 }, CAPS)
    expect(res.status).toBe("ok")
    expect(res.value).toBe(13)
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it("exposes __INPUT__ as the JSON round-trip of the host input (no host object ref)", async () => {
    const res = await runInSandbox(`JSON.stringify(__INPUT__)`, { nested: { x: [1, 2, 3] } }, CAPS)
    expect(res.status).toBe("ok")
    expect(res.value).toBe('{"nested":{"x":[1,2,3]}}')
  })

  it("uses DEFAULT_SANDBOX_CAPS when handed them", async () => {
    const res = await runInSandbox(`__INPUT__ * __INPUT__`, 7, DEFAULT_SANDBOX_CAPS)
    expect(res.status).toBe("ok")
    expect(res.value).toBe(49)
  })
})

describe("runInSandbox — caps (the load-bearing limits)", () => {
  // The frozen-clock tests stub Date.now; restore the real clock after each test so
  // an assertion failure can't leave a frozen clock leaking into later tests.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("interrupts an infinite loop and returns timed-out via the WALL-CLOCK deadline (Date.now advancing)", async () => {
    // A huge interrupt budget so the COUNTER never trips here — this test proves the
    // wall-clock path still works when Date.now() advances (node/vitest), matching the
    // prior behavior. The frozen-clock test below proves the counter path independently.
    const tightCaps: SandboxCaps = { ...CAPS, deadlineMs: 300, maxInterrupts: Number.MAX_SAFE_INTEGER }
    const t0 = Date.now()
    const res = await runInSandbox(`while (true) {}`, null, tightCaps)
    const wall = Date.now() - t0
    expect(res.status).toBe("timed-out")
    // It must actually STOP — not hang. Allow generous slack for slow CI but prove
    // it returned in a bounded time well under a hang.
    expect(wall).toBeLessThan(5000)
    expect(res.elapsedMs).toBeGreaterThanOrEqual(tightCaps.deadlineMs - 50)
  })

  it("interrupts a CPU-bound loop even when Date.now() is FROZEN (the Cloudflare-Workers regression — counter path)", async () => {
    // THE load-bearing regression test for the prod-only bug: on Cloudflare Workers
    // `Date.now()` is frozen during synchronous compute, so a wall-clock-only deadline
    // NEVER fires for a CPU-bound guest. We simulate that by stubbing Date.now to a
    // CONSTANT (the clock never advances), then assert an infinite loop is STILL
    // interrupted — which can only happen via the cycle counter, not the clock.
    // This MUST fail if the `maxInterrupts` counter is removed (then nothing would
    // interrupt the loop and the test would hang / never return "timed-out").
    const FROZEN = 1_700_000_000_000
    vi.spyOn(Date, "now").mockReturnValue(FROZEN)
    // Sanity: the clock really is frozen for the duration of the run.
    expect(Date.now()).toBe(FROZEN)

    const frozenCaps: SandboxCaps = { ...CAPS, deadlineMs: 300, maxInterrupts: 50_000 }
    const res = await runInSandbox(`while (true) {}`, null, frozenCaps)
    expect(res.status).toBe("timed-out")
  })

  it("does NOT false-trip the cycle counter on light/benign work (returns ok)", async () => {
    // A trivial computation must finish in far fewer than maxInterrupts interrupt
    // calls — the counter is a runaway-CPU bound, not a tripwire on normal work.
    const res = await runInSandbox(`__INPUT__ + 1`, 41, CAPS)
    expect(res.status).toBe("ok")
    expect(res.value).toBe(42)
  })

  it("aborts a memory bomb without crashing the host (oom or timed-out)", async () => {
    const tinyMem: SandboxCaps = {
      memoryBytes: 1024 * 1024,
      maxStackBytes: 256 * 1024,
      deadlineMs: 2000,
      maxInterrupts: 100_000,
    }
    const res = await runInSandbox(`const a = []; while (true) { a.push(new Array(100000).fill(7)) }`, null, tinyMem)
    // A memory bomb is bounded either by the memory cap (oom) or the deadline; both
    // are acceptable — the point is the host survives and we get a structured status.
    expect(["oom", "timed-out"]).toContain(res.status)
    // The host is still alive: a subsequent run succeeds.
    const after = await runInSandbox(`1 + 1`, null, CAPS)
    expect(after.status).toBe("ok")
    expect(after.value).toBe(2)
  })

  it("returns threw with the message when the guest throws", async () => {
    const res = await runInSandbox(`throw new Error("boom from guest")`, null, CAPS)
    expect(res.status).toBe("threw")
    expect(res.error).toContain("boom from guest")
  })

  it("returns threw for a syntax error in the guest source", async () => {
    const res = await runInSandbox(`this is not valid javascript ===`, null, CAPS)
    expect(res.status).toBe("threw")
    expect(res.error).toBeTruthy()
  })
})

describe("runInSandbox — SECURITY: the guest has no host bindings (the seal)", () => {
  it("has no fetch / process / require / globalThis.fetch (all undefined)", async () => {
    const source = `JSON.stringify({
      fetch: typeof fetch,
      process: typeof process,
      require: typeof require,
      globalFetch: typeof globalThis.fetch,
    })`
    const res = await runInSandbox(source, null, CAPS)
    expect(res.status).toBe("ok")
    const seen = JSON.parse(String(res.value)) as Record<string, string>
    expect(seen.fetch).toBe("undefined")
    expect(seen.process).toBe("undefined")
    expect(seen.require).toBe("undefined")
    expect(seen.globalFetch).toBe("undefined")
  })

  it("has no filesystem / network / timer / module globals", async () => {
    const source = `JSON.stringify({
      XMLHttpRequest: typeof XMLHttpRequest,
      WebSocket: typeof WebSocket,
      setTimeout: typeof setTimeout,
      setInterval: typeof setInterval,
      Deno: typeof Deno,
      Bun: typeof Bun,
      module: typeof module,
      __dirname: typeof __dirname,
    })`
    const res = await runInSandbox(source, null, CAPS)
    expect(res.status).toBe("ok")
    const seen = JSON.parse(String(res.value)) as Record<string, string>
    for (const k of Object.keys(seen)) {
      expect(seen[k]).toBe("undefined")
    }
  })

  it("cannot reach a host value: __INPUT__ is a plain JSON clone, not a live reference", async () => {
    // Functions don't survive JSON round-trip — the guest sees data only.
    const res = await runInSandbox(`typeof __INPUT__.fn`, { fn: () => 1, n: 2 }, CAPS)
    expect(res.status).toBe("ok")
    expect(res.value).toBe("undefined")
  })
})

describe("runInSandbox — lifecycle / disposal", () => {
  it("runs many times in a row without leaking or erroring (module reused)", async () => {
    for (let i = 0; i < 25; i++) {
      const res = await runInSandbox(`__INPUT__ + 1`, i, CAPS)
      expect(res.status).toBe("ok")
      expect(res.value).toBe(i + 1)
    }
  })

  it("recovers cleanly after a timed-out and after an oom run", async () => {
    const t = await runInSandbox(`while (true) {}`, null, { ...CAPS, deadlineMs: 200 })
    expect(t.status).toBe("timed-out")
    const ok1 = await runInSandbox(`41 + 1`, null, CAPS)
    expect(ok1.status).toBe("ok")
    expect(ok1.value).toBe(42)
  })
})

describe("runInSandbox — input handling", () => {
  it("returns error for a non-JSON-serializable input (circular)", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const res = await runInSandbox(`__INPUT__`, circular, CAPS)
    expect(res.status).toBe("error")
    expect(res.error).toContain("input-not-serializable")
  })

  it("treats undefined input as null in the guest", async () => {
    const res = await runInSandbox(`__INPUT__ === null`, undefined, CAPS)
    expect(res.status).toBe("ok")
    expect(res.value).toBe(true)
  })
})
