// SIG-395 — pure dispatch-policy tests: the per-family precondition table,
// the breadth gate, and the prompt builder's contracts.

import { describe, expect, it } from "vitest"
import {
  countAddedLines,
  decideInvariantDispatch,
  decideInvariantExecution,
  parseInvariantLensRecallContract,
  parseInvariantLensMode,
} from "@/src/lib/ensemble/domain/invariant-lens"
import { INVARIANT_FAMILIES, buildInvariantFamilyPrompt } from "@/src/prompts/specialists/invariant-lens"

const IDS = INVARIANT_FAMILIES.map((f) => f.id)

const decide = (diff: string, files = 3, added = 200, mode: "off" | "shadow" | "on" = "shadow") =>
  decideInvariantDispatch({ mode, familyIds: IDS, diff, changedFileCount: files, addedLineCount: added })

describe("parseInvariantLensMode", () => {
  it("defaults off, normalizes shadow/on", () => {
    expect(parseInvariantLensMode(undefined)).toBe("off")
    expect(parseInvariantLensMode("bogus")).toBe("off")
    expect(parseInvariantLensMode(" Shadow ")).toBe("shadow")
    expect(parseInvariantLensMode("ON")).toBe("on")
  })
})

describe("parseInvariantLensRecallContract", () => {
  it("defaults to blocking and only accepts explicit recall-safe contracts", () => {
    expect(parseInvariantLensRecallContract(undefined)).toBe("blocking")
    expect(parseInvariantLensRecallContract("")).toBe("blocking")
    expect(parseInvariantLensRecallContract(" Shadow-Background ")).toBe("shadow-background")
    expect(parseInvariantLensRecallContract(" Pending-Check-Amendment ")).toBe("pending-check-amendment")
    expect(parseInvariantLensRecallContract("detached")).toBe("blocking")
    expect(parseInvariantLensRecallContract("background")).toBe("blocking")
  })
})

describe("decideInvariantExecution", () => {
  it("allows telemetry-only shadow background work", () => {
    expect(decideInvariantExecution({ mode: "shadow", recallContract: "shadow-background" })).toEqual({
      kind: "background",
      effectiveRecallContract: "shadow-background",
    })
  })

  it("fails closed when mode=on tries to use a shadow-only background contract", () => {
    expect(decideInvariantExecution({ mode: "on", recallContract: "shadow-background" })).toEqual({
      kind: "blocking",
      effectiveRecallContract: "blocking",
      refusalReason: "mode-on-requires-blocking",
    })
  })

  it("fails closed for pending-check amendments until the merge-gated follow-up surface exists", () => {
    expect(decideInvariantExecution({ mode: "on", recallContract: "pending-check-amendment" })).toEqual({
      kind: "blocking",
      effectiveRecallContract: "blocking",
      refusalReason: "pending-check-amendment-unavailable",
    })
  })

  it("allows pending-check amendments only when mode=on and the merge-gated lane is available", () => {
    const supported = {
      mode: "on",
      recallContract: "pending-check-amendment",
      amendmentLaneAvailable: true,
    } as Parameters<typeof decideInvariantExecution>[0] & { amendmentLaneAvailable: true }

    expect(decideInvariantExecution(supported)).toEqual({
      kind: "amendment",
      effectiveRecallContract: "pending-check-amendment",
    })
  })

  it("fails closed for pending-check amendments even when the lens is in shadow mode", () => {
    const supported = {
      mode: "shadow",
      recallContract: "pending-check-amendment",
      amendmentLaneAvailable: true,
    } as Parameters<typeof decideInvariantExecution>[0] & { amendmentLaneAvailable: true }

    expect(decideInvariantExecution(supported)).toEqual({
      kind: "blocking",
      effectiveRecallContract: "blocking",
      refusalReason: "pending-check-amendment-unavailable",
    })
  })
})

describe("decideInvariantDispatch", () => {
  it("mode off never fires", () => {
    expect(decide("cents customer_id .get(", 5, 300, "off")).toMatchObject({ fire: false, reasons: ["mode-off"] })
  })

  it("breadth gate: a single small file has nowhere to cross", () => {
    expect(decide("cents hmac status(404)", 1, 60)).toMatchObject({ fire: false, reasons: ["breadth-unmet"] })
  })

  it("a single BIG file passes breadth via added lines", () => {
    const d = decide("const amountCents = 5", 1, 200)
    expect(d.fire).toBe(true)
    expect(d.dispatched).toContain("units")
  })

  it("families dispatch only when their precondition appears", () => {
    const d = decide(`
      const priceCents = 100
      payments.get("/api/x", h)  // customer_id scoping nearby
      const customer_id = req.auth
      res.status(404)
      createHmac("sha256", secret)
    `)
    expect(d.dispatched).toEqual(
      expect.arrayContaining(["units", "data-scoping", "error-contracts", "crypto-integrity"]),
    )
    expect(d.skipped.map((x) => x.id)).toEqual(expect.arrayContaining(["discriminant-totality"]))
  })

  it("discriminant-totality dispatches on union/enum shapes", () => {
    expect(decide('type: "payment.succeeded" | "refund.succeeded"').dispatched).toContain("discriminant-totality")
    expect(decide("enum Kind { A, B }").dispatched).toContain("discriminant-totality")
  })

  it("wire-contracts dispatches on raw casts and declared interfaces", () => {
    expect(decide("rows as unknown as Payment[]").dispatched).toContain("wire-contracts")
    expect(decide("interface Payment { id: string }").dispatched).toContain("wire-contracts")
  })

  it("a neutral diff dispatches nothing (fire=false) despite breadth", () => {
    const d = decide("just\nplain\nrenamed text lines with none of the trigger tokens")
    expect(d.fire).toBe(false)
    expect(d.dispatched).toEqual([])
    expect(d.skipped).toHaveLength(IDS.length)
  })
})

describe("precondition performance (code-review finding: no super-linear scans)", () => {
  it("a route-heavy diff with no ownership token decides fast and skips data-scoping", () => {
    const adversarial = 'app.get("/x", h)\n'.repeat(80_000)
    const t0 = Date.now()
    const d = decideInvariantDispatch({
      mode: "shadow",
      familyIds: IDS,
      diff: adversarial,
      changedFileCount: 3,
      addedLineCount: 80_000,
    })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(d.skipped.map((x) => x.id)).toContain("data-scoping")
  })
})

describe("countAddedLines", () => {
  it("counts + lines and ignores +++ headers", () => {
    expect(countAddedLines("+++ b/x.ts\n+a\n+b\n-c\n ctx")).toBe(2)
  })
})

describe("buildInvariantFamilyPrompt", () => {
  it("carries the single charge, the empty-result instruction, and no other family's charge", () => {
    const totality = INVARIANT_FAMILIES.find((f) => f.id === "discriminant-totality")!
    const prompt = buildInvariantFamilyPrompt(totality)
    expect(prompt).toContain("exactly ONE charge")
    expect(prompt).toContain("DISCRIMINANT TOTALITY")
    expect(prompt).toContain("an empty result is a correct result")
    expect(prompt).not.toContain("DATA SCOPING")
  })
})
