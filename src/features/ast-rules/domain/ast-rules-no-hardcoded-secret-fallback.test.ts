// no-hardcoded-secret-fallback — deterministic fail-open floor (CWE-798).
// Positives = a credential read with a non-empty string-literal `??`/`||`
// fallback. Negatives = the FP-safety set (non-secret defaults, fail-to-empty,
// no-literal fallbacks, test files).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noHardcodedSecretFallback } from "@/src/features/ast-rules/domain/rules/no-hardcoded-secret-fallback"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "src/server/payments.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noHardcodedSecretFallback.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noHardcodedSecretFallback.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-hardcoded-secret-fallback — FIRES on a secret defaulting to a literal", () => {
  it("the b14 case: WEBHOOK_SECRET ?? placeholder", () => {
    expect(runRule(`const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "whsec_test_placeholder";`).length).toBe(1)
  })
  it("|| variant", () => {
    expect(runRule(`const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";`).length).toBe(1)
  })
  it("generic binding name but credential env key (envSecret path)", () => {
    expect(runRule(`const s = process.env.API_KEY ?? "sk_test_abc";`).length).toBe(1)
  })
  it("computed env access process.env['SIGNING_SECRET']", () => {
    expect(runRule(`const x = process.env["SIGNING_SECRET"] ?? "fallback";`).length).toBe(1)
  })
  it("member assignment: config.apiSecret = env ?? literal", () => {
    expect(runRule(`config.apiSecret = process.env.API_SECRET ?? "hardcoded";`).length).toBe(1)
  })
  it("object property { clientSecret: env ?? literal }", () => {
    expect(runRule(`const o = { clientSecret: process.env.CLIENT_SECRET ?? "x" };`).length).toBe(1)
  })
  it("chained fallback env ?? env ?? literal", () => {
    expect(runRule(`const PASSWORD = process.env.PASSWORD ?? process.env.PW ?? "default-pw";`).length).toBe(1)
  })
  it("`as`-cast wrapper is transparent", () => {
    expect(runRule(`const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET ?? "whsec_x") as string;`).length).toBe(1)
  })
  it("no-substitution template literal counts as a constant secret", () => {
    expect(runRule("const JWT_SECRET = process.env.JWT_SECRET ?? `dev-secret`;").length).toBe(1)
  })
})

describe("no-hardcoded-secret-fallback — FP-safe: does NOT fire", () => {
  it("non-secret default (PORT)", () => {
    expect(runRule(`const port = process.env.PORT ?? "3000";`).length).toBe(0)
  })
  it("fail-to-empty `?? ''` is a different shape", () => {
    expect(runRule(`const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";`).length).toBe(0)
  })
  it("no literal fallback — env ?? env", () => {
    expect(runRule(`const SECRET = process.env.SECRET ?? process.env.BACKUP_SECRET;`).length).toBe(0)
  })
  it("plain secret read with no fallback", () => {
    expect(runRule(`const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;`).length).toBe(0)
  })
  it("non-credential literal default with || (feature flag)", () => {
    expect(runRule(`const region = process.env.REGION || "us-east-1";`).length).toBe(0)
  })
  it("C1: credential-named binding with a NON-env source (config merge) does not fire", () => {
    expect(runRule(`const apiKey = config.apiKey ?? "default-key";`).length).toBe(0)
  })
  it("C1: secret-named binding from user input does not fire", () => {
    expect(runRule(`const password = userInput ?? "changeme";`).length).toBe(0)
  })
  it("M2: literal in the LEFT (always-used) position is not a fallback", () => {
    expect(runRule(`const SECRET = "lit" ?? process.env.SECRET;`).length).toBe(0)
  })
  it("a SUBSTITUTED template fallback is not a constant secret", () => {
    expect(runRule("const SECRET = process.env.SECRET ?? `pre-${dyn}`;").length).toBe(0)
  })
  it("skips test / fixture files", () => {
    expect(
      runRule(`const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "whsec_test";`, "src/server/payments.test.ts")
        .length,
    ).toBe(0)
  })
})
