// SIG-606 — pass-through guards for the finding-event sinks.
//
// WHY THIS FILE EXISTS: both sinks are OPTIONAL on their arg types, so forgetting
// to forward one is invisible to the compiler AND silent at runtime. That exact bug
// shipped in review: `postedFindingSink` was declared in four places and forwarded
// in none, which would have made the reconcile see an always-empty posted set and
// write `outcome: "unknown"` on every row of the corpus, forever, with no error.
//
// These are source-level assertions rather than behavioural ones because the real
// path needs a full ensemble run. They're deliberately narrow: each pins that a
// specific hand-off line still exists. If someone deletes a pass-through, this goes
// red instead of the corpus quietly going blank.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8")

describe("finding-event sink threading", () => {
  it("the dispatcher creates BOTH sinks and puts them on baseArgs", () => {
    const dispatch = read("../../../index-dispatch.ts")
    expect(dispatch).toContain("const findingEventSink: FindingEventCapture[] = []")
    expect(dispatch).toContain("const postedFindingSink: PostedFindingCapture[] = []")
    // Both must reach the ensemble via baseArgs, or nothing is ever captured.
    expect(dispatch).toMatch(/baseArgs[\s\S]{0,2000}findingEventSink,/)
    expect(dispatch).toMatch(/baseArgs[\s\S]{0,2000}postedFindingSink,/)
  })

  it("the dispatcher flushes the log exactly once", () => {
    const dispatch = read("../../../index-dispatch.ts")
    expect(dispatch).toContain("flushFindingEventLog(env, job, findingEventSink, postedFindingSink)")
    expect(dispatch.match(/flushFindingEventLog\(/g)).toHaveLength(1)
  })

  it("the orchestrator forwards findingEventSink into adjudicate", () => {
    expect(read("./orchestrator.ts")).toContain("findingEventSink: args.findingEventSink")
  })

  it("the orchestrator forwards postedFindingSink into publish — the P0 that shipped", () => {
    // Without this line every reconcile sees an empty posted set and writes `unknown`.
    expect(read("./orchestrator.ts")).toContain("postedFindingSink: args.postedFindingSink")
  })

  it("publish forwards the posted sink into persistSubmittedReview", () => {
    expect(read("./publish.ts")).toContain("postedFindingSink")
  })

  it("publish-finalize records the surviving set using the manifest's own key", () => {
    const finalize = read("./publish-finalize.ts")
    expect(finalize).toContain("postedFindingSink.push({")
    // Must reuse the manifest key, NOT re-derive from (path, headline) — a second
    // derivation site would let the join fail silently.
    expect(finalize).toContain("findingKey: f.key")
  })

  it("EVERY validator gate callback that drops/demotes also captures a candidate", () => {
    const adjudicate = read("./adjudicate.ts")
    const validationPushes = adjudicate.match(/validationSink\?\.push\(\{/g)?.length ?? 0
    const captures = adjudicate.match(/captureGateHit\(findingEventSink, \{/g)?.length ?? 0
    // One capture per gate-rejection push, PLUS the SIG-113 uncited-testing gate,
    // which drops without a validationSink push. Fewer captures than gates =
    // censored sampling in the corpus, which is the thing the table exists to avoid.
    expect(captures).toBe(validationPushes + 1)
  })
})
