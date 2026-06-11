// SIG-86 — Logpush envelope unwrap unit tests.
// Code-reviewer M3 + M4 on PR review: the unwrap heuristic ships with
// the CLI but was untested. These cases pin the contract against the
// actual CF Workers Logpush schema (Message-as-array, double-encoding,
// envelope-timestamp backfill) so a real prod dump can't silently
// land in `badLines`.

import { describe, it, expect } from "vitest"

import { unwrapLogpushEnvelope } from "@/src/lib/bakeoff-logpush-unwrap"

describe("unwrapLogpushEnvelope", () => {
  it("passes through a flat event object unchanged", () => {
    const flat = { event: "shadow-cut-short", ts: "2026-05-15T12:00:00Z", role: "synth" }
    expect(unwrapLogpushEnvelope(flat)).toBe(flat)
  })

  it("returns null for primitives / nulls / non-object input", () => {
    expect(unwrapLogpushEnvelope(null)).toBeNull()
    expect(unwrapLogpushEnvelope(undefined)).toBeNull()
    expect(unwrapLogpushEnvelope("plain string")).toBeNull()
    expect(unwrapLogpushEnvelope(42)).toBeNull()
  })

  it("returns null when neither `event` nor `Logs` is present", () => {
    expect(unwrapLogpushEnvelope({ unrelated: true })).toBeNull()
  })

  it("unwraps the CF workers_trace_events envelope shape (Message as array)", () => {
    // From the Cloudflare docs sample: Logs[].Message is an ARRAY of
    // strings, one per console.log argument.
    const envelope = {
      Outcome: "ok",
      ScriptName: "sigilix",
      EventTimestampMs: 1_748_000_000_000, // 2025-05-23T11:33:20Z
      Logs: [
        {
          Level: "log",
          Message: [
            JSON.stringify({
              event: "shadow-verdict-comparison",
              role: "synth",
              prodModel: "kimi",
            }),
          ],
        },
      ],
    }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.event).toBe("shadow-verdict-comparison")
    expect(inner.role).toBe("synth")
    expect(inner.prodModel).toBe("kimi")
    // EventTimestampMs backfilled onto the inner event as ISO.
    expect(inner.ts).toBe("2025-05-23T11:33:20.000Z")
  })

  it("unwraps when Message is a single string (some Logpush configs)", () => {
    const envelope = {
      Logs: [
        {
          Message: JSON.stringify({
            event: "shadow-cut-short",
            role: "synth",
            ts: "2026-05-15T12:00:00Z",
          }),
        },
      ],
    }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.event).toBe("shadow-cut-short")
    // Inner's own `ts` wins — envelope doesn't override.
    expect(inner.ts).toBe("2026-05-15T12:00:00Z")
  })

  it("recovers from a DOUBLE-ENCODED JSON payload (Logpush re-stringifies once)", () => {
    // Some Logpush pipelines re-serialize the inner string, so the
    // first JSON.parse yields a string, and the actual event lives
    // inside one more parse. Heuristic recurses once.
    const innerJson = JSON.stringify({
      event: "shadow-run-failed",
      role: "logic",
      message: "BOOM",
      ts: "2026-05-15T12:00:00Z",
    })
    const doubleEncoded = JSON.stringify(innerJson) // string-of-a-string
    const envelope = { Logs: [{ Message: doubleEncoded }] }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.event).toBe("shadow-run-failed")
    expect(inner.role).toBe("logic")
    expect(inner.message).toBe("BOOM")
  })

  it("returns null when Message contains valid JSON but no `event` field", () => {
    const envelope = {
      Logs: [{ Message: JSON.stringify({ unrelated: "data" }) }],
    }
    expect(unwrapLogpushEnvelope(envelope)).toBeNull()
  })

  it("returns null on a malformed Message", () => {
    const envelope = { Logs: [{ Message: "{not-valid-json" }] }
    expect(unwrapLogpushEnvelope(envelope)).toBeNull()
  })

  it("backfills timestamp from EventTimestampMs as a number", () => {
    const envelope = {
      EventTimestampMs: 1_700_000_000_000,
      Logs: [{ Message: JSON.stringify({ event: "shadow-cut-short", role: "synth" }) }],
    }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.ts).toBe("2023-11-14T22:13:20.000Z")
  })

  it("backfills timestamp from EventTimestampMs as a string", () => {
    const envelope = {
      EventTimestampMs: "2026-05-15T12:00:00Z",
      Logs: [{ Message: JSON.stringify({ event: "shadow-cut-short", role: "synth" }) }],
    }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.ts).toBe("2026-05-15T12:00:00Z")
  })

  it("falls back to lowercase `logs` / `message` keys", () => {
    const envelope = {
      logs: [
        {
          message: JSON.stringify({
            event: "shadow-cut-short",
            role: "synth",
            ts: "2026-05-15T12:00:00Z",
          }),
        },
      ],
    }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.event).toBe("shadow-cut-short")
  })

  it("recovers the JSON payload from a TRUE multi-element Message array (label + JSON)", () => {
    // CR Major catch on the original fixture: my v1 joined `Message[]`
    // with a space, which broke `console.log("label", JSON.stringify(...))`
    // payloads (the joined "label {...}" is invalid JSON and every line
    // got dropped). The new heuristic tries each element individually
    // BEFORE falling back to the joined string, so the JSON in
    // element[1] is recovered cleanly.
    const innerJson = JSON.stringify({
      event: "shadow-cut-short",
      role: "synth",
      ts: "2026-05-15T12:00:00Z",
    })
    const envelope = { Logs: [{ Message: ["[shadow-runner]", innerJson] }] }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.event).toBe("shadow-cut-short")
    expect(inner.role).toBe("synth")
  })

  it("recovers when the JSON payload is the first element of the Message array", () => {
    const innerJson = JSON.stringify({
      event: "shadow-cut-short",
      role: "synth",
      ts: "2026-05-15T12:00:00Z",
    })
    const envelope = { Logs: [{ Message: [innerJson, "trailing-debug-info"] }] }
    const inner = unwrapLogpushEnvelope(envelope) as Record<string, unknown>
    expect(inner.event).toBe("shadow-cut-short")
  })

  it("returns null when Logs[] is empty", () => {
    expect(unwrapLogpushEnvelope({ Logs: [] })).toBeNull()
  })
})
