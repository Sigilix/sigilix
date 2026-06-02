// SIG-309 PR2: emit-when-unmatched wiring — only the FP-safe security sinks are
// flagged; the renderer surfaces `deterministic_emit`; the synth (autoInline
// off) is told to emit an unmatched flagged entry.

import { describe, it, expect } from "vitest"
import { ALL_RULES } from "../src/lib/ast-rules/rule-registry"
import { renderAstFindingsAsJsonForSynth } from "../src/lib/ast-rules/render"
import { buildAstFindingsSynthBlock, clampAstEmitScores } from "../src/lib/triage-pr-review-ensemble"
import type { AstFinding } from "../src/lib/ast-rules/types"

const EMIT_RULES = new Set([
  "no-exec-shell-interpolation",
  "spawn-shell-true",
  "no-disabled-tls-reject-unauthorized",
  // SIG-310: the contract-drift type-pattern (logic/warning — FP-safe at P2).
  "no-snake-camel-optional-alias",
])

describe("emitWhenUnmatched — FP-safe scoping", () => {
  it("is true on exactly the FP-safe emit rules (3 security sinks + the SIG-310 type smell)", () => {
    for (const r of ALL_RULES) {
      if (EMIT_RULES.has(r.id)) expect(r.emitWhenUnmatched).toBe(true)
      else expect(r.emitWhenUnmatched ?? false).toBe(false)
    }
  })
  it("is NOT set on eval / new Function / document.write (they fire on constants)", () => {
    for (const id of ["no-eval-call", "no-new-function-constructor", "no-document-write-call"]) {
      const rule = ALL_RULES.find((r) => r.id === id)
      // assert the rule exists first so this can't pass vacuously if an id
      // ever changes (CodeRabbit #293)
      expect(rule, `excluded rule ${id} should exist in the registry`).toBeDefined()
      expect(rule?.emitWhenUnmatched ?? false).toBe(false)
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
    expect(off).toMatch(/EMIT a finding/)
    // role-aware (SIG-310): emit in the entry's own role, not hardcoded security
    expect(off).toContain("role_hint")
    expect(off).toContain('role_hint:"logic"')
    // SIG-310 severity guard: logic emits are capped at P2/P3, never a blocker
    expect(off).toContain("NEVER as a P0/P1 blocker")
    // SIG-312: severity is keyed on the entry's `severity` field (a `warning`
    // entry is an advisory), not hardcoded by role.
    expect(off).toContain("severity")
    expect(off).toMatch(/ADVISORY/)
    // believability-critical: the anti-double-post + "already covered" guards
    // must stay in the prompt (a silent deletion would re-open FP risk).
    expect(off).toContain("don't double-post")
    expect(off).toContain("already covers it")
    // SIG-310 follow-up (CodeRabbit #294): suppression is role-aware — broad
    // (path,line) for security, (path,line,role_hint) for other roles.
    expect(off).toContain("a different-role finding on the same line must NOT suppress it")
  })
  it("returns an empty block for empty json", () => {
    expect(buildAstFindingsSynthBlock("", false)).toBe("")
  })
})

describe("clampAstEmitScores — severity ceiling enforcement (SIG-310 code-review fix)", () => {
  const ast = (over: Record<string, unknown>) => ({
    path: "a.ts", line: 20, roleHint: "logic", severity: "warning", emitWhenUnmatched: true, ...over,
  })
  it("clamps a logic warning-emit finding from P1 (score 4) to P2 (score 3)", () => {
    const f = [{ path: "a.ts", line: 21, category: "logic", score: 4 }]
    expect(clampAstEmitScores(f, [ast({})])).toBe(1)
    expect(f[0].score).toBe(3)
  })
  it("does NOT clamp a security error-emit finding (P0 sink stays P0)", () => {
    const f = [{ path: "a.ts", line: 20, category: "security", score: 5 }]
    expect(clampAstEmitScores(f, [ast({ roleHint: "security", severity: "error" })])).toBe(0)
    expect(f[0].score).toBe(5)
  })
  it("does NOT clamp a SPECIALIST-backed security P0 co-located with a WARNING/security emit (SIG-312: the model escalates a real XSS)", () => {
    // specialist-backed = sourceFindingIds references a real specialist finding
    // (not `ast/…`). The model's own security P0 must NOT be demoted to P2.
    const f = [{ path: "a.ts", line: 20, category: "security", score: 5 }]
    const prov = [{ sourceFindingIds: ["security-1"] }]
    expect(clampAstEmitScores(f, [ast({ roleHint: "security", severity: "warning" })], prov)).toBe(0)
    expect(f[0].score).toBe(5)
  })
  it("DOES clamp a deterministic-ONLY security advisory (no specialist source) to P2 (CodeRabbit #296)", () => {
    // no specialist backing (empty / ast-only sourceFindingIds) → the advisory
    // ceiling applies, so an over-scored P0/P1 advisory is capped to P2.
    const f = [{ path: "a.ts", line: 20, category: "security", score: 4 }]
    const prov = [{ sourceFindingIds: ["ast/no-dangerous-html-dynamic/abc/20"] }]
    expect(clampAstEmitScores(f, [ast({ roleHint: "security", severity: "warning" })], prov)).toBe(1)
    expect(f[0].score).toBe(3)
  })
  it("does NOT clamp a finding on a different path / category / out-of-window line", () => {
    const f = [
      { path: "b.ts", line: 20, category: "logic", score: 4 }, // wrong path
      { path: "a.ts", line: 20, category: "security", score: 4 }, // wrong category
      { path: "a.ts", line: 40, category: "logic", score: 4 }, // out of ±2 window
    ]
    expect(clampAstEmitScores(f, [ast({})])).toBe(0)
    expect(f.every((x) => x.score === 4)).toBe(true)
  })
  it("does NOT raise a score below the ceiling", () => {
    const f = [{ path: "a.ts", line: 20, category: "logic", score: 2 }]
    expect(clampAstEmitScores(f, [ast({})])).toBe(0)
    expect(f[0].score).toBe(2)
  })
})
