// ARC-181: spawn-shell-true — flags `spawn`/`spawnSync`/`execFile`/
// `execFileSync` calls with a `{ shell: true }` literal in the
// options object. (`exec` is intentionally excluded — Codex MINOR
// #7: `exec` already runs through a shell so `{shell:true}` is
// redundant there. The dangerous case is the non-shell APIs being
// explicitly opted into shell mode.)

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const TARGET_FNS: ReadonlySet<string> = new Set([
  "spawn", "spawnSync", "execFile", "execFileSync",
])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function calleeName(node: AstNode): string | null {
  const c = node?.callee
  if (!c) return null
  if (c.type === "Identifier") return c.name as string
  if (c.type === "MemberExpression" && c.property?.type === "Identifier") {
    return c.property.name as string
  }
  return null
}

function hasShellTrueLiteral(args: AstNode[]): boolean {
  for (const a of args) {
    if (!a || a.type !== "ObjectExpression") continue
    for (const prop of a.properties ?? []) {
      if (prop?.type !== "Property") continue
      const k = prop.key
      const v = prop.value
      const keyName = k?.type === "Identifier" ? k.name : (k?.type === "Literal" ? k.value : null)
      if (keyName !== "shell") continue
      if (v?.type === "Literal" && v.value === true) return true
    }
  }
  return false
}

export const spawnShellTrue: AstRule = {
  id: "spawn-shell-true",
  severity: "error",
  roleHint: "security",
  shortDescription: "spawn/execFile with { shell: true }",
  language: "both",
  nodeTypes: ["CallExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "CallExpression") return null
    const name = calleeName(node)
    if (!name || !TARGET_FNS.has(name)) return null
    if (!hasShellTrueLiteral(node.arguments ?? [])) return null
    return {
      message: `\`${name}\` invoked with \`{ shell: true }\` — turns the non-shell API into a shell-execution path, exposing it to argument-injection attacks. Pass an argv array without the shell option, or sanitize via \`shell-quote\` first.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
