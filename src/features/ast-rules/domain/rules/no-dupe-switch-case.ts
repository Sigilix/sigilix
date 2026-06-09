// SIG-109: no-dupe-switch-case — flags two `case` clauses in one
// `switch` whose test expressions are identical. A duplicate case is
// dead: the second can never match because the first wins, so it's
// almost always a copy-paste bug (the author meant a different value).
//
// Conservative: only LITERAL case tests are compared (string / number /
// boolean / null / bigint), keyed by their raw source. Two `case foo:`
// with identifier tests are NOT flagged — an identifier could resolve
// to different values across scopes and comparing source text would
// over-flag. This honors the "prefer a miss over a false positive"
// constraint.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/**
 * A normalized key for a literal case test, or null when the test is
 * not a comparable literal (identifier, member, call, …). The key
 * encodes BOTH the literal's runtime value and its type so `case 1`
 * and `case "1"` don't collide.
 */
function literalKey(test: AstNode): string | null {
  if (!test || test.type !== "Literal") return null
  const v = test.value
  if (v === null) return "null:null"
  const t = typeof v
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return `${t}:${String(v)}`
  }
  // regex / other literal kinds — not a switch-case discriminant we
  // can compare safely.
  return null
}

export const noDupeSwitchCase: AstRule = {
  id: "no-dupe-switch-case",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "duplicate case label in a switch",
  language: "both",
  nodeTypes: ["SwitchStatement"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "SwitchStatement") return null
    const cases = Array.isArray(node.cases) ? node.cases : []
    const seen = new Set<string>()
    for (const c of cases) {
      // `default` clause has a null test — skip it.
      if (!c || !c.test) continue
      const key = literalKey(c.test)
      if (key === null) continue
      if (seen.has(key)) {
        return {
          message: "Duplicate `case` label in this switch — the second clause is unreachable because an earlier case with the same value already matched. Remove the duplicate or correct its value.",
          evidence: sliceEvidence(ctx.source, c),
          line: c.loc?.start?.line ?? node.loc?.start?.line ?? 1,
          endLine: c.loc?.end?.line ?? c.loc?.start?.line ?? 1,
          column: c.loc?.start?.column ?? 0,
        }
      }
      seen.add(key)
    }
    return null
  },
}
