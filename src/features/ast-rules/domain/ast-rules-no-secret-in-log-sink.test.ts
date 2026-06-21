// no-secret-in-log-sink — deterministic CWE-532 recall floor (SIG-485).
// Positives = a credential written to a log sink. Negatives = the FP-safety set
// (string literals, non-credential names, length reads, non-log calls, test files).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noSecretInLogSink } from "@/src/features/ast-rules/domain/rules/no-secret-in-log-sink"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "src/server/auth.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noSecretInLogSink.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noSecretInLogSink.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-secret-in-log-sink — FIRES on a credential logged to a sink", () => {
  it("console.log(apiKey)", () => {
    expect(runRule(`console.log(apiKey);`).length).toBe(1)
  })
  it("logger.info({ token }) shorthand", () => {
    expect(runRule(`logger.info({ token });`).length).toBe(1)
  })
  it("console.warn(user.password) — credential member property", () => {
    expect(runRule(`console.warn(user.password);`).length).toBe(1)
  })
  it("console.log(process.env.API_KEY)", () => {
    expect(runRule(`console.log(process.env.API_KEY);`).length).toBe(1)
  })
  it("template interpolation: logger.error(`key=${apiKey}`)", () => {
    expect(runRule("logger.error(`key=${apiKey}`);").length).toBe(1)
  })
  it("this.logger.info({ apiKey: k }) — nested log root + explicit credential key", () => {
    expect(runRule(`this.logger.info({ apiKey: k });`).length).toBe(1)
  })
  it("log.debug('ctx', { sessionId }) — credential among multiple args", () => {
    expect(runRule(`log.debug("ctx", { sessionId });`).length).toBe(1)
  })
  it("dedupes one hit per log call", () => {
    expect(runRule(`console.log(apiKey, token);`).length).toBe(1)
  })
})

describe("no-secret-in-log-sink — does NOT fire (FP-safety)", () => {
  it("a bare string literal", () => {
    expect(runRule(`console.log("ok");`)).toHaveLength(0)
    expect(runRule(`console.log("apiKey");`)).toHaveLength(0) // the WORD, not the value
  })
  it("non-credential names (length / nextToken / port / requestId)", () => {
    expect(runRule(`console.log(items.length);`)).toHaveLength(0)
    expect(runRule(`console.log(nextToken);`)).toHaveLength(0)
    expect(runRule(`console.log(port);`)).toHaveLength(0)
    expect(runRule(`logger.info({ requestId });`)).toHaveLength(0)
  })
  it("logging a NON-credential property of a credential object (the length, not the secret)", () => {
    expect(runRule(`console.log(apiKey.length);`)).toHaveLength(0)
  })
  it("a credential constant under a credential key is not a runtime leak", () => {
    expect(runRule(`logger.info({ token: "literal" });`)).toHaveLength(0)
  })
  it("not a logging sink", () => {
    expect(runRule(`mailer.send(apiKey);`)).toHaveLength(0)
    expect(runRule(`const x = apiKey;`)).toHaveLength(0)
  })
  it("test / spec / fixture files are skipped", () => {
    expect(runRule(`console.log(apiKey);`, "src/server/auth.test.ts")).toHaveLength(0)
    expect(runRule(`console.log(apiKey);`, "src/__mocks__/auth.ts")).toHaveLength(0)
  })
})
