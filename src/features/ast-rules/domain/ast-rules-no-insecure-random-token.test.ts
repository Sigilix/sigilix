// no-insecure-random-token — deterministic weak-randomness floor (CWE-338).
// Positives = Math.random() minting a credential-named secret. Negatives = the
// FP-safety set (non-credential randomness + CSPRNG + plurals + test files).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noInsecureRandomToken } from "@/src/features/ast-rules/domain/rules/no-insecure-random-token"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "src/auth/tokens.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noInsecureRandomToken.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noInsecureRandomToken.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-insecure-random-token — FIRES on Math.random() minting a secret", () => {
  it("const token = Math.random().toString(36)", () => {
    expect(runRule(`const token = Math.random().toString(36).slice(2);`).length).toBe(1)
  })
  it("const apiKey = ... Math.random() (camelCase suffix)", () => {
    expect(runRule(`const apiKey = "k_" + Math.random().toString(36);`).length).toBe(1)
  })
  it("api_key = ... Math.random() (snake_case normalized)", () => {
    expect(runRule(`let api_key; api_key = Math.random().toString(16);`).length).toBe(1)
  })
  it("member assignment: user.resetToken = Math.random()", () => {
    expect(runRule(`user.resetToken = Math.random().toString(36);`).length).toBe(1)
  })
  it("otp via Math.floor(Math.random() * 1e6)", () => {
    expect(runRule(`const otp = Math.floor(Math.random() * 1000000);`).length).toBe(1)
  })
  it("object property { csrfToken: Math.random() }", () => {
    expect(runRule(`const res = { csrfToken: Math.random().toString(16) };`).length).toBe(1)
  })
  it("a credential-named FACTORY function returning Math.random()", () => {
    const src = `function generateToken() { return Math.random().toString(36).slice(2); }`
    expect(runRule(src).length).toBe(1)
  })
  it("sessionId minted from Math.random() (predictable session)", () => {
    expect(runRule(`const sessionId = Math.random().toString(36);`).length).toBe(1)
  })
  it("a crypto salt (passwordSalt) fires; the bare-chemistry 'salt' words don't", () => {
    expect(runRule(`const passwordSalt = Math.random().toString(16);`).length).toBe(1)
  })
  it("an object-method credential factory { generateToken() { return Math.random() } } fires", () => {
    expect(runRule(`const f = { generateToken() { return Math.random().toString(36); } };`).length).toBe(1)
  })
  it('quoted object key { "apiKey": Math.random() } fires (CodeRabbit #346)', () => {
    expect(runRule(`const c = { "apiKey": Math.random().toString(36) };`).length).toBe(1)
  })
  it('computed member assignment obj["resetToken"] = Math.random() fires (CodeRabbit #346)', () => {
    expect(runRule(`obj["resetToken"] = Math.random().toString(36);`).length).toBe(1)
  })
  it("class method credential factory fires (CodeRabbit #346)", () => {
    expect(runRule(`class Auth { resetToken() { return Math.random().toString(36); } }`).length).toBe(1)
  })
  it("a computed member with a NON-credential key does not fire", () => {
    expect(runRule(`obj["cacheKey"] = Math.random();`).length).toBe(0)
  })
})

describe("no-insecure-random-token — FP-safety: does NOT fire on safe / non-secret randomness", () => {
  it("non-credential names (jitter / index) never fire", () => {
    expect(runRule(`const jitter = Math.random() * 100; const index = Math.floor(Math.random() * 10);`).length).toBe(0)
  })
  it("generic 'key' suffixes are NOT credential names (cacheKey, sortKey, publicKey)", () => {
    expect(
      runRule(
        `const cacheKey = Math.random().toString(36); const sortKey = Math.random(); const publicKey = Math.random();`,
      ).length,
    ).toBe(0)
  })
  it("non-secret 'token' cursors do NOT fire (cancelToken, nextToken, cancellationToken, pageToken)", () => {
    const src = `
const cancelToken = Math.random();
const nextToken = Math.random();
const cancellationToken = Math.random();
const pageToken = Math.random();`
    expect(runRule(src).length).toBe(0)
  })
  it("chemistry/culinary words ending in 'salt' do NOT fire (basalt, seaSalt, rockSalt)", () => {
    expect(
      runRule(`const basalt = Math.random(); const seaSalt = Math.random(); const rockSalt = Math.random();`).length,
    ).toBe(0)
  })
  it("plural 'tokens' (a collection, not a single secret) does not fire", () => {
    expect(runRule(`const tokens = pick(list, Math.random());`).length).toBe(0)
  })
  it("a CSPRNG token (no Math.random) never fires", () => {
    expect(
      runRule(`const token = crypto.randomUUID(); const secret = crypto.getRandomValues(new Uint8Array(16));`).length,
    ).toBe(0)
  })
  it("a credential-named function with NO Math.random in its return does not fire", () => {
    // a lexer's nextToken() — name ends 'token' but no weak randomness
    const src = `function nextToken() { return this.buffer[this.i++]; }`
    expect(runRule(src).length).toBe(0)
  })
  it("skips test / mock / fixture files", () => {
    const src = `const token = Math.random().toString(36);`
    expect(runRule(src, "tests/auth.test.ts").length).toBe(0)
    expect(runRule(src, "src/__mocks__/auth.ts").length).toBe(0)
    expect(runRule(src, "src/auth.fixture.ts").length).toBe(0)
  })
  it("emits at most once per Math.random() site (no double-count)", () => {
    // both the VariableDeclarator branch and a wrapping context could see it
    const src = `const token = String(Math.random());`
    expect(runRule(src).length).toBe(1)
  })
})
