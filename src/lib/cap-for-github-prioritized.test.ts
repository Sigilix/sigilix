// Phase-3 (founder ask): severity-aware 65k cap tests.
//
// A blind tail-cut slices whatever renders last — which can be a body-scoped
// security blocker's evidence. This cap sheds the LOW-severity non-blocker tail
// first, so the head (lead + Fix Plan table with every blocker row + body-only
// blocker details) + footer always survive intact.

import { describe, it, expect } from "vitest"
import { capForGitHubPrioritized } from "@/src/lib/triage-pr-review"

const CAP = 65000
const FOOTER = "<sub>Re-run · `abc1234`</sub>"

describe("capForGitHubPrioritized — severity-aware 65k cap", () => {
  it("under the cap: returns head + droppable + footer unchanged", () => {
    const out = capForGitHubPrioritized({
      head: "## blockers\n| Severity | Issue |\n| Critical | SQLi |",
      droppable: "\n### Review Body Findings\n- a nit",
      droppedCountIfOmitted: 1,
      footer: FOOTER,
    })
    expect(out).toContain("SQLi")
    expect(out).toContain("a nit")
    expect(out).toContain(FOOTER)
    expect(out.length).toBeLessThanOrEqual(CAP)
  })

  it("over the cap: DROPS the low-severity tail with a counted marker, KEEPS the head + footer", () => {
    const head = "## blockers\n| Critical | SQL injection in auth |"
    const droppable = "\n### Review Body Findings\n" + "- low-sev nit padding\n".repeat(6000) // huge tail
    const out = capForGitHubPrioritized({
      head,
      droppable,
      droppedCountIfOmitted: 6000,
      footer: FOOTER,
    })
    expect(out.length).toBeLessThanOrEqual(CAP)
    // the security blocker survives...
    expect(out).toContain("SQL injection in auth")
    // ...the footer (SHA provenance) survives...
    expect(out).toContain(FOOTER)
    // ...the tail is gone, with an honest counted marker...
    expect(out).not.toContain("low-sev nit padding")
    expect(out).toContain("6000 lower-severity body findings omitted")
    expect(out).toContain("every blocker is shown above")
  })

  it("singular marker copy for a single omitted finding", () => {
    const head = "## blockers\n| Critical | XSS |"
    const droppable = "\n### Review Body Findings\n" + "x".repeat(70000)
    const out = capForGitHubPrioritized({
      head,
      droppable,
      droppedCountIfOmitted: 1,
      footer: FOOTER,
    })
    expect(out).toContain("1 lower-severity body finding omitted")
    expect(out).not.toContain("findings omitted")
    expect(out).toContain("XSS")
  })

  it("pathological: head alone overflows → falls back to a content cut but keeps the footer", () => {
    const head = "## blockers\n" + "B".repeat(70000) // a single huge blocker
    const out = capForGitHubPrioritized({
      head,
      droppable: "",
      droppedCountIfOmitted: 0,
      footer: FOOTER,
    })
    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(out).toContain(FOOTER) // provenance invariant survives even here
    expect(out).toContain("truncated")
  })

  it("no droppable tail: behaves like the plain cap (head + footer)", () => {
    const out = capForGitHubPrioritized({
      head: "## blockers\n| Critical | RCE |",
      droppable: "",
      droppedCountIfOmitted: 0,
      footer: FOOTER,
    })
    expect(out).toBe(`## blockers\n| Critical | RCE |\n\n${FOOTER}`)
  })
})
