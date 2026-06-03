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
//
// SIG-311 (import-binding fix): the v1 rule matched the bare callee NAME
// `exec`/`execSync` with NO binding resolution, so `re.exec(line)`
// (RegExp.prototype.exec), `db.exec(sql)`, `stmt.exec(...)` minted a real
// command-injection fact — the dogfood smoking gun (PR #296: a GROUNDED P0
// "command injection" on `re.exec` inside the XSS detector, child_process not
// even imported). Now the rule only emits when `exec`/`execSync` provably
// resolves to a `child_process` import binding in the same file. Recall-safe by
// construction: the only calls it stops flagging are NON-child_process `.exec`
// (never a shell sink) and exotic aliases the v1 rule never reliably handled
// anyway — every real `child_process.exec` via a standard import still emits.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const TARGET_FNS: ReadonlySet<string> = new Set(["exec", "execSync"])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

interface CallBinding {
  /** The called function name (`exec` / `execSync`). */
  fn: string
  /** The receiver identifier for `x.exec(...)`, or null for a bare `exec(...)`. */
  object: string | null
  /** True for the inline `require("child_process").exec(...)` form. */
  inlineCp: boolean
}

/** Is `node` a `require("child_process")` / `require("node:child_process")` call? */
function isRequireChildProcess(node: AstNode | undefined): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments?.[0]?.type === "Literal" &&
    /^(?:node:)?child_process$/.test(String(node.arguments[0].value))
  )
}

function callBinding(node: AstNode): CallBinding | null {
  const c = node?.callee
  if (!c) return null
  if (c.type === "Identifier") return { fn: c.name as string, object: null, inlineCp: false }
  // Skip computed member access — `obj[varName]()` where `varName` is an
  // Identifier with the target name must not match (mirrors spawn-shell-true).
  if (c.type === "MemberExpression" && !c.computed && c.property?.type === "Identifier") {
    if (c.object?.type === "Identifier") {
      return { fn: c.property.name as string, object: c.object.name as string, inlineCp: false }
    }
    // `require("child_process").exec(...)` — inline require, no named binding.
    if (isRequireChildProcess(c.object)) {
      return { fn: c.property.name as string, object: null, inlineCp: true }
    }
    return { fn: c.property.name as string, object: null, inlineCp: false }
  }
  return null
}

/** `child_process` / `node:child_process` import-or-require source. */
const CP_SRC = String.raw`["'](?:node:)?child_process["']`

/**
 * Resolve, from one file's source, which names bind to `child_process`'s
 * `exec`/`execSync`:
 *  - `bareNames`: destructured `import { exec } from "child_process"` or
 *    `const { exec } = require("child_process")` → a bare `exec(...)` call.
 *  - `namespaces`: `import cp from "child_process"` / `import * as cp` /
 *    `const cp = require("child_process")` → a `cp.exec(...)` call.
 * Regex on the source (imports live at module scope; `child_process` rarely
 * appears in a string/comment). Conservative: only the standard import forms.
 */
function childProcessBindings(source: string): { bareNames: Set<string>; namespaces: Set<string> } {
  const bareNames = new Set<string>()
  const namespaces = new Set<string>()
  const addDestructured = (list: string): void => {
    for (const part of list.split(",")) {
      const name = part.trim().split(/\s+as\s+|:/)[0]!.trim() // `exec`, `exec as run`, `exec: run`
      if (name === "exec" || name === "execSync") bareNames.add(name)
    }
  }
  for (const m of source.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${CP_SRC}`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*require\(\s*${CP_SRC}\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*${CP_SRC}`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  return { bareNames, namespaces }
}

/** The quoted `child_process` module specifier. The closing quote anchors it so
 *  it can't substring-match `child_process_extra` / `child-process-x` (#316). */
const CP_MODULE_RE = /["'](?:node:)?child_process["']/

/** Does this `exec`/`execSync` call resolve to a `child_process` binding? */
function resolvesToChildProcess(binding: CallBinding, source: string): boolean {
  if (binding.inlineCp) return true // require("child_process").exec(...)
  const { bareNames, namespaces } = childProcessBindings(source)
  const resolved = binding.object === null ? bareNames.has(binding.fn) : namespaces.has(binding.object)
  if (resolved) return true
  // RECALL FALLBACK (Sigilix dogfood #316): `childProcessBindings` only parses
  // the standard static import forms. If the file references the child_process
  // module in a shape it can't parse — dynamic `import("child_process")`,
  // `export { exec } from "child_process"`, a conditional require — fall back to
  // the old name-match so a REAL shell-out is never dropped. The PR #296 self-FP
  // still dies: a detector calling `re.exec` references no child_process module
  // at all, so this fallback never fires there.
  return CP_MODULE_RE.test(source)
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
    const binding = callBinding(node)
    if (!binding || !TARGET_FNS.has(binding.fn)) return null
    // SIG-311 (import-binding fix): only a real `child_process` exec/execSync runs
    // a shell. `re.exec(line)` (RegExp), `db.exec(sql)`, `stmt.exec(...)`, or a
    // bare `exec(...)` not imported from child_process are NOT shell sinks — do
    // not mint a command-injection fact (the PR #296 self-FP). Recall-safe: every
    // real `child_process.exec` via a standard import still resolves and emits.
    if (!resolvesToChildProcess(binding, ctx.source)) return null
    const command = (node.arguments ?? [])[0]
    if (!command) return null
    // FP-safe: a provably-constant command string is never a shell-injection
    // path, so do not flag it.
    if (isConstantStringExpr(command)) return null
    return {
      message: `\`${binding.fn}\` runs its command through a shell, and the command here is built from a dynamic value — a command-injection sink. Shell metacharacters in the interpolated value would execute. Use \`execFile(cmd, [args])\` / \`spawn\` without a shell (argv array, no interpolation), or strictly validate/allowlist the value before use.`,
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
