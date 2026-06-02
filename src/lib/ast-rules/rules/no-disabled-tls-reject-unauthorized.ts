// ARC-181: no-disabled-tls-reject-unauthorized — flags any object
// expression containing `{ rejectUnauthorized: false }`. The literal
// `false` flag disables certificate validation, exposing the
// connection to MITM. Tests/local agents that legitimately need this
// should suppress via `pathFilters` or `astRules.disabledRules`.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

export const noDisabledTlsRejectUnauthorized: AstRule = {
  id: "no-disabled-tls-reject-unauthorized",
  severity: "error",
  roleHint: "security",
  shortDescription: "{ rejectUnauthorized: false } — TLS validation disabled",
  language: "both",
  nodeTypes: ["Property"],
  // FP-safe (the literal `rejectUnauthorized: false` is unambiguous) → emit unmatched.
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "Property") return null
    const k = node.key
    const v = node.value
    // CR catch on PR #67: respect `node.computed`. `{ [variable]:
    // false }` must NOT match even when `variable` is named
    // "rejectUnauthorized" — the key is dynamic, not a literal property
    // named "rejectUnauthorized".
    const keyName = node.computed
      ? (k?.type === "Literal" && typeof k.value === "string" ? k.value : null)
      : (k?.type === "Identifier" ? k.name : (k?.type === "Literal" ? k.value : null))
    if (keyName !== "rejectUnauthorized") return null
    if (v?.type !== "Literal" || v.value !== false) return null
    return {
      message: "`rejectUnauthorized: false` disables TLS certificate validation — exposes the connection to man-in-the-middle. Provide a `ca` bundle or use the system trust store.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
