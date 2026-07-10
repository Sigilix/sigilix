import { describe, expect, it } from "vitest"
import {
  codebaseContextEnabled,
  codebaseToolsEnabled,
  validateLinearConfigInput,
  type LinearConfigInput,
} from "./config"

const VALID_CONFIG: LinearConfigInput = {
  revision: 1,
  contextMode: "auto",
  scope: { mode: "auto", teamIds: [] },
  prValidation: false,
  createIssue: "manual",
  planning: true,
  writeback: { comments: true, status: false, labels: true },
}

describe("validateLinearConfigInput", () => {
  it("rejects extra and missing top-level keys", () => {
    expect(validateLinearConfigInput({ ...VALID_CONFIG, extraKey: true })).toEqual({
      ok: false,
      reason: "invalid-shape",
    })
    const { planning: _planning, ...missingPlanning } = VALID_CONFIG
    expect(validateLinearConfigInput(missingPlanning)).toEqual({ ok: false, reason: "invalid-shape" })
  })

  it.each([
    { ...VALID_CONFIG, prValidation: true },
    { ...VALID_CONFIG, createIssue: "auto" },
    { ...VALID_CONFIG, writeback: { ...VALID_CONFIG.writeback, status: true } },
  ])("keeps unsupported tenant-write features dark", (input) => {
    expect(validateLinearConfigInput(input)).toEqual({ ok: false, reason: "unsafe-feature-dark" })
  })

  it("makes auto bounded, enabled agentic, and disabled fully dark", () => {
    expect(codebaseContextEnabled({ ...VALID_CONFIG, contextMode: "auto" })).toBe(true)
    expect(codebaseToolsEnabled({ ...VALID_CONFIG, contextMode: "auto" })).toBe(false)
    expect(codebaseContextEnabled({ ...VALID_CONFIG, contextMode: "enabled" })).toBe(true)
    expect(codebaseToolsEnabled({ ...VALID_CONFIG, contextMode: "enabled" })).toBe(true)
    expect(codebaseContextEnabled({ ...VALID_CONFIG, contextMode: "disabled" })).toBe(false)
    expect(codebaseToolsEnabled({ ...VALID_CONFIG, contextMode: "disabled" })).toBe(false)
  })
})
