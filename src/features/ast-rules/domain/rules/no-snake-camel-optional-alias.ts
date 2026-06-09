// SIG-310: no-snake-camel-optional-alias — flags a TS interface that declares
// BOTH a snake_case REQUIRED field (e.g. `reply_count: number`) AND its
// camelCase OPTIONAL alias (`replyCount?: number`).
//
// This is the "optional-alias contract-drift" smell: a data loader/serializer
// populates only the snake field, so any read of the camel alias is `undefined`
// at runtime (Invalid Date / NaN / blank render) — yet it type-checks because
// the optional alias exists. The v14 logic-lens prompt bullet catches the PLAIN
// camel/snake mismatch (a name absent from the type) but missed this variant
// across three benchmark scenarios (pr/06 FE D6/D7); both CodeRabbit and
// Greptile catch it — and they catch it at the TYPE DECLARATION, exactly this
// pattern ("the interface mixes snake_case required fields with optional
// camelCase aliases"). So this rule makes the type-pattern deterministic.
//
// FP-safe posture: the finding is a `logic`/`warning` (not a P0/P1), and it is
// surfaced via the SIG-309 emit path (`emitWhenUnmatched`) through the grounding
// pipeline — so even if a particular interface intentionally carries both
// (a transitional/mapped DTO), the worst case is a P2 type-design nit, never a
// P0/P1 false positive. The advice ("use one casing consistently") holds either
// way.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** snake_case → camelCase: `reply_count` → `replyCount`, `total_bytes` → `totalBytes`. */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/** Property name of a `TSPropertySignature` (Identifier key, or string-literal key). */
function propName(member: AstNode): string | null {
  const k = member?.key
  if (k?.type === "Identifier") return k.name as string
  if (k?.type === "Literal" && typeof k.value === "string") return k.value
  return null
}

export const noSnakeCamelOptionalAlias: AstRule = {
  id: "no-snake-camel-optional-alias",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "interface declares a snake_case required + camelCase optional alias of the same field",
  language: "ts",
  nodeTypes: ["TSInterfaceDeclaration"],
  // FP-safe (warning-severity type smell; the advice holds even on a mapped DTO)
  // → emit even when no specialist matched, so the drift surfaces deterministically.
  emitWhenUnmatched: true,
  visit(node: AstNode, _ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "TSInterfaceDeclaration") return null
    const members: AstNode[] = node.body?.body ?? []
    const requiredSnake: string[] = []
    const optionalByName = new Map<string, AstNode>()
    for (const m of members) {
      if (!m || m.type !== "TSPropertySignature") continue
      const name = propName(m)
      if (!name) continue
      if (m.optional === true) optionalByName.set(name, m)
      else if (name.includes("_")) requiredSnake.push(name)
    }
    const hits: AstRuleHit[] = []
    for (const snake of requiredSnake) {
      const camel = snakeToCamel(snake)
      if (camel === snake) continue
      const alias = optionalByName.get(camel)
      if (!alias) continue
      hits.push({
        message: `This interface declares both \`${snake}\` (required) and an OPTIONAL alias \`${camel}?\` for the same field — a contract-drift trap. If the loader/serializer populates only \`${snake}\`, every read of \`${camel}\` is \`undefined\` at runtime (Invalid Date / NaN / blank), and it type-checks because the alias is optional. Use one casing consistently (or map the field explicitly at the boundary).`,
        evidence: sliceEvidence(_ctx.source, alias),
        line: alias.loc?.start?.line ?? node.loc?.start?.line ?? 1,
        // AstRuleHit contract: a multi-line property signature must carry endLine
        // so the diff-line filter sees an edit anywhere in the span (CodeRabbit #294).
        ...(typeof alias.loc?.end?.line === "number" ? { endLine: alias.loc.end.line } : {}),
        column: alias.loc?.start?.column ?? 0,
      })
    }
    return hits.length > 0 ? hits : null
  },
}
