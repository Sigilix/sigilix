// SIG-235 — pure unit tests on the env-flag parser for
// `OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT`. The orchestrator reads this
// value and the parser narrows it to the three-state union
// `"off" | "shadow" | "on"`. Default-off (any unknown/missing input)
// is the safety net: a typo'd env var never silently changes fan-out
// semantics.
//
// The full quorum-collector behavior (cancel laggard, late-verdict
// discard, [DEGRADED COVERAGE] block firing earlier) is exercised in
// the existing ensemble integration tests with shadow vs on env vars
// — these unit tests just pin the parser invariants.

import { describe, expect, it } from "vitest"
import {
  parseMinSpecialistsEarlyExitMode,
  decideEarlyExitAction,
} from "../src/lib/triage-pr-review-ensemble"

describe("parseMinSpecialistsEarlyExitMode — env flag parser", () => {
  describe("happy path — recognized values", () => {
    it("returns \"off\" for exact \"off\"", () => {
      expect(parseMinSpecialistsEarlyExitMode("off")).toBe("off")
    })

    it("returns \"shadow\" for exact \"shadow\"", () => {
      expect(parseMinSpecialistsEarlyExitMode("shadow")).toBe("shadow")
    })

    it("returns \"on\" for exact \"on\"", () => {
      expect(parseMinSpecialistsEarlyExitMode("on")).toBe("on")
    })

    it("is case-insensitive", () => {
      expect(parseMinSpecialistsEarlyExitMode("OFF")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("SHADOW")).toBe("shadow")
      expect(parseMinSpecialistsEarlyExitMode("ON")).toBe("on")
      expect(parseMinSpecialistsEarlyExitMode("Shadow")).toBe("shadow")
    })

    it("is whitespace-tolerant", () => {
      expect(parseMinSpecialistsEarlyExitMode("  shadow  ")).toBe("shadow")
      expect(parseMinSpecialistsEarlyExitMode(" on ")).toBe("on")
      expect(parseMinSpecialistsEarlyExitMode("\toff\n")).toBe("off")
    })
  })

  describe("safety net — default off for everything else", () => {
    it("returns \"off\" when the flag is undefined", () => {
      expect(parseMinSpecialistsEarlyExitMode(undefined)).toBe("off")
    })

    it("returns \"off\" when the flag is null (defensive — Cloudflare typing should rule this out but framework adapters could pass null)", () => {
      // Cast through `as unknown as` to bypass the `string | undefined`
      // declared signature — production code won't trigger this path,
      // but the parser's `?? ""` coalesce + `.trim().toLowerCase()` chain
      // is null-safe, and we want to prove that contractually for any
      // future caller that drops in a JSON-derived undefined-or-null.
      expect(parseMinSpecialistsEarlyExitMode(null as unknown as undefined)).toBe("off")
    })

    it("returns \"off\" for empty string", () => {
      expect(parseMinSpecialistsEarlyExitMode("")).toBe("off")
    })

    it("returns \"off\" for whitespace-only", () => {
      expect(parseMinSpecialistsEarlyExitMode("   ")).toBe("off")
    })

    it("returns \"off\" for typos / unknown values", () => {
      // Typos should NOT silently degrade to a more-aggressive mode.
      expect(parseMinSpecialistsEarlyExitMode("enabled")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("yes")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("true")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("1")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("enforce")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("shadowed")).toBe("off")
    })

    it("only the EXACT three tokens match — partial substring rejected", () => {
      expect(parseMinSpecialistsEarlyExitMode("on-shadow")).toBe("off")
      expect(parseMinSpecialistsEarlyExitMode("off-mode")).toBe("off")
    })
  })

  describe("type narrowing", () => {
    it("returns one of the three union members (TS compile-time check)", () => {
      // If a future refactor widens the return type, the assignment to
      // a narrow union would fail compilation. Runtime assertion is a
      // belt-and-suspenders backup.
      const mode = parseMinSpecialistsEarlyExitMode("shadow")
      const narrow: "off" | "shadow" | "on" = mode
      expect(narrow === "off" || narrow === "shadow" || narrow === "on").toBe(true)
    })
  })
})

describe("decideEarlyExitAction — SIG-236 protected-role early-exit gate", () => {
  const base = { succeededCount: 3, quorumThreshold: 3, pendingCount: 1, logicProtectedPending: false }

  describe("quorum gate", () => {
    it("returns \"none\" below the quorum threshold (keep awaiting)", () => {
      expect(decideEarlyExitAction({ ...base, mode: "on", succeededCount: 2 })).toBe("none")
      expect(decideEarlyExitAction({ ...base, mode: "shadow", succeededCount: 2 })).toBe("none")
    })

    it("returns \"none\" when nothing is pending (quorum met but all settled)", () => {
      expect(decideEarlyExitAction({ ...base, mode: "on", pendingCount: 0 })).toBe("none")
    })
  })

  describe("mode \"on\"", () => {
    it("CANCELS the laggards when no protected (logic) role is pending", () => {
      expect(decideEarlyExitAction({ ...base, mode: "on", logicProtectedPending: false })).toBe("cancel")
    })

    it("SUPPRESSES (never cancels) when logic is the pending straggler — the SIG-236 guard", () => {
      expect(decideEarlyExitAction({ ...base, mode: "on", logicProtectedPending: true })).toBe("suppress-protected")
    })
  })

  describe("mode \"shadow\" — records the would-fire, never cancels", () => {
    it("returns \"shadow-mark\" regardless of whether logic is pending", () => {
      expect(decideEarlyExitAction({ ...base, mode: "shadow", logicProtectedPending: false })).toBe("shadow-mark")
      expect(decideEarlyExitAction({ ...base, mode: "shadow", logicProtectedPending: true })).toBe("shadow-mark")
    })
  })

  describe("mode \"off\" — gate is inert", () => {
    it("returns \"none\" even at quorum with a pending role", () => {
      expect(decideEarlyExitAction({ ...base, mode: "off", logicProtectedPending: true })).toBe("none")
      expect(decideEarlyExitAction({ ...base, mode: "off", logicProtectedPending: false })).toBe("none")
    })
  })
})
