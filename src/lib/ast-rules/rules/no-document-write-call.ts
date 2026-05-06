// ARC-181: no-document-write-call — flags `document.write(...)` and
// `document.writeln(...)`. document.write is an HTML-injection vector
// when called after page load and is universally discouraged.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const TARGET_METHODS: ReadonlySet<string> = new Set(["write", "writeln"])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

export const noDocumentWriteCall: AstRule = {
  id: "no-document-write-call",
  severity: "error",
  roleHint: "security",
  shortDescription: "document.write / document.writeln call",
  language: "both",
  nodeTypes: ["CallExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "CallExpression") return null
    const c = node.callee
    if (!c || c.type !== "MemberExpression") return null
    const obj = c.object
    const prop = c.property
    if (obj?.type !== "Identifier" || obj.name !== "document") return null
    // CR catch on PR #67: respect `c.computed`. `document[write]()`
    // where `write` is a variable shouldn't be flagged just because
    // the variable's name happens to be "write" — the property is
    // dynamic.
    const propName = c.computed
      ? (prop?.type === "Literal" && typeof prop.value === "string" ? prop.value : null)
      : (prop?.type === "Identifier" ? prop.name : null)
    if (!propName || !TARGET_METHODS.has(propName)) return null
    return {
      message: `\`document.${propName}()\` is an HTML-injection vector — refactor to DOM APIs (\`textContent\`, \`createElement\`).`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
