// SIG-318 (PR 0b): golden-output safety harness — capture/replay serde.
//
// The linchpin that proves ZERO behavior change across the ensemble
// decomposition. Two pure seams in `triage-pr-review-ensemble.ts` —
// `validateForSubmission` (the validation god-call) and
// `buildReviewSubmissionWithMetadata` (the render god-call) — are captured
// (flag-gated, off by default everywhere incl. prod + tests) and replayed
// later for byte-identical parity (see `tests/ensemble-golden-parity.test.ts`).
//
// Workers can't write files, so `captureGolden` emits a tagged log line; the
// JSON is copied from the logs into `tests/_golden/ensemble-fixtures/*.json`
// in a separate (founder-driven) step. This module owns only the MECHANISM:
// the structural (de)serializer + the flag-gated emit hook. It lives in
// `src/lib` (not `tests/`) so the in-god-file hook imports it without a
// src→tests dependency.
//
// Serde scope (the only non-JSON-native shapes the two seams carry):
//   - `Map` — incl. nested `Map<number, string>` (`addedLineTextByLine`) and
//     `Map<string, …>` (`reviewable`, `securityManifest`, …).
//   - `Set` — `coverageGaps`, `droppedPaths`.
//   - plain objects / arrays / primitives — passed through structurally.
//   - functions (the `on*Dropped` telemetry callbacks) — DROPPED on encode,
//     reconstituted as recording no-op STUBS on decode. The callbacks only
//     emit telemetry; they never affect the returned (validated / built)
//     value, so dropping them is parity-safe.
//
// `undefined` is preserved structurally (JSON.stringify would silently drop
// an `undefined` object property / array hole) so an optional field present-
// as-undefined round-trips identically.

import type { Env } from "@/src/shared/types/env"

/** Tag markers for the non-JSON-native shapes the encoder emits. */
const T_MAP = "Map"
const T_SET = "Set"
const T_UNDEFINED = "undefined"
const T_FUNCTION = "fn"

interface EncodedMap {
  __t: typeof T_MAP
  v: [unknown, unknown][]
}
interface EncodedSet {
  __t: typeof T_SET
  v: unknown[]
}
interface EncodedUndefined {
  __t: typeof T_UNDEFINED
}
interface EncodedFunction {
  __t: typeof T_FUNCTION
}

function isTagged(v: unknown): v is { __t: string } {
  return typeof v === "object" && v !== null && "__t" in v
}

/**
 * Structurally serialize a value so `decode(encode(x))` reconstructs the
 * same shape (Map/Set/object/array/primitive). Functions become a
 * `{__t:"fn"}` marker (dropped → stubbed on decode). `undefined` becomes a
 * `{__t:"undefined"}` marker so it survives a JSON round-trip.
 *
 * Plain-object keys named `__t` would collide with the tag discriminator;
 * the two captured seams carry no such keys, so this is safe in practice.
 */
export function encode(value: unknown): unknown {
  if (value === undefined) {
    return { __t: T_UNDEFINED } satisfies EncodedUndefined
  }
  if (value === null) return null
  if (typeof value === "function") {
    return { __t: T_FUNCTION } satisfies EncodedFunction
  }
  if (value instanceof Map) {
    return {
      __t: T_MAP,
      v: [...value.entries()].map(([k, val]) => [encode(k), encode(val)]),
    } satisfies EncodedMap
  }
  if (value instanceof Set) {
    return {
      __t: T_SET,
      v: [...value.values()].map((val) => encode(val)),
    } satisfies EncodedSet
  }
  if (Array.isArray(value)) {
    return value.map((val) => encode(val))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encode(val)
    }
    return out
  }
  // string | number | boolean | bigint — JSON-native (bigint would throw at
  // JSON.stringify, but the captured seams carry none).
  return value
}

/**
 * A reconstituted function stub: a no-op that RECORDS its calls (so a replay
 * harness can assert call shape if it ever needs to) while never affecting
 * the value the seam returns. Replaces every encoded function on decode.
 */
export interface RecordingStub {
  (...args: unknown[]): void
  /** Args of every invocation, in order. */
  readonly calls: unknown[][]
}

function makeRecordingStub(): RecordingStub {
  const calls: unknown[][] = []
  const stub = ((...args: unknown[]): void => {
    calls.push(args)
  }) as RecordingStub
  Object.defineProperty(stub, "calls", { value: calls, enumerable: false })
  return stub
}

/**
 * Inverse of `encode`. Reconstructs Map/Set/object/array/primitive and turns
 * every `{__t:"fn"}` marker back into a fresh recording no-op stub and every
 * `{__t:"undefined"}` marker back into `undefined`.
 */
export function decode(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) {
    return value.map((val) => decode(val))
  }
  if (isTagged(value)) {
    switch (value.__t) {
      case T_UNDEFINED:
        return undefined
      case T_FUNCTION:
        return makeRecordingStub()
      case T_MAP: {
        const { v } = value as EncodedMap
        return new Map(v.map(([k, val]) => [decode(k), decode(val)]))
      }
      case T_SET: {
        const { v } = value as EncodedSet
        return new Set(v.map((val) => decode(val)))
      }
      default:
        // Unknown tag: fall through to plain-object decode (forward-compat).
        break
    }
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decode(val)
    }
    return out
  }
  return value
}

/**
 * A captured golden fixture for one ensemble run. All payload fields hold
 * ENCODED values (run them through `decode` before replaying). `trace` is the
 * set of in-scope decision values at the render seam (specialist coverage,
 * consensus ranking, delta, verdict-gate override, token ledger, …) — kept
 * for diagnosis, not asserted by the parity test.
 */
export interface EnsembleGoldenFixture {
  label: string
  capturedAt: string
  validate: { args: unknown; output: unknown }
  render: { input: unknown; output: unknown; trace: unknown }
}

type GoldenStage = "validate" | "render"

/**
 * Flag-gated capture hook. ONLY when `env.OPENCLAW_GOLDEN_CAPTURE === "on"`
 * does it encode the payload and `console.log` a tagged line:
 *
 *   [[GOLDEN:validate]] {…encoded…}
 *   [[GOLDEN:render]]   {…encoded…}
 *
 * Off / unset (the default everywhere incl. prod + tests) → an immediate
 * no-op, so wiring this at the two seams is byte-identical behavior. Workers
 * can't write files; the JSON is lifted from the logs into a fixture later.
 *
 * Best-effort: a serialization failure is swallowed (logged once) — capturing
 * a golden sample must NEVER break a live review.
 */
export function captureGolden(env: Env, stage: GoldenStage, payload: unknown): void {
  if (env.OPENCLAW_GOLDEN_CAPTURE !== "on") return
  try {
    console.log(`[[GOLDEN:${stage}]] ${JSON.stringify(encode(payload))}`)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "ensemble-golden-capture-failed",
        stage,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
