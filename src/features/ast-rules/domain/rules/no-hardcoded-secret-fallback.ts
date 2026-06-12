// no-hardcoded-secret-fallback — a DETERMINISTIC fail-open floor (CWE-798 /
// CWE-1188). Flags a SECRET read with a hardcoded string-literal fallback:
// `const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "whsec_test_placeholder"`.
//
// WHY this is a bug, not a convenience: if the env var is unset in production,
// the binding does NOT fail — it silently falls back to the literal. A
// signature / token / secret check then verifies against a constant the source
// code (and anyone who has read it) already knows, so forged requests pass. The
// b14 benchmark case is exactly this: a webhook HMAC secret defaulting to a
// placeholder ⇒ an attacker can mint valid signatures. Fail CLOSED instead:
// read the env var and throw when it is missing, never default to a literal.
//
// WHY deterministic: the security specialist reasons about this, but
// NONDETERMINISTICALLY (run-to-run draw variance). This is the run-INVARIANT
// floor — an obvious `secret = process.env.X ?? "literal"` is never silently
// missed on a given run.
//
// FP-SAFETY (a P0/P1 false positive on safe code is the worst outcome → fail
// CLOSED on every doubt; mirrors no-insecure-random-token):
//   - severity `warning` → the deterministic-emit synth path pins it to P2 and
//     `clampAstEmitScores` HARD-caps it; this rule can NEVER post a P0/P1 alone.
//   - ENV-GATED + NAME-GATED: fires only when the fallback chain actually reads
//     a `process.env` var AND (the binding name OR the env key) reads like a
//     credential. A config-merge default with no env read
//     (`const apiKey = config.apiKey ?? "x"`) or a non-secret env default
//     (`const port = process.env.PORT ?? "3000"`) never fires.
//   - The literal must be in the FALLBACK (right) position of `??` / `||`, and
//     NON-EMPTY. `?? ""` (fail-to-empty) and `"lit" ?? env` (literal is the
//     always-used left operand, not a fallback) are different shapes — not flagged.
//   - `as`-cast / non-null / paren wrappers are transparent (an `(env ?? "x") as
//     string` env read is still seen); a no-substitution template literal counts
//     as a string literal. A SUBSTITUTED template (`` `${x}` ``) is not constant.
//   - Test / spec / mock / fixture files are skipped (not production secrets).
//   - The fix is unambiguous: throw on a missing secret; never inline a literal.

import { isCredentialName } from "@/src/features/ast-rules/domain/credential-names"
import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const SKIP_PATH = /(\.test\.|\.spec\.|\.mock\.|\.fixture\.|(^|\/)(__tests__|__mocks__|tests?|fixtures?|mocks?)\/)/

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

/** A key as an `Identifier` name OR a string `Literal` value (quoted keys + computed member). */
function keyName(n: AstNode | undefined): string | null {
  if (!n) return null
  if (n.type === "Identifier") return n.name as string
  if (n.type === "Literal" && typeof n.value === "string") return n.value
  return null
}

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** The credential-key of a `process.env.X` / `process.env["X"]` read, or null. */
function processEnvKey(n: AstNode | undefined): string | null {
  if (!n || n.type !== "MemberExpression") return null
  const obj = n.object as AstNode
  if (!obj || obj.type !== "MemberExpression") return null
  if (idName(obj.object as AstNode) !== "process" || idName(obj.property as AstNode) !== "env") return null
  return keyName(n.property as AstNode)
}

/** Strip transparent wrappers that don't change the runtime value, so an env
 *  read or fallback literal inside `(env ?? "x") as string` / `env!` / `(env)`
 *  is still seen. */
function unwrap(n: AstNode | null | undefined): AstNode | undefined {
  let cur = n ?? undefined
  while (
    cur &&
    (cur.type === "TSAsExpression" ||
      cur.type === "TSNonNullExpression" ||
      cur.type === "TSSatisfiesExpression" ||
      cur.type === "ParenthesizedExpression")
  ) {
    cur = cur.expression as AstNode
  }
  return cur
}

/** A non-empty CONSTANT string's value (a string `Literal`, or a template
 *  literal with NO substitutions), else null. `?? ""` and `` `${x}` `` are
 *  different shapes — not constant secrets. */
function constantStringValue(n: AstNode | undefined): string | null {
  if (!n) return null
  if (n.type === "Literal" && typeof n.value === "string" && n.value.length > 0) return n.value
  if (n.type === "TemplateLiteral" && Array.isArray(n.expressions) && n.expressions.length === 0) {
    const cooked = Array.isArray(n.quasis) ? n.quasis[0]?.value?.cooked : undefined
    if (typeof cooked === "string" && cooked.length > 0) return cooked
  }
  return null
}

/** Walk a `??` / `||` fallback chain. Reports whether the chain reads ANY
 *  `process.env` var (`envAny`), whether any such read is credential-named
 *  (`envSecret`), and the first non-empty constant-string FALLBACK (a right
 *  operand only — a left operand is the always-used value, never a fallback). */
function analyzeFallbackChain(expr: AstNode): {
  envSecret: boolean
  envAny: boolean
  literal: AstNode | null
} {
  let envSecret = false
  let envAny = false
  let literal: AstNode | null = null
  const visit = (raw: AstNode | undefined, isFallback: boolean): void => {
    const n = unwrap(raw)
    if (!n) return
    if (n.type === "LogicalExpression" && (n.operator === "??" || n.operator === "||")) {
      visit(n.left as AstNode, false)
      visit(n.right as AstNode, true)
      return
    }
    const envKey = processEnvKey(n)
    if (envKey !== null) {
      envAny = true
      if (isCredentialName(envKey)) envSecret = true
    }
    if (isFallback && literal === null && constantStringValue(n) !== null) literal = n
  }
  visit(expr, false)
  return { envSecret, envAny, literal }
}

/** The (name, value) of a binding-like node, or null. Covers `const X = …`,
 *  `X = …` / `obj.secret = …`, and object properties `{ secret: … }`. */
function bindingTarget(node: AstNode): { name: string | null; value: AstNode | null } | null {
  if (node.type === "VariableDeclarator") {
    return { name: idName(node.id as AstNode), value: (node.init as AstNode) ?? null }
  }
  if (node.type === "AssignmentExpression") {
    const left = node.left as AstNode
    const name = left?.type === "MemberExpression" ? keyName(left.property as AstNode) : idName(left)
    return { name, value: (node.right as AstNode) ?? null }
  }
  if (node.type === "Property") {
    return { name: keyName(node.key as AstNode), value: (node.value as AstNode) ?? null }
  }
  return null
}

export const noHardcodedSecretFallback: AstRule = {
  id: "no-hardcoded-secret-fallback",
  severity: "warning",
  roleHint: "security",
  shortDescription:
    'secret read with a hardcoded string-literal fallback (`process.env.X ?? "literal"`) — fails open to a known constant',
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const hits: AstRuleHit[] = []
    const seen = new Set<number>() // dedupe by fallback-literal start offset

    const walk = (n: AstNode): void => {
      if (!n || typeof n !== "object") return

      const b = bindingTarget(n)
      const value = unwrap(b?.value)
      if (value && value.type === "LogicalExpression" && (value.operator === "??" || value.operator === "||")) {
        const { envSecret, envAny, literal } = analyzeFallbackChain(value)
        // ENV-gated: an actual process.env read must be present, AND the binding
        // name or the env key must read like a credential. Kills config-merge
        // defaults (`config.apiKey ?? "x"`) that merely have a secret-shaped name.
        if (literal && envAny && (isCredentialName(b?.name) || envSecret)) {
          const start = typeof literal.start === "number" ? literal.start : -1
          if (!(start >= 0 && seen.has(start))) {
            if (start >= 0) seen.add(start)
            hits.push({
              message:
                'This secret is read with a hardcoded fallback (`process.env.X ?? "…"`). If the environment variable is unset in production, the binding silently falls back to the literal instead of failing — so any signature / token / secret check then verifies against a constant that is visible in the source, and an attacker who knows (or guesses) the placeholder can forge valid requests (CWE-798 hardcoded credential / CWE-1188 fail-open default). Fail closed: read the env var and throw when it is missing (`const X = process.env.X; if (!X) throw new Error("X is required")`), never default to a literal secret.',
              evidence: sliceEvidence(ctx.source, value),
              line: value.loc?.start?.line ?? 1,
              endLine: value.loc?.end?.line ?? value.loc?.start?.line ?? 1,
              column: value.loc?.start?.column ?? 0,
            })
          }
        }
      }

      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue
        const v = (n as Record<string, unknown>)[k]
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
        } else if (v && typeof v === "object") {
          walk(v as AstNode)
        }
      }
    }
    walk(node)

    return hits.length > 0 ? hits : null
  },
}
