// SIG-161 PR 4a — gate-config.ts unit tests.
//
// Tests for the KV-backed threshold + model artifact reader. Both
// values default to safe values (threshold 1.0, model null) when KV
// is missing — PR 4a ships with KV empty; PR 4c populates both.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../src/shared/types/env"
import {
  DEFAULT_GATE_THRESHOLD,
  GATE_MODEL_KV_KEY,
  GATE_THRESHOLD_KV_KEY,
  parseGateModel,
  readGateMode,
  readGateModel,
  readGateThreshold,
  __resetGateConfigCacheForTests,
} from "../src/lib/gate-config"

beforeEach(() => {
  __resetGateConfigCacheForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    ...overrides,
  } as Env
}

describe("readGateMode (SIG-161)", () => {
  it("defaults to 'off' when env var absent", () => {
    expect(readGateMode(makeEnv())).toBe("off")
  })

  it("defaults to 'off' on empty string", () => {
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "" }))).toBe("off")
  })

  it("recognises 'shadow' and 'enforce'", () => {
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "shadow" }))).toBe("shadow")
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "enforce" }))).toBe("enforce")
  })

  it("normalizes case + whitespace", () => {
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "  SHADOW  " }))).toBe("shadow")
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "ENFORCE" }))).toBe("enforce")
  })

  it("treats unknown values as 'off' (defense vs typos / legacy 'post')", () => {
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "post" }))).toBe("off")
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "on" }))).toBe("off")
    expect(readGateMode(makeEnv({ OPENCLAW_GATE: "true" }))).toBe("off")
  })
})

describe("readGateThreshold (SIG-161)", () => {
  it("returns DEFAULT_GATE_THRESHOLD (1.0) when KV is empty", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue(null)
    expect(await readGateThreshold(env)).toBe(DEFAULT_GATE_THRESHOLD)
    expect(env.OPENCLAW_STATE.get).toHaveBeenCalledWith(GATE_THRESHOLD_KV_KEY)
  })

  it("parses a numeric value from KV", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue("0.85")
    expect(await readGateThreshold(env)).toBe(0.85)
  })

  it("clamps out-of-range values silently", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue("2.5")
    expect(await readGateThreshold(env)).toBe(1.0)
  })

  it("clamps negative values to 0", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue("-0.5")
    expect(await readGateThreshold(env)).toBe(0)
  })

  it("falls back to default on unparseable value", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue("not-a-number")
    expect(await readGateThreshold(env)).toBe(DEFAULT_GATE_THRESHOLD)
  })

  it("falls back to default on a blank/whitespace-only KV value", async () => {
    // `Number("")` and `Number("   ")` both return 0 — without the
    // trim+nonempty guard, a malformed value would silently produce
    // the most aggressive threshold (gateScore >= 0 blocks every
    // surviving finding) in shadow/enforce.
    for (const blank of ["", "   ", "\t\n"]) {
      __resetGateConfigCacheForTests()
      const env = makeEnv()
      vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue(blank)
      expect(await readGateThreshold(env)).toBe(DEFAULT_GATE_THRESHOLD)
    }
  })

  it("scopes cache by KV binding (different bindings do NOT share cache)", async () => {
    // Codex P2: a process-global cache could leak threshold reads
    // across `Env`/KV bindings. The WeakMap keyed on the KV binding
    // prevents that — two different bindings get independent entries.
    const envA = makeEnv()
    const envB = makeEnv()
    vi.mocked(envA.OPENCLAW_STATE.get).mockResolvedValue("0.85")
    vi.mocked(envB.OPENCLAW_STATE.get).mockResolvedValue("0.65")
    expect(await readGateThreshold(envA)).toBe(0.85)
    expect(await readGateThreshold(envB)).toBe(0.65)
    // Re-read each — both should hit their own cached slot, not leak.
    expect(await readGateThreshold(envA)).toBe(0.85)
    expect(await readGateThreshold(envB)).toBe(0.65)
    expect(envA.OPENCLAW_STATE.get).toHaveBeenCalledTimes(1)
    expect(envB.OPENCLAW_STATE.get).toHaveBeenCalledTimes(1)
  })

  it("survives a KV read throw", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockRejectedValue(new Error("kv down"))
    expect(await readGateThreshold(env)).toBe(DEFAULT_GATE_THRESHOLD)
  })

  it("caches the result for 60s (subsequent reads don't hit KV)", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue("0.85")
    await readGateThreshold(env)
    await readGateThreshold(env)
    await readGateThreshold(env)
    expect(env.OPENCLAW_STATE.get).toHaveBeenCalledTimes(1)
  })

  it("single-flight: concurrent cold-cache reads share one KV roundtrip", async () => {
    // The single-flight property: two concurrent requests on the same
    // isolate during a cold-cache window MUST hit KV exactly once.
    // Without the Promise-cache, both would pass the expiry check and
    // both fire OPENCLAW_STATE.get. PR 4c's `enforce` mode under real
    // traffic depends on this.
    const env = makeEnv()
    // Hold the KV resolve so both reads race the cache slot.
    let resolveGet: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      resolveGet = resolve
    })
    vi.mocked(env.OPENCLAW_STATE.get).mockReturnValue(pending as unknown as Promise<string>)

    // Two concurrent readers — both should see kind:"pending" and await
    // the same Promise, NOT fire a second KV.get.
    const a = readGateThreshold(env)
    const b = readGateThreshold(env)
    resolveGet("0.75")
    expect(await a).toBe(0.75)
    expect(await b).toBe(0.75)
    expect(env.OPENCLAW_STATE.get).toHaveBeenCalledTimes(1)
  })
})

describe("readGateModel (SIG-161)", () => {
  const validModel = {
    version: 1 as const,
    intercept: -1.2,
    coefs: [0.5, 0.3, 0.1, 0.2],
    featureNames: ["conf", "evidence", "agreement", "severity"],
  }

  it("returns null when KV is empty (PR 4a default — no model committed yet)", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue(null)
    expect(await readGateModel(env)).toBeNull()
    expect(env.OPENCLAW_STATE.get).toHaveBeenCalledWith(GATE_MODEL_KV_KEY)
  })

  it("parses a valid model artifact", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue(JSON.stringify(validModel))
    const out = await readGateModel(env)
    expect(out).toEqual(validModel)
  })

  it("returns null on malformed JSON", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue("{ not json")
    expect(await readGateModel(env)).toBeNull()
  })

  it("survives a KV read throw", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockRejectedValue(new Error("kv down"))
    expect(await readGateModel(env)).toBeNull()
  })

  it("caches the null result so repeat absence doesn't re-hit KV", async () => {
    const env = makeEnv()
    vi.mocked(env.OPENCLAW_STATE.get).mockResolvedValue(null)
    await readGateModel(env)
    await readGateModel(env)
    expect(env.OPENCLAW_STATE.get).toHaveBeenCalledTimes(1)
  })
})

describe("parseGateModel (SIG-161)", () => {
  const valid = {
    version: 1,
    intercept: -1.2,
    coefs: [0.5, 0.3, 0.1, 0.2],
    featureNames: ["conf", "evidence", "agreement", "severity"],
  }

  it("accepts a valid v1 model", () => {
    expect(parseGateModel(JSON.stringify(valid))).toEqual(valid)
  })

  it("rejects non-v1 version (future-proof against schema drift)", () => {
    expect(parseGateModel(JSON.stringify({ ...valid, version: 2 }))).toBeNull()
  })

  it("rejects non-finite intercept", () => {
    // JSON.stringify converts Infinity/NaN to null, so the only path
    // a non-finite value can land in `raw` is a typed string field.
    expect(parseGateModel(JSON.stringify({ ...valid, intercept: "NaN" }))).toBeNull()
    expect(parseGateModel(JSON.stringify({ ...valid, intercept: "Infinity" }))).toBeNull()
  })

  it("rejects string-typed numeric intercept (PR #145 CodeRabbit)", () => {
    // `Number("0.5")` returns 0.5 — the old `Number(obj.intercept)`
    // pattern silently accepted string-encoded floats from a hand-
    // edited / malformed KV value. The strict `typeof === "number"`
    // check rejects them; the calibration script's output is required
    // to be JSON numbers, not strings.
    expect(parseGateModel(JSON.stringify({ ...valid, intercept: "0.5" }))).toBeNull()
    expect(parseGateModel(JSON.stringify({ ...valid, intercept: "-1.2" }))).toBeNull()
    expect(parseGateModel(JSON.stringify({ ...valid, intercept: "0" }))).toBeNull()
  })

  it("rejects when coefs / featureNames lengths mismatch", () => {
    expect(
      parseGateModel(JSON.stringify({ ...valid, coefs: [0.5, 0.3] })),
    ).toBeNull()
  })

  it("rejects when coefs contains non-numbers", () => {
    expect(
      parseGateModel(JSON.stringify({ ...valid, coefs: [0.5, "nope", 0.1, 0.2] })),
    ).toBeNull()
  })

  it("rejects when featureNames contains empty strings", () => {
    expect(
      parseGateModel(JSON.stringify({ ...valid, featureNames: ["", "b", "c", "d"] })),
    ).toBeNull()
  })

  it("preserves optional calibratedAt timestamp", () => {
    const withTs = { ...valid, calibratedAt: "2026-05-23T16:00:00Z" }
    expect(parseGateModel(JSON.stringify(withTs))?.calibratedAt).toBe(
      "2026-05-23T16:00:00Z",
    )
  })
})
