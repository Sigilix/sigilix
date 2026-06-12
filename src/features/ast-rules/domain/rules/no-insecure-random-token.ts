// no-insecure-random-token — a DETERMINISTIC weak-randomness floor (CWE-338).
// Flags `Math.random()` whose value flows into a SECURITY-SENSITIVE binding —
// a variable / property / assignment / return named like a credential
// (`token`, `apiKey`, `resetToken`, `password`, `otp`, `nonce`, `csrfToken`,
// `sessionId`, `salt`, …). `Math.random()` is NOT cryptographically secure and
// is predictable, so using it to mint a secret is an exploitable weakness.
//
// WHY this exists: the security specialist catches this by reasoning, but
// NONDETERMINISTICALLY. This is the run-INVARIANT floor: an obvious
// `const token = Math.random().toString(36)` is never silently missed.
//
// FP-SAFETY (a P0/P1 false positive on safe code is the worst outcome, so we
// fail CLOSED on every doubt; mirrors no-unauthorized-object-lookup):
//   - severity `warning` → the deterministic-emit synth path pins it to P2 and
//     `clampAstEmitScores` HARD-caps it; this rule can NEVER post a P0/P1 alone.
//   - NAME-GATED: fires ONLY when the random value lands in a binding whose name
//     reads like a credential. A `Math.random()` for jitter / sampling / a
//     non-security id never fires — the name is the whole signal.
//   - The credential names are CURATED + suffix-matched on a normalized
//     (underscore-stripped) name, so `api_key`/`apiKey`/`reset_token` all match
//     while generic `key`/`id`/`index` do NOT (those would over-fire).
//   - Test / spec / mock / fixture files are skipped (not production secrets).
//   - The fix is unambiguous: Web Crypto (`crypto.getRandomValues`,
//     `crypto.randomUUID`) / `node:crypto.randomBytes`.

import { isCredentialName } from "@/src/features/ast-rules/domain/credential-names"
import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.mock\.|\.fixture\.|(^|\/)(__tests__|__mocks__|tests?|fixtures?|mocks?)\/)/

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

/** A binding key as an `Identifier` name OR a string `Literal` value, so quoted
 *  keys (`{ "apiKey": … }`, `obj["resetToken"]`) are read like bare ones. */
function keyName(n: AstNode | undefined): string | null {
  if (!n) return null
  if (n.type === "Identifier") return n.name as string
  if (n.type === "Literal" && typeof n.value === "string") return n.value
  return null
}

function sliceOf(source: string, node: AstNode | undefined): string {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number") return ""
  return source.slice(node.start, node.end)
}

function sliceEvidence(source: string, node: AstNode): string {
  const slice = sliceOf(source, node)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** Is `node` a `Math.random()` call? (the weak-randomness source) */
function isMathRandomCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false
  const callee = node.callee as AstNode
  return (
    !!callee &&
    callee.type === "MemberExpression" &&
    !callee.computed &&
    idName(callee.object as AstNode) === "Math" &&
    idName(callee.property as AstNode) === "random"
  )
}

/** Find the first `Math.random()` call in a subtree, WITHOUT descending into a
 *  nested function (a nested callback's randomness is a different scope). */
function findMathRandom(root: AstNode): AstNode | null {
  let found: AstNode | null = null
  function walk(n: AstNode): void {
    if (found || !n || typeof n !== "object") return
    if (typeof n.type === "string" && FUNCTION_TYPES.has(n.type) && n !== root) return
    if (isMathRandomCall(n)) {
      found = n
      return
    }
    for (const k of Object.keys(n)) {
      if (found) return
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (n as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
      } else if (v && typeof v === "object") walk(v as AstNode)
    }
  }
  walk(root)
  return found
}

/** The credential-named binding target of an assignment-like node, or null.
 *  Covers identifier + quoted-string keys, computed member assignments, object
 *  properties, and class methods (CodeRabbit #346). */
function credentialTarget(node: AstNode): AstNode | null {
  if (node.type === "VariableDeclarator") {
    return isCredentialName(idName(node.id as AstNode)) ? ((node.init as AstNode) ?? null) : null
  }
  if (node.type === "AssignmentExpression") {
    const left = node.left as AstNode
    // `tok = …`, `obj.resetToken = …`, AND computed `obj["resetToken"] = …`.
    const name = left?.type === "MemberExpression" ? keyName(left.property as AstNode) : idName(left)
    return isCredentialName(name) ? ((node.right as AstNode) ?? null) : null
  }
  // Object property (incl. quoted `{ "apiKey": … }`) and class methods.
  if (node.type === "Property") {
    return isCredentialName(keyName(node.key as AstNode)) ? ((node.value as AstNode) ?? null) : null
  }
  if (node.type === "MethodDefinition") {
    return isCredentialName(keyName(node.key as AstNode)) ? ((node.value as AstNode) ?? null) : null
  }
  return null
}

export const noInsecureRandomToken: AstRule = {
  id: "no-insecure-random-token",
  severity: "warning",
  roleHint: "security",
  shortDescription: "Math.random() used to generate a security token / secret (not cryptographically secure)",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const hits: AstRuleHit[] = []
    const seen = new Set<number>() // dedupe by Math.random() start offset

    const emit = (randomNode: AstNode): void => {
      const start = typeof randomNode.start === "number" ? randomNode.start : -1
      if (start >= 0 && seen.has(start)) return
      if (start >= 0) seen.add(start)
      hits.push({
        message:
          "`Math.random()` is used to generate what looks like a security token or secret here. `Math.random()` is NOT cryptographically secure — its output is predictable, so an attacker can guess or reproduce the value (CWE-338, insecure randomness). Use a CSPRNG instead: `crypto.getRandomValues()` / `crypto.randomUUID()` in the browser & Workers, or `crypto.randomBytes()` from `node:crypto`.",
        evidence: sliceEvidence(ctx.source, randomNode),
        line: randomNode.loc?.start?.line ?? 1,
        endLine: randomNode.loc?.end?.line ?? randomNode.loc?.start?.line ?? 1,
        column: randomNode.loc?.start?.column ?? 0,
      })
    }

    // (1) credential-named bindings: const token = …Math.random()…,
    //     obj.secret = …, { apiKey: … }. (2) a credential-named FUNCTION whose
    //     body returns Math.random() (e.g. generateToken()).
    function walk(n: AstNode, inCredentialFn: boolean): void {
      if (!n || typeof n !== "object") return

      const target = credentialTarget(n)
      if (target) {
        const r = findMathRandom(target)
        if (r) emit(r)
      }

      // A function named like a credential factory taints its return values.
      let credFn = inCredentialFn
      if (typeof n.type === "string" && FUNCTION_TYPES.has(n.type)) {
        const fnName = n.type === "FunctionDeclaration" ? idName(n.id as AstNode) : null // assigned-name handled by the VariableDeclarator branch
        credFn = isCredentialName(fnName)
      }
      if (credFn && n.type === "ReturnStatement" && n.argument) {
        const r = findMathRandom(n.argument as AstNode)
        if (r) emit(r)
      }

      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue
        const v = (n as Record<string, unknown>)[k]
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === "object") walk(item as AstNode, credFn)
        } else if (v && typeof v === "object") walk(v as AstNode, credFn)
      }
    }
    walk(node, false)

    return hits.length > 0 ? hits : null
  },
}
