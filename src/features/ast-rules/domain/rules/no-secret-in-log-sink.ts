// no-secret-in-log-sink — a DETERMINISTIC recall floor (CWE-532 insertion of
// sensitive information into a log). Flags a SECRET / credential written to a
// logging sink: `console.log(apiKey)`, `logger.info({ token })`,
// `logger.error(\`key=${apiKey}\`)`, `console.warn(user.password)`.
//
// WHY a floor, not just the model: the security specialist SHOULD flag this, but
// the specialist prompts carry a NON-NEGOTIABLE "do not comment on console.log"
// rule, so the model obeys the absolute ban and never raises it — making
// secret-in-log a structurally-guaranteed MISS (SIG-485 / the recall-headroom
// scope confirmed 0% recall on this class, twice, on EASY-tier benchmark PRs).
// This is the run-INVARIANT floor: an obvious credential logged to console/logger
// is never silently missed on a given run, regardless of the prompt.
//
// FP-SAFETY (a P0/P1 false positive is the worst outcome → fail CLOSED on doubt;
// mirrors no-hardcoded-secret-fallback):
//   - severity `warning` → the deterministic-emit synth path pins it to P2 and
//     `clampAstEmitScores` HARD-caps it; this rule can NEVER post a P0/P1 alone.
//   - SINK-GATED: fires only inside a recognized log call — `console.<m>`,
//     `logger.<m>`, `log.<m>`, or `<x>.logger/.log.<m>` (this.logger.info,
//     ctx.log.error), method ∈ log/info/warn/error/debug/trace.
//   - NAME-GATED via the shared `isCredentialName` — `apiKey`/`token`/`password`/
//     `process.env.SECRET` match; `nextToken`/`port`/`items.length`/`requestId`
//     do NOT. A bare string literal (`console.log("apiKey")`, `console.log("ok")`)
//     has no identifier → never fires.
//   - The credential must be a DIRECT value being logged: a bare credential
//     identifier, a member whose PROPERTY is a credential (`user.password`,
//     `process.env.API_KEY`), an object property keyed/valued by a credential
//     (`{ token }`, `{ apiKey: k }`), or a credential interpolated into a template
//     (`\`...${apiKey}...\``). A non-credential property of a credential object
//     (`apiKey.length`) is the safe "log the length" shape — NOT flagged.
//   - Test / spec / mock / fixture files are skipped (not production secrets).
//   - The fix is unambiguous: redact / omit the secret; never log it.

import { isCredentialName } from "@/src/features/ast-rules/domain/credential-names"
import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const SKIP_PATH = /(\.test\.|\.spec\.|\.mock\.|\.fixture\.|(^|\/)(__tests__|__mocks__|tests?|fixtures?|mocks?)\/)/
const LOG_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace"])
const LOG_ROOTS = new Set(["console", "logger", "log"])
/** Bound the per-argument subtree walk so a giant logged object can't blow CPU. */
const MAX_ARG_NODES = 400

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

/** A property key as an Identifier name or a string-Literal value (quoted keys). */
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

/** Is this call a logging sink? `console.<m>` / `logger.<m>` / `log.<m>` (root
 *  Identifier) or `<x>.logger.<m>` / `<x>.log.<m>` (this.logger.info, ctx.log.error),
 *  method ∈ LOG_METHODS. Non-computed member only. */
function isLogSink(callee: AstNode | undefined): boolean {
  if (!callee || callee.type !== "MemberExpression" || callee.computed === true) return false
  const method = idName(callee.property as AstNode)
  if (!method || !LOG_METHODS.has(method)) return false
  const obj = callee.object as AstNode
  const root = idName(obj)
  if (root && LOG_ROOTS.has(root)) return true
  // `this.logger` / `ctx.log` / `a.b.logger` — the member's own property is a log root.
  if (obj && obj.type === "MemberExpression" && obj.computed !== true) {
    const innerProp = idName(obj.property as AstNode)
    if (innerProp && LOG_ROOTS.has(innerProp)) return true
  }
  return false
}

/** A credential MEMBER read: a (non-computed) member whose PROPERTY name reads
 *  like a credential — `user.password`, `config.apiKey`, `process.env.SECRET`.
 *  `apiKey.length` is NOT a credential read (property is `length`). */
function isCredentialMember(n: AstNode): boolean {
  return n.type === "MemberExpression" && n.computed !== true && isCredentialName(idName(n.property as AstNode))
}

/** A DIRECT credential value: a bare credential identifier or a credential member.
 *  (The leaf shapes that mean "this exact value is the secret".) */
function isDirectCredentialValue(n: AstNode | undefined): boolean {
  if (!n) return false
  if (n.type === "Identifier") return isCredentialName(n.name as string)
  return isCredentialMember(n)
}

/** Does a single logged ARGUMENT carry a secret? FP-safe — only the direct shapes:
 *  a credential identifier/member, an object property keyed-or-valued by a
 *  credential, or a credential interpolated into a template. Bounded recursion
 *  into objects/templates; never descends into nested functions. */
function argLeaksSecret(arg: AstNode): boolean {
  let budget = MAX_ARG_NODES
  const visit = (n: AstNode | undefined): boolean => {
    if (!n || typeof n !== "object" || budget-- <= 0) return false
    if (isDirectCredentialValue(n)) return true
    if (n.type === "ObjectExpression" && Array.isArray(n.properties)) {
      for (const p of n.properties as AstNode[]) {
        if (!p || p.type !== "Property") continue
        // `{ token }` / `{ apiKey: k }` — a credential KEY (shorthand or explicit)
        // logs a credential value (skip a `{ token: "literal" }` constant).
        const key = p.computed === true ? null : keyName(p.key as AstNode)
        const val = p.value as AstNode
        if (isCredentialName(key) && val && val.type !== "Literal") return true
        if (isDirectCredentialValue(val)) return true
        if (val && val.type === "ObjectExpression" && visit(val)) return true
      }
      return false
    }
    if (n.type === "TemplateLiteral" && Array.isArray(n.expressions)) {
      for (const e of n.expressions as AstNode[]) if (isDirectCredentialValue(e)) return true
      return false
    }
    return false
  }
  return visit(arg)
}

export const noSecretInLogSink: AstRule = {
  id: "no-secret-in-log-sink",
  severity: "warning",
  roleHint: "security",
  shortDescription: "a secret / credential written to a logging sink (`console.log(apiKey)`) — CWE-532 log leak",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const hits: AstRuleHit[] = []
    const seen = new Set<number>() // dedupe by call start offset

    const walk = (n: AstNode): void => {
      if (!n || typeof n !== "object") return

      if (n.type === "CallExpression" && isLogSink(n.callee as AstNode)) {
        const args = Array.isArray(n.arguments) ? (n.arguments as AstNode[]) : []
        if (args.some((a) => argLeaksSecret(a))) {
          const start = typeof n.start === "number" ? n.start : -1
          if (!(start >= 0 && seen.has(start))) {
            if (start >= 0) seen.add(start)
            hits.push({
              message:
                'A secret / credential is written to a logging sink. Logged values land in plaintext log stores, aggregators, and crash reports — where they are broadly readable and outlive the request, leaking the credential to anyone with log access (CWE-532). Redact or omit it: log a non-sensitive identifier instead (a user id, a key fingerprint, or `"[redacted]"`), never the secret itself.',
              evidence: sliceEvidence(ctx.source, n),
              line: n.loc?.start?.line ?? 1,
              endLine: n.loc?.end?.line ?? n.loc?.start?.line ?? 1,
              column: n.loc?.start?.column ?? 0,
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
