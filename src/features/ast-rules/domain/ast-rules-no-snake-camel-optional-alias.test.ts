// SIG-310: no-snake-camel-optional-alias — flags a TS interface declaring both
// a snake_case REQUIRED field and its camelCase OPTIONAL alias (the contract-
// drift trap both CodeRabbit + Greptile catch at the type declaration).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/features/ast-rules/domain/parser"
import { walkAst } from "@/features/ast-rules/domain/walker"
import { noSnakeCamelOptionalAlias } from "@/features/ast-rules/domain/rules/no-snake-camel-optional-alias"
import { ALL_RULES } from "@/features/ast-rules/domain/rule-registry"
import type { AstRuleHit, AstRuleVisitResult } from "@/features/ast-rules/domain/types"

function append(out: AstRuleHit[], hit: AstRuleVisitResult): void {
  if (!hit) return
  Array.isArray(hit) ? out.push(...hit) : out.push(hit)
}
function runRule(source: string): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  walkAst(r.ast, {
    TSInterfaceDeclaration(node) {
      append(hits, noSnakeCamelOptionalAlias.visit(node, { path: "t.ts", source, ast: r.ast }))
    },
  })
  return hits
}

describe("no-snake-camel-optional-alias — positive (snake-required + camel-optional alias)", () => {
  it("flags reply_count + replyCount? (the pr/06 D7 pattern)", () => {
    expect(runRule(`interface C { reply_count: number; replyCount?: number }`).length).toBe(1)
  })
  it("flags author_name + authorName? (the pr/06 D6 pattern)", () => {
    expect(runRule(`interface C { author_name: string; authorName?: string }`).length).toBe(1)
  })
  it("flags total_bytes + totalBytes?", () => {
    expect(runRule(`interface S { total_bytes: number; totalBytes?: number }`).length).toBe(1)
  })
  it("flags each drifting pair separately in one interface", () => {
    expect(runRule(`interface C { a_b: number; aB?: number; c_d: string; cD?: string }`).length).toBe(2)
  })
  it("sets endLine on a multi-line alias property signature (CodeRabbit #294)", () => {
    const hits = runRule("interface C {\n  reply_count: number;\n  replyCount?:\n    number;\n}")
    expect(hits.length).toBe(1)
    expect(hits[0].endLine).toBeGreaterThan(hits[0].line)
  })
})

describe("no-snake-camel-optional-alias — negative (no flag)", () => {
  it("does NOT flag when the camel alias is REQUIRED (not optional)", () => {
    expect(runRule(`interface C { reply_count: number; replyCount: number }`).length).toBe(0)
  })
  it("does NOT flag when only the snake field is present", () => {
    expect(runRule(`interface C { reply_count: number }`).length).toBe(0)
  })
  it("does NOT flag when only the optional camel is present (no snake required twin)", () => {
    expect(runRule(`interface C { replyCount?: number }`).length).toBe(0)
  })
  it("does NOT flag an unrelated optional camel field", () => {
    expect(runRule(`interface C { reply_count: number; nickname?: string }`).length).toBe(0)
  })
  it("does NOT flag the inverse (snake optional + camel required)", () => {
    expect(runRule(`interface C { reply_count?: number; replyCount: number }`).length).toBe(0)
  })
})

describe("no-snake-camel-optional-alias — registry", () => {
  it("is registered as a warning-severity logic rule that emits when unmatched", () => {
    const r = ALL_RULES.find((x) => x.id === "no-snake-camel-optional-alias")
    expect(r?.severity).toBe("warning")
    expect(r?.roleHint).toBe("logic")
    expect(r?.emitWhenUnmatched).toBe(true)
  })
})
