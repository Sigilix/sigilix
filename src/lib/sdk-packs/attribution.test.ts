// SIG-298 follow-on — parseSdkGuidanceMarkers: strips `[sdk:<packId>]`
// markers from finding body text and returns the deduped, first-seen-order
// pack ids referenced.

import { describe, expect, it } from "vitest"

import { parseSdkGuidanceMarkers } from "./attribution"

describe("parseSdkGuidanceMarkers", () => {
  it("returns the text unchanged with no packIds when there's no marker", () => {
    const { text, packIds } = parseSdkGuidanceMarkers("This is a plain finding body with no marker.")
    expect(text).toBe("This is a plain finding body with no marker.")
    expect(packIds).toEqual([])
  })

  it("strips a trailing marker and returns the pack id", () => {
    const { text, packIds } = parseSdkGuidanceMarkers("Missing signature verification on the webhook. [sdk:stripe]")
    expect(text).toBe("Missing signature verification on the webhook.")
    expect(packIds).toEqual(["stripe"])
  })

  it("strips a marker anywhere in the text, not just at the end", () => {
    const { text, packIds } = parseSdkGuidanceMarkers("Bad [sdk:stripe] pattern here.")
    expect(text).toBe("Bad pattern here.")
    expect(packIds).toEqual(["stripe"])
  })

  it("dedupes repeated markers and preserves first-seen order", () => {
    const { text, packIds } = parseSdkGuidanceMarkers("Body [sdk:nextjs] more text [sdk:stripe] tail [sdk:nextjs]")
    expect(text).toBe("Body more text tail")
    expect(packIds).toEqual(["nextjs", "stripe"])
  })

  it("normalizes pack id casing to lowercase", () => {
    const { packIds } = parseSdkGuidanceMarkers("Body [sdk:STRIPE]")
    expect(packIds).toEqual(["stripe"])
  })

  it("never leaks raw marker syntax into the returned text", () => {
    const { text } = parseSdkGuidanceMarkers("Multiple [sdk:a] markers [sdk:b] in [sdk:c] one body.")
    expect(text).not.toContain("[sdk:")
  })

  it("does not touch an unrelated bracketed string", () => {
    const { text, packIds } = parseSdkGuidanceMarkers("See [config] for details, not a marker.")
    expect(text).toBe("See [config] for details, not a marker.")
    expect(packIds).toEqual([])
  })
})
