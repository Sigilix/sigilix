// SIG-304 recall-safety: a partial (degraded-coverage) review must never exit 0, even
// with zero findings — the missing specialist may have been the one that would catch it.

import { describe, it, expect } from "vitest"
import { exitCodeForFindings } from "./exit-code"
import type { FindingView } from "@/src/cli/render/finding-view"

const view = (severity: string): FindingView => ({ severity }) as unknown as FindingView

describe("exitCodeForFindings", () => {
  it("no findings, full coverage → 0 (clean)", () => {
    expect(exitCodeForFindings([])).toBe(0)
    expect(exitCodeForFindings([], false)).toBe(0)
  })
  it("a blocking finding → 1, advisory only → 2", () => {
    expect(exitCodeForFindings([view("P0")])).toBe(1)
    expect(exitCodeForFindings([view("P1")])).toBe(1)
    expect(exitCodeForFindings([view("P2")])).toBe(2)
    expect(exitCodeForFindings([view("P3")])).toBe(2)
  })
  it("RECALL-SAFETY: no findings but INCOMPLETE coverage → 2, NEVER 0", () => {
    expect(exitCodeForFindings([], true)).toBe(2)
  })
  it("a blocking finding stays 1 even when incomplete (the blocker dominates)", () => {
    expect(exitCodeForFindings([view("P0")], true)).toBe(1)
  })
})
