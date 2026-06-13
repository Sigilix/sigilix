// no-hmac-over-reserialized-body — a DETERMINISTIC recall floor (CWE-345 /
// CWE-347). Flags a webhook/request signature computed over a RE-SERIALIZED
// request body instead of the raw received bytes:
//   const raw = JSON.stringify(req.body);
//   const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
//
// WHY this is a bug: `JSON.stringify(req.body)` re-encodes the PARSED body, so
// the bytes it produces are NOT the bytes the provider signed — key order,
// whitespace, unicode escaping, and number formatting can all differ. Depending
// on the parser/serializer, that either breaks every verification (DoS) or, worse,
// lets an attacker craft a body that re-serializes to the signed bytes while
// carrying different parsed values (signature bypass). Sign/verify against the
// EXACT raw request bytes (e.g. an express.raw() Buffer), never a re-stringified
// object. This is the b20 benchmark row.
//
// WHY deterministic: the security specialist NEVER emits this on its own (0/12 at
// K=12, even with the class named verbatim in the recall prompt — a genuine
// model-blind row). This is the run-INVARIANT floor that surfaces it.
//
// FP-SAFETY (fail CLOSED on every doubt; mirrors no-hardcoded-secret-fallback):
//   - severity `warning` → the deterministic-emit synth path pins it to P2 and
//     `clampAstEmitScores` HARD-caps it; this rule can NEVER post a P0/P1 alone.
//   - TRIPLE-gated: fires only when (1) an HMAC is built (`createHmac(...)`), AND
//     (2) its `.update()` argument is `JSON.stringify(<x>.body)` — or an identifier
//     bound to exactly that — so a generic `.update(buf)` stream write or an HMAC
//     over a non-body value never fires. The `.body` member anchors it to a
//     request body; arbitrary `JSON.stringify` (cache keys, ETags) is not flagged.
//   - Test / spec / mock / fixture files are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const SKIP_PATH = /(\.test\.|\.spec\.|\.mock\.|\.fixture\.|(^|\/)(__tests__|__mocks__|tests?|fixtures?|mocks?)\/)/

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

function calleeName(call: AstNode | undefined): string | null {
  if (!call || call.type !== "CallExpression") return null
  const callee = call.callee as AstNode
  if (!callee) return null
  if (callee.type === "Identifier") return callee.name as string
  if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return callee.property.name as string
  }
  return null
}

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** True when `n` is `JSON.stringify(<member>.body)` — a re-serialization of a
 *  request body. The `.body` member anchors it to a request payload. */
function isJsonStringifyOfBody(n: AstNode | undefined): boolean {
  if (!n || n.type !== "CallExpression") return false
  const callee = n.callee as AstNode
  if (
    !callee ||
    callee.type !== "MemberExpression" ||
    idName(callee.object as AstNode) !== "JSON" ||
    idName(callee.property as AstNode) !== "stringify"
  ) {
    return false
  }
  const arg = (n.arguments as AstNode[])?.[0]
  return !!arg && arg.type === "MemberExpression" && idName(arg.property as AstNode) === "body"
}

/** Receiver of an `.update(...)` call resolves to an `createHmac(...)` builder —
 *  either a direct chain `createHmac(...).update(...)` or one `.update` hop on
 *  another `.update` whose root is createHmac. */
function receiverIsHmac(updateCall: AstNode): boolean {
  let recv = (updateCall.callee as AstNode)?.object as AstNode | undefined
  // walk back through chained `.update()` / `.setEncoding()` calls to the root.
  let guard = 0
  while (recv && recv.type === "CallExpression" && guard++ < 8) {
    if (calleeName(recv) === "createHmac" || calleeName(recv) === "createHash") return true
    recv = (recv.callee as AstNode)?.object as AstNode | undefined
  }
  return false
}

export const noHmacOverReserializedBody: AstRule = {
  id: "no-hmac-over-reserialized-body",
  severity: "warning",
  roleHint: "security",
  shortDescription:
    "signature/HMAC computed over `JSON.stringify(req.body)` (re-serialized JSON) instead of the raw request bytes",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    // Pass 1: identifiers bound to `JSON.stringify(<x>.body)`.
    const reserializedBodyVars = new Set<string>()
    const collect = (n: AstNode): void => {
      if (!n || typeof n !== "object") return
      if (n.type === "VariableDeclarator") {
        const name = idName(n.id as AstNode)
        if (name !== null && isJsonStringifyOfBody(n.init as AstNode)) reserializedBodyVars.add(name)
      }
      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue
        const v = (n as Record<string, unknown>)[k]
        if (Array.isArray(v)) {
          for (const it of v) if (it && typeof it === "object") collect(it as AstNode)
        } else if (v && typeof v === "object") {
          collect(v as AstNode)
        }
      }
    }
    collect(node)

    // Pass 2: HMAC `.update(arg)` calls whose arg is a re-serialized body.
    const hits: AstRuleHit[] = []
    const seen = new Set<number>()
    const walk = (n: AstNode): void => {
      if (!n || typeof n !== "object") return
      if (n.type === "CallExpression" && calleeName(n) === "update" && receiverIsHmac(n)) {
        const arg = (n.arguments as AstNode[])?.[0]
        const argIsReserialized =
          isJsonStringifyOfBody(arg) || (arg?.type === "Identifier" && reserializedBodyVars.has(arg.name as string))
        if (argIsReserialized) {
          const start = typeof n.start === "number" ? n.start : -1
          if (!(start >= 0 && seen.has(start))) {
            if (start >= 0) seen.add(start)
            hits.push({
              message:
                "This signature/HMAC is computed over `JSON.stringify(req.body)` — the RE-SERIALIZED parsed body, not the raw bytes the sender signed. Re-encoding can change key order, whitespace, unicode escaping, and number formatting, so the digest will not match what the provider signed: at best every legitimate webhook is rejected, and at worst an attacker crafts a body that re-serializes to the signed bytes while carrying different parsed values, bypassing verification (CWE-345/CWE-347). Verify against the EXACT raw request bytes (e.g. capture the body with `express.raw()` and HMAC the Buffer), never a re-stringified object.",
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
          for (const it of v) if (it && typeof it === "object") walk(it as AstNode)
        } else if (v && typeof v === "object") {
          walk(v as AstNode)
        }
      }
    }
    walk(node)

    return hits.length > 0 ? hits : null
  },
}
