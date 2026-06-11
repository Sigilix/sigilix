// SIG-312: integration — the dynamic-HTML-sink line-scan flows through the SAME
// runner pipeline as the AST rules (changed-line filter, finding id, emit flag).

import { describe, it, expect } from "vitest"
import { runAstRules } from "@/src/features/ast-rules/app/runner"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

const CTX = { owner: "o", repo: "r", prNumber: 1 }
const DEFAULT_CONFIG = {
  enabled: true,
  severityThreshold: "warning" as const,
  disabledRules: [],
  autoInline: false,
}
const REVIEWABLE_AT = (path: string, line: number): ReviewableMap => new Map([[path, [{ line, side: "RIGHT" }]]])

function diffAdd(path: string, line: number, text: string): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
  return header + `@@ -${line},0 +${line},1 @@\n+${text}\n`
}

const HTML = (f: { ruleId: string }) => f.ruleId === "no-dangerous-html-dynamic"

describe("runAstRules — SIG-312 dynamic-HTML-sink emission", () => {
  it("emits a security/error/emitWhenUnmatched finding for dangerouslySetInnerHTML of a member access", async () => {
    const path = "src/Comment.tsx"
    const src = `const x = <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />`
    const r = await runAstRules({
      diff: diffAdd(path, 1, src),
      filesByPath: new Map([[path, src]]),
      reviewable: REVIEWABLE_AT(path, 1),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    const html = r.findings.filter(HTML)
    expect(html.length).toBe(1)
    // SIG-312: warning (P2 advisory), not error — a line-scan can't prove the
    // value is untrusted vs a trusted constant table.
    expect(html[0]!.severity).toBe("warning")
    expect(html[0]!.roleHint).toBe("security")
    expect(html[0]!.emitWhenUnmatched).toBe(true)
    expect(html[0]!.line).toBe(1)
    expect(html[0]!.astFindingId).toMatch(/^ast\/no-dangerous-html-dynamic\//)
  })

  it("is suppressible via config.disabledRules (CodeRabbit #296)", async () => {
    const path = "src/Comment.tsx"
    const src = `const x = <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />`
    const r = await runAstRules({
      diff: diffAdd(path, 1, src),
      filesByPath: new Map([[path, src]]),
      reviewable: REVIEWABLE_AT(path, 1),
      config: { ...DEFAULT_CONFIG, disabledRules: ["no-dangerous-html-dynamic"] },
      ctx: CTX,
    })
    expect(r.findings.filter(HTML).length).toBe(0)
  })

  it("does NOT emit for a sanitized / constant sink", async () => {
    const path = "src/Safe.tsx"
    const src = `const x = <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(c.bodyHtml) }} />`
    const r = await runAstRules({
      diff: diffAdd(path, 1, src),
      filesByPath: new Map([[path, src]]),
      reviewable: REVIEWABLE_AT(path, 1),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.filter(HTML).length).toBe(0)
  })

  it("respects severityThreshold (a warning rule is filtered when threshold=error) (CodeRabbit #296)", async () => {
    const path = "src/Comment.tsx"
    const src = `const x = <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />`
    const r = await runAstRules({
      diff: diffAdd(path, 1, src),
      filesByPath: new Map([[path, src]]),
      reviewable: REVIEWABLE_AT(path, 1),
      config: { ...DEFAULT_CONFIG, severityThreshold: "error" },
      ctx: CTX,
    })
    expect(r.findings.filter(HTML).length).toBe(0)
  })

  it("respects the changed-line filter (a sink OUTSIDE the diff is not emitted)", async () => {
    const path = "src/Comment.tsx"
    const src = `const a = 1\nconst x = <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />`
    // diff only adds line 1 (`const a = 1`); the sink on line 2 is untouched.
    const r = await runAstRules({
      diff: diffAdd(path, 1, "const a = 1"),
      filesByPath: new Map([[path, src]]),
      reviewable: REVIEWABLE_AT(path, 1),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.filter(HTML).length).toBe(0)
  })
})
