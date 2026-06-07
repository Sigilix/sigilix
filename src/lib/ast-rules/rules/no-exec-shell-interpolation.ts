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
// construction: the calls it stops flagging are NON-child_process `.exec` (never
// a shell sink), re-export-only names (not local call bindings), and arbitrary
// higher-order wrappers the v1 rule never reliably handled anyway — every real
// `child_process.exec` via an explicit supported import still emits.

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
  /** The called identifier or member-property name. */
  fn: string
  /** The receiver identifier for `x.exec(...)`, or null for a bare `exec(...)`. */
  object: string | null
  /** True for the inline `require("child_process").exec(...)` form. */
  inlineCp: boolean
}

type TargetFn = "exec" | "execSync"

interface ChildProcessBindingSet {
  bareNames: Map<string, TargetFn>
  namespaces: Set<string>
}

function stringSpecifier(node: AstNode | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && (node.expressions?.length ?? 0) === 0) {
    const quasi = node.quasis?.[0]
    return (quasi?.value?.cooked ?? quasi?.value?.raw ?? null) as string | null
  }
  return null
}

function isChildProcessSpecifier(node: AstNode | undefined): boolean {
  const specifier = stringSpecifier(node)
  return specifier !== null && /^(?:node:)?child_process$/.test(specifier)
}

/** Is `node` a `require("child_process")` / `require("node:child_process")` call? */
function isRequireChildProcess(node: AstNode | undefined): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "require" &&
    isChildProcessSpecifier(node.arguments?.[0])
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
    return null
  }
  return null
}

/** `child_process` / `node:child_process` import-or-require source. */
const CP_SRC = String.raw`["'](?:node:)?child_process["']`
const CP_CALL_SRC = String.raw`["'\`](?:node:)?child_process["'\`]`

function escapedAlternation(values: ReadonlySet<string>): string | null {
  if (values.size === 0) return null
  return [...values].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
}

/**
 * Resolve, from one file's source, which names bind to `child_process`'s
 * `exec`/`execSync`:
 *  - `bareNames`: local bare-call bindings from
 *    `import { exec } from "child_process"` or
 *    `const { exec } = require("child_process")` / dynamic `import(...)` →
 *    a bare `exec(...)` call. Aliases such as `{ exec: run }` are stored as
 *    `run -> exec`. Parenthesized destructuring assignments are supported too:
 *    `({ exec } = require("child_process"))`.
 *  - `namespaces`: `import cp from "child_process"` / `import * as cp` /
 *    `const cp = require("child_process")` / `await import(...)` →
 *    a `cp.exec(...)` call.
 * Regex on the source (imports live at module scope; `child_process` rarely
 * appears in a string/comment). Conservative: only the standard import forms.
 */
function childProcessBindings(source: string): ChildProcessBindingSet {
  const bareNames = new Map<string, TargetFn>()
  const namespaces = new Set<string>()
  const addBare = (local: string | undefined | null, imported: string | undefined | null): void => {
    if ((imported === "exec" || imported === "execSync") && local) bareNames.set(local, imported)
  }
  const addDestructured = (list: string): void => {
    for (const part of list.split(",")) {
      const spec = part.trim().replace(/\s*=.*$/, "").trim()
      if (!spec || spec.startsWith("...")) continue
      const importAlias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec)
      const objectAlias = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(spec)
      const simple = /^([A-Za-z_$][\w$]*)$/.exec(spec)
      addBare(importAlias?.[2] ?? objectAlias?.[2] ?? simple?.[1] ?? null, importAlias?.[1] ?? objectAlias?.[1] ?? simple?.[1] ?? null)
    }
  }
  for (const m of source.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${CP_SRC}`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`,\s*\{([^}]*)\}\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`,\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`\(\s*\{([^{}]*)\}\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`\(\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?import\(\s*${CP_CALL_SRC}\s*\)\s*\)`, "g"))) {
    addDestructured(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)\s*\.\s*(exec|execSync)\b`, "g"))) {
    addBare(m[1], m[2])
  }
  for (const m of source.matchAll(new RegExp(String.raw`,\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)\s*\.\s*(exec|execSync)\b`, "g"))) {
    addBare(m[1], m[2])
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:^|[;({\n])\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)\s*\.\s*(exec|execSync)\b`, "g"))) {
    addBare(m[1], m[2])
  }
  for (const m of source.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*${CP_SRC}`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`,\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`,\s*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:^|[;({\n])\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  for (const m of source.matchAll(new RegExp(String.raw`(?:^|[;({\n])\s*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\(\s*${CP_CALL_SRC}\s*\)`, "g"))) {
    namespaces.add(m[1]!)
  }
  const namespaceNames = escapedAlternation(namespaces)
  if (namespaceNames !== null) {
    for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:${namespaceNames})\b`, "g"))) {
      addDestructured(m[1]!)
    }
    for (const m of source.matchAll(new RegExp(String.raw`,\s*\{([^}]*)\}\s*=\s*(?:${namespaceNames})\b`, "g"))) {
      addDestructured(m[1]!)
    }
    for (const m of source.matchAll(new RegExp(String.raw`\(\s*\{([^{}]*)\}\s*=\s*(?:${namespaceNames})\b\s*\)`, "g"))) {
      addDestructured(m[1]!)
    }
    for (const m of source.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${namespaceNames})\s*\.\s*(exec|execSync)\b`, "g"))) {
      addBare(m[1], m[2])
    }
    for (const m of source.matchAll(new RegExp(String.raw`,\s*([A-Za-z_$][\w$]*)\s*=\s*(?:${namespaceNames})\s*\.\s*(exec|execSync)\b`, "g"))) {
      addBare(m[1], m[2])
    }
    for (const m of source.matchAll(new RegExp(String.raw`(?:^|[;({\n])\s*([A-Za-z_$][\w$]*)\s*=\s*(?:${namespaceNames})\s*\.\s*(exec|execSync)\b`, "g"))) {
      addBare(m[1], m[2])
    }
  }
  return { bareNames, namespaces }
}

const bindingsCache = new WeakMap<object, { source: string; bindings: ChildProcessBindingSet }>()

function childProcessBindingsFor(ctx: RuleContext): ChildProcessBindingSet {
  const cached = bindingsCache.get(ctx.ast)
  if (cached?.source === ctx.source) return cached.bindings
  const bindings = childProcessBindings(ctx.source)
  bindingsCache.set(ctx.ast, { source: ctx.source, bindings })
  return bindings
}

/** Return the child_process function this call resolves to, if any. */
function resolveChildProcessCall(binding: CallBinding, bindings: ChildProcessBindingSet): TargetFn | null {
  if (binding.inlineCp) return TARGET_FNS.has(binding.fn) ? (binding.fn as TargetFn) : null
  const { bareNames, namespaces } = bindings
  if (binding.object === null) return bareNames.get(binding.fn) ?? null
  return TARGET_FNS.has(binding.fn) && namespaces.has(binding.object) ? (binding.fn as TargetFn) : null
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
    if (!binding) return null
    // SIG-311 (import-binding fix): only a real `child_process` exec/execSync runs
    // a shell. `re.exec(line)` (RegExp), `db.exec(sql)`, `stmt.exec(...)`, or a
    // bare `exec(...)` not imported from child_process are NOT shell sinks — do
    // not mint a command-injection fact (the PR #296 self-FP). Recall-safe: every
    // real `child_process.exec` via a standard import still resolves and emits.
    const shellFn = resolveChildProcessCall(binding, childProcessBindingsFor(ctx))
    if (!shellFn) return null
    const command = (node.arguments ?? [])[0]
    if (!command) return null
    // FP-safe: a provably-constant command string is never a shell-injection
    // path, so do not flag it.
    if (isConstantStringExpr(command)) return null
    const calleeLabel = binding.object === null ? binding.fn : `${binding.object}.${binding.fn}`
    return {
      message: `\`${calleeLabel}\` resolves to \`child_process.${shellFn}\`, which runs its command through a shell, and the command here is built from a dynamic value — a command-injection sink. Shell metacharacters in the interpolated value would execute. Use \`execFile(cmd, [args])\` / \`spawn\` without a shell (argv array, no interpolation), or strictly validate/allowlist the value before use.`,
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
