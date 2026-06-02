// SIG-309: no-exec-shell-interpolation — flags `exec`/`execSync` calls whose
// command argument is NOT a provably-constant string.
//
// `exec`/`execSync` ALWAYS run their command through a shell, so any
// dynamic value built into the command string is a command-injection sink.
// `spawn-shell-true` DELIBERATELY excludes `exec` (there `{shell:true}` is
// redundant) — this rule covers the real `exec` sink it left open. Found via
// the pr/06 benchmark: an `exec(`convert ${path} ...`)` command-injection that
// BOTH CodeRabbit and Greptile caught and Sigilix missed (exec was model-only,
// no deterministic backstop).
//
// FP-safe by construction (mirrors the SIG-292 taint posture): a CONSTANT
// command — a plain string literal, a `${...}`-free template, or a `+`
// concatenation of constants — is never a shell-injection path and is NOT
// flagged. Only a command the rule cannot prove constant is flagged. With
// `astRules.autoInline` off (the default) the finding is injected as evidence
// for the LLM/synth to judge, not auto-reported — Codex's "evidence, not a
// hard report, for borderline" gate.
//
// v1 scope: direct `exec`/`execSync` calls — bare `exec(...)` (from a
// destructured `import { exec }` / `const { exec } = require(...)`) or member
// `cp.exec(...)`. Aliases (`const run = exec`) and `promisify(exec)` wrappers
// need binding analysis and are a follow-up.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const TARGET_FNS: ReadonlySet<string> = new Set(["exec", "execSync"])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function calleeName(node: AstNode): string | null {
  const c = node?.callee
  if (!c) return null
  if (c.type === "Identifier") return c.name as string
  // Skip computed member access — `obj[varName]()` where `varName` is an
  // Identifier with the target name must not match (mirrors spawn-shell-true).
  if (c.type === "MemberExpression" && !c.computed && c.property?.type === "Identifier") {
    return c.property.name as string
  }
  return null
}

/**
 * True iff `node` is a PROVABLY-CONSTANT string expression: a string literal, a
 * template literal with no `${…}` interpolation, or a `+` concatenation whose
 * operands are themselves provably constant. Everything else — an identifier, a
 * member access, a call, an interpolated template, a non-`+` binary — is
 * treated as dynamic (returns false → the caller flags it).
 */
function isConstantStringExpr(node: AstNode | undefined | null): boolean {
  if (!node) return false
  if (node.type === "Literal") return typeof node.value === "string"
  if (node.type === "TemplateLiteral") return (node.expressions?.length ?? 0) === 0
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return isConstantStringExpr(node.left) && isConstantStringExpr(node.right)
  }
  return false
}

export const noExecShellInterpolation: AstRule = {
  id: "no-exec-shell-interpolation",
  severity: "error",
  roleHint: "security",
  shortDescription: "exec()/execSync() with a dynamic command",
  language: "both",
  nodeTypes: ["CallExpression"],
  // FP-safe (constant commands skipped) → emit even when no specialist matched.
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "CallExpression") return null
    const name = calleeName(node)
    if (!name || !TARGET_FNS.has(name)) return null
    const command = (node.arguments ?? [])[0]
    if (!command) return null
    // FP-safe: a provably-constant command string is never a shell-injection
    // path, so do not flag it.
    if (isConstantStringExpr(command)) return null
    return {
      message: `\`${name}\` runs its command through a shell, and the command here is built from a dynamic value — a command-injection sink. Shell metacharacters in the interpolated value would execute. Use \`execFile(cmd, [args])\` / \`spawn\` without a shell (argv array, no interpolation), or strictly validate/allowlist the value before use.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      // A multi-line exec call (wrapped template / line-broken concat) must
      // carry endLine so the runner's diff-line filter sees an interpolation
      // injected on a non-start line, not just the call's start (AstRuleHit
      // contract; CodeRabbit on #292).
      ...(typeof node.loc?.end?.line === "number" ? { endLine: node.loc.end.line } : {}),
      column: node.loc?.start?.column ?? 0,
    }
  },
}
