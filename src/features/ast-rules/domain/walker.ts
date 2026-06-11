// ARC-181: thin wrapper over `acorn-walk.simple` exposing a
// uniform visitor signature for the rule pack. Rules pass a
// `Record<NodeType, (node) => void>` map; the walker dispatches
// each visited node by `node.type`.
//
// Why a wrapper? acorn-walk has multiple traversal modes (`simple`,
// `ancestor`, `recursive`, `full`). v1 rules only need the simple
// post-order traversal; centralizing the wrapper means rules don't
// import from `acorn-walk` directly and we can swap traversal
// strategies in one place if needed (e.g., add `ancestor` for rules
// that need parent-chain context).

import { simple as acornWalkSimple, base as defaultBase } from "acorn-walk"

export type AstNode = any

export type Visitors = Record<string, (node: AstNode) => void>

// acorn-walk's default base visitor table only knows standard ESTree
// node types. acorn-typescript emits TS-specific node types
// (`TSEnumDeclaration`, `TSInterfaceDeclaration`, `TSAsExpression`,
// `TSTypeAnnotation`, etc.) that the default base does not have
// entries for, causing `baseVisitor[type] is not a function` throws
// on traversal.
//
// We build an extended base that proxies the default for known types
// and no-ops on unknown types (treating them as terminal — children
// are not recursed into, but the walk does not throw). This is
// permissive-by-default: rule visitors can still match any node type
// they declare, including TS-specific ones, but unknown nodes don't
// derail traversal of standard ESTree siblings.
//

const permissiveBase: any = new Proxy(defaultBase, {
  get(target, prop: string) {
    const v = (target as any)[prop]
    if (typeof v === "function") return v
    // No-op for unknown node types. acorn-walk's contract is the base
    // entry takes (node, state, callback) and walks children; doing
    // nothing means the unknown node is treated as terminal.
    return () => {}
  },
})

/**
 * Walk an AST applying the visitor map. Each visitor function is
 * called once per matching node type. Unknown (TS-specific) node
 * types are treated as terminal — the walker does not recurse into
 * their children but does not throw either.
 */
export function walkAst(ast: AstNode, visitors: Visitors): void {
  acornWalkSimple(ast, visitors, permissiveBase)
}
