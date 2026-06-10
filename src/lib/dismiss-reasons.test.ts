// SIG-173 — Direct unit coverage for the dismiss-reason label set helpers.
//
// `isDismissReason` is exported and used in `review-withdrawal-store.ts` +
// `validation-metrics.ts` to validate incoming data (the type guard is the
// trust boundary between "untyped JSON we just parsed" and the canonical
// `DismissReason` union). It was previously only covered indirectly via
// the github-mention handler tests — pin it here so a label-set drift or
// guard regression fails at this layer first.
//
// Self-review (PR #171, finding 2, P3) requested this file.

import { describe, expect, it } from "vitest"
import {
  ALL_DISMISS_REASONS,
  isDismissReason,
  parseDismissReason,
  type DismissReason,
} from "@/src/lib/dismiss-reasons"

describe("isDismissReason", () => {
  it.each<DismissReason>([
    "not-a-bug",
    "bad-anchor",
    "already-covered",
    "too-minor",
    "wrong-context",
    "unlabeled",
  ])("returns true for canonical label %p", (reason) => {
    expect(isDismissReason(reason)).toBe(true)
  })

  it("returns true for every entry in ALL_DISMISS_REASONS (drift guard)", () => {
    // If a new canonical label is added (DISMISS_REASONS_VERSION bump),
    // this loop forces the test author to confirm the guard accepts it.
    for (const reason of ALL_DISMISS_REASONS) {
      expect(isDismissReason(reason)).toBe(true)
    }
  })

  it("returns false for non-canonical strings (case + separator strict)", () => {
    // The guard is strict on shape — case-folding and separator-tolerance
    // live in `parseDismissReason`, not here. A consumer that wants the
    // forgiving parse must call parseDismissReason first and then assert
    // against the canonical label.
    expect(isDismissReason("random")).toBe(false)
    expect(isDismissReason("")).toBe(false)
    expect(isDismissReason("DISMISS")).toBe(false)
    expect(isDismissReason("Not-A-Bug")).toBe(false)
    expect(isDismissReason("not_a_bug")).toBe(false)
    expect(isDismissReason("not a bug")).toBe(false)
    expect(isDismissReason("notabug")).toBe(false)
  })

  it("returns false for numbers", () => {
    expect(isDismissReason(0)).toBe(false)
    expect(isDismissReason(42)).toBe(false)
    expect(isDismissReason(Number.NaN)).toBe(false)
  })

  it("returns false for null / undefined / booleans", () => {
    expect(isDismissReason(null)).toBe(false)
    expect(isDismissReason(undefined)).toBe(false)
    expect(isDismissReason(true)).toBe(false)
    expect(isDismissReason(false)).toBe(false)
  })

  it("returns false for non-string objects", () => {
    expect(isDismissReason([])).toBe(false)
    expect(isDismissReason({})).toBe(false)
    expect(isDismissReason(["not-a-bug"])).toBe(false)
    expect(isDismissReason({ kind: "not-a-bug" })).toBe(false)
  })
})

describe("parseDismissReason (case + separator tolerance)", () => {
  it("returns the canonical label for the canonical hyphen form", () => {
    expect(parseDismissReason("not-a-bug")).toBe("not-a-bug")
    expect(parseDismissReason("bad-anchor")).toBe("bad-anchor")
    expect(parseDismissReason("already-covered")).toBe("already-covered")
    expect(parseDismissReason("too-minor")).toBe("too-minor")
    expect(parseDismissReason("wrong-context")).toBe("wrong-context")
  })

  it("case-folds the input before alias lookup", () => {
    expect(parseDismissReason("Not-A-Bug")).toBe("not-a-bug")
    expect(parseDismissReason("NOT-A-BUG")).toBe("not-a-bug")
    expect(parseDismissReason("Too-Minor")).toBe("too-minor")
  })

  it("accepts underscore separators in place of hyphens", () => {
    expect(parseDismissReason("not_a_bug")).toBe("not-a-bug")
    expect(parseDismissReason("NOT_A_BUG")).toBe("not-a-bug")
    expect(parseDismissReason("too_minor")).toBe("too-minor")
  })

  it("accepts space separators in place of hyphens", () => {
    expect(parseDismissReason("not a bug")).toBe("not-a-bug")
    expect(parseDismissReason("too minor")).toBe("too-minor")
    expect(parseDismissReason("wrong context")).toBe("wrong-context")
  })

  it("collapses internal whitespace before alias lookup", () => {
    expect(parseDismissReason("  too   minor  ")).toBe("too-minor")
    expect(parseDismissReason("not  a  bug")).toBe("not-a-bug")
  })

  it("returns null on unknown labels (caller falls back to 'unlabeled')", () => {
    expect(parseDismissReason("random")).toBeNull()
    expect(parseDismissReason("nope")).toBeNull()
    expect(parseDismissReason("too-mnir")).toBeNull()
  })

  it("returns null on empty / whitespace-only input", () => {
    expect(parseDismissReason("")).toBeNull()
    expect(parseDismissReason("   ")).toBeNull()
  })
})
