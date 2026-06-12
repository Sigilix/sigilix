// SIG-392 (b8): no-double-cast-through-unknown — flags a value laundered
// through `as unknown as T` (or `as any as T`) into a NAMED typed shape.
//
// The double assertion is TypeScript's "trust me" escape hatch: it asserts a
// value is `T` with ZERO structural checking. The b8 benchmark case is
// `const body = rows as unknown as Payment[]` — raw snake_case DB rows cast
// to a camelCase wire type, so the JSON the client receives has the wrong
// field shape (snake fields where camel was promised), and it type-checks
// because `unknown` erases the mismatch. The plain camel/snake lens bullet
// and the SIG-310 type-declaration rule both miss this RUNTIME-cast variant
// (the drift is at the cast site, not in any interface).
//
// FP-safe posture (mirrors no-snake-camel-optional-alias): the finding is a
// `logic`/`warning` (never a P0/P1), surfaced via the SIG-309 emit path
// (`emitWhenUnmatched`) through the grounding pipeline. Even when a double
// cast is locally correct (a deliberate, validated boundary cast), the worst
// case is a P2 type-design nit — the advice ("don't launder through
// `unknown`; map or validate the shape at the boundary") holds either way.
// Tightly scoped: only DOUBLE assertions whose inner type is `unknown`/`any`
// AND whose final type is a NAMED type reference (or array of one). A single
// `x as T` and a launder back to a primitive/`unknown` never fire.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** Inner assertion launders through the type system: `as unknown` / `as any`. */
function isUnknownOrAny(typeAnn: AstNode): boolean {
  return typeAnn?.type === "TSUnknownKeyword" || typeAnn?.type === "TSAnyKeyword"
}

/** The final asserted type is a NAMED domain shape (a ref, or an array of one). */
function namedTargetTypeName(typeAnn: AstNode): string | null {
  if (typeAnn?.type === "TSTypeReference") {
    const n = typeAnn.typeName
    if (n?.type === "Identifier" && typeof n.name === "string") return n.name
    return "the asserted type"
  }
  if (typeAnn?.type === "TSArrayType") {
    const el = typeAnn.elementType
    if (el?.type === "TSTypeReference") {
      const n = el.typeName
      if (n?.type === "Identifier" && typeof n.name === "string") return `${n.name}[]`
      return "the asserted type[]"
    }
  }
  return null
}

export const noDoubleCastThroughUnknown: AstRule = {
  id: "no-double-cast-through-unknown",
  severity: "warning",
  roleHint: "logic",
  shortDescription:
    "value laundered through `as unknown as T` into a typed shape — bypasses field-shape checking (contract drift)",
  language: "ts",
  nodeTypes: ["TSAsExpression"],
  // FP-safe (warning-severity type smell; advice holds even on a validated
  // boundary cast) → emit even when no specialist matched.
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "TSAsExpression") return null
    const inner = node.expression
    // Only the OUTER node of a double assertion: its expression is itself an
    // `as` whose target is `unknown`/`any`. (The inner node's expression is
    // the operand, not a TSAsExpression, so it never matches here.)
    if (!inner || inner.type !== "TSAsExpression") return null
    if (!isUnknownOrAny(inner.typeAnnotation)) return null
    // `this as unknown as T` is self-rebinding (mixin composition, builder
    // `this`-recasts), NEVER data-shape contract drift — exclude it. Removes
    // the most common idiomatic double-cast with zero loss to the b8 class
    // (code review #500).
    if (inner.expression?.type === "ThisExpression") return null
    const target = namedTargetTypeName(node.typeAnnotation)
    if (target === null) return null
    const launder = inner.typeAnnotation?.type === "TSAnyKeyword" ? "any" : "unknown"
    return {
      message: `This value is laundered through \`as ${launder} as ${target}\` — a double type assertion that tells TypeScript the value is \`${target}\` with NO structural check. If the source shape differs from \`${target}\` (e.g. snake_case DB rows asserted to a camelCase wire type), the mismatch is silent at compile time and surfaces as wrong/undefined fields at runtime. Map or validate the shape at the boundary instead of asserting through \`${launder}\`.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      ...(typeof node.loc?.end?.line === "number" ? { endLine: node.loc.end.line } : {}),
      column: node.loc?.start?.column ?? 0,
    }
  },
}
