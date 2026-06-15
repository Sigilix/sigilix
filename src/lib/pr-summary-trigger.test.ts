// SIG-437 — `decidePrSummaryJob` gate tests. The webhook trigger decision:
// flag + body-bearing action + head SHA + a fresh in-body trigger.

import { describe, it, expect } from "vitest"

import { decidePrSummaryJob } from "@/src/lib/pr-summary-trigger"

const base = {
  mode: "on",
  mentionTriggers: undefined,
  action: "opened",
  owner: "o",
  repo: "r",
  prNumber: 5,
  headSha: "a".repeat(40),
  body: "@sigilix summary",
  installationId: 1,
}

describe("decidePrSummaryJob", () => {
  it("returns the job when flag on + body-bearing action + head SHA + trigger", () => {
    expect(decidePrSummaryJob(base)).toEqual({
      type: "pr-summary",
      owner: "o",
      repo: "r",
      prNumber: 5,
      headSha: "a".repeat(40),
      installationId: 1,
    })
  })

  it("null when flag off / unset", () => {
    expect(decidePrSummaryJob({ ...base, mode: "off" })).toBeNull()
    expect(decidePrSummaryJob({ ...base, mode: undefined })).toBeNull()
  })

  it("null on a non-body-bearing action", () => {
    expect(decidePrSummaryJob({ ...base, action: "synchronize" })).toBeNull()
    expect(decidePrSummaryJob({ ...base, action: "closed" })).toBeNull()
    expect(decidePrSummaryJob({ ...base, action: undefined })).toBeNull()
  })

  it("fires on each body-bearing action", () => {
    for (const action of ["opened", "edited", "reopened", "ready_for_review"]) {
      expect(decidePrSummaryJob({ ...base, action })?.type).toBe("pr-summary")
    }
  })

  it("null when no head SHA", () => {
    expect(decidePrSummaryJob({ ...base, headSha: "" })).toBeNull()
    expect(decidePrSummaryJob({ ...base, headSha: undefined })).toBeNull()
  })

  it("null when the marker is absent", () => {
    expect(decidePrSummaryJob({ ...base, body: "a normal description" })).toBeNull()
    expect(decidePrSummaryJob({ ...base, body: null })).toBeNull()
  })

  it("null when the only marker is inside an existing managed block (no re-trigger)", () => {
    const body = "<!-- sigilix:summary:start -->\n@sigilix summary echoed\n<!-- sigilix:summary:end -->"
    expect(decidePrSummaryJob({ ...base, body })).toBeNull()
  })

  it("honors custom mention triggers", () => {
    expect(decidePrSummaryJob({ ...base, body: "@mybot summary", mentionTriggers: "mybot" })?.type).toBe("pr-summary")
    expect(decidePrSummaryJob({ ...base, body: "@mybot summary" })).toBeNull()
  })
})
