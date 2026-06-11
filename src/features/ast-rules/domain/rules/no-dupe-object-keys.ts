// SIG-109: no-dupe-object-keys — flags an object literal that declares
// the same STATIC key twice. The later value silently wins, so the
// earlier assignment is dead — almost always a copy-paste bug.
//
// Conservative constraints (honor every exemption — prefer a miss):
//   - STATIC keys only: identifier (`a`), string literal (`"a"`), or
//     numeric literal (`1`) keys. A COMPUTED key (`[expr]: …`) is
//     skipped entirely — its runtime value is unknown to the AST, so
//     comparing it would over-flag.
//   - GETTER/SETTER PAIR exemption: a `get x()` paired with a `set x()`
//     for the same key is LEGAL (an accessor pair), not a duplicate.
//     Two getters, two setters, or a getter + a data property ARE
//     duplicates and flagged.
//   - Spread elements (`...rest`) carry no key and are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/**
 * The static key name for a Property, or null when the key is computed
 * or otherwise non-static. Identifier keys use their `name`; literal
 * keys use their `value` coerced to string (so `1` and `"1"` collide,
 * which matches JS object-key semantics — numeric keys are stringified).
 */
function staticKeyName(prop: AstNode): string | null {
  if (!prop || prop.computed) return null
  const key = prop.key
  if (!key) return null
  if (key.type === "Identifier") return key.name as string
  if (key.type === "Literal") {
    const v = key.value
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
      return String(v)
    }
  }
  return null
}

/**
 * Track what KIND of declaration we've already seen for a key so the
 * getter/setter pair exemption can apply. `get` + `set` for the same
 * key is legal; anything else that repeats a key is a duplicate.
 */
type SeenKind = "init" | "get" | "set"

function propKind(prop: AstNode): SeenKind {
  if (prop.kind === "get") return "get"
  if (prop.kind === "set") return "set"
  // `init` covers data properties, methods, and shorthand.
  return "init"
}

export const noDupeObjectKeys: AstRule = {
  id: "no-dupe-object-keys",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "duplicate static key in an object literal",
  language: "both",
  nodeTypes: ["ObjectExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "ObjectExpression") return null
    const props = Array.isArray(node.properties) ? node.properties : []
    // key name → set of kinds already declared for it.
    const seen = new Map<string, Set<SeenKind>>()
    for (const prop of props) {
      // SpreadElement / RestElement carry no static key.
      if (!prop || prop.type !== "Property") continue
      const name = staticKeyName(prop)
      if (name === null) continue
      const kind = propKind(prop)
      const kinds = seen.get(name)
      if (!kinds) {
        seen.set(name, new Set([kind]))
        continue
      }
      // A getter+setter pair for the same key is legal. Only that exact
      // complementary pairing is exempt: if `get` was already seen and
      // this is `set` (or vice-versa) AND no data prop is in the mix,
      // it's an accessor pair, not a duplicate.
      const isAccessorPair =
        (kind === "get" && kinds.has("set") && !kinds.has("get") && !kinds.has("init")) ||
        (kind === "set" && kinds.has("get") && !kinds.has("set") && !kinds.has("init"))
      if (isAccessorPair) {
        kinds.add(kind)
        continue
      }
      return {
        message:
          "Duplicate object key — the later value silently overwrites the earlier one, so the first assignment is dead. Remove the duplicate or rename one key.",
        evidence: sliceEvidence(ctx.source, prop),
        line: prop.loc?.start?.line ?? node.loc?.start?.line ?? 1,
        endLine: prop.loc?.end?.line ?? prop.loc?.start?.line ?? 1,
        column: prop.loc?.start?.column ?? 0,
      }
    }
    return null
  },
}
