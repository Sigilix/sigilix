// SIG-309 PR2: emit-when-unmatched wiring — only the FP-safe security sinks are
// flagged; the renderer surfaces `deterministic_emit`; the synth (autoInline
// off) is told to emit an unmatched flagged entry.

import { describe, it, expect } from "vitest"
import { ALL_RULES } from "../src/lib/ast-rules/rule-registry"
import { renderAstFindingsAsJsonForSynth } from "../src/lib/ast-rules/render"
import { buildAstFindingsSynthBlock } from "../src/lib/triage-pr-review-ensemble"
import type { AstFinding } from "../src/lib/ast-rules/types"

const EMIT_RULES = new Set([
  "no-exec-shell-interpolation",
  "spawn-shell-true",
  "no-disabled-tls-reject-unauthorized",
])

describe("emitWhenUnmatched — FP-safe scoping", () => {
  it("is true on exactly the 3 constant/context-guarded security sinks", () => {
    for (const r of ALL_RULES) {
      if (EMIT_RULES.has(r.id)) expect(r.emitWhenUnmatched).toBe(true)
      else expect(r.emitWhenUnmatched ?? false).toBe(false)
    }
  })
  it("is NOT set on eval / new Function / document.write (they fire on constants)", () => {
    for (const id of ["no-eval-call", "no-new-function-constructor", "no-document-write-call"]) {
      expect(ALL_RULES.find((r) => r.id === id)?.emitWhenUnmatched ?? false).toBe(false)
    }
  })
})

describe("renderAstFindingsAsJsonForSynth — deterministic_emit field", () => {
  const base: AstFinding = {
    ruleId: "no-exec-shell-interpolation", severity: "error", roleHint: "security",
    path: "a.ts", line: 1, column: 0, message: "m", evidence: "", astFindingId: "ast/x/abc/1",
  }
  it("renders deterministic_emit:true for a flagged finding", () => {
    expect(renderAstFindingsAsJsonForSynth([{ ...base, emitWhenUnmatched: true }]))
      .toContain('"deterministic_emit": true')
  })
  it("omits the field for an unflagged finding", () => {
    expect(renderAstFindingsAsJsonForSynth([base])).not.toContain("deterministic_emit")
  })
})

describe("buildAstFindingsSynthBlock — emit instruction (autoInline OFF)", () => {
  it("tells the synth to EMIT unmatched deterministic_emit security sinks", () => {
    const off = buildAstFindingsSynthBlock('{"ast_findings":[]}', false)
    expect(off).toContain("deterministic_emit")
    expect(off).toMatch(/EMIT a .*security.* finding/)
    // believability-critical: the anti-double-post + "no specialist covers it"
    // guards must stay in the prompt (a silent deletion would re-open FP risk).
    expect(off).toContain("don't double-post")
    expect(off).toMatch(/If NO specialist finding already covers/)
  })
  it("returns an empty block for empty json", () => {
    expect(buildAstFindingsSynthBlock("", false)).toBe("")
  })
})
