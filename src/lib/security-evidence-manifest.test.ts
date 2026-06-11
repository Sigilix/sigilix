// SIG-108: security fact manifest unit tests.
//
// Coverage: evidenceId determinism + content-hash stability,
// omit-when-empty render contract, render shape, and the
// per-tool id schemes (secret / depvuln / sarif / ast).

import { describe, it, expect } from "vitest"
import { buildSecurityFactManifest, type SecurityFactManifest } from "@/src/lib/security-evidence-manifest"
import type { SecretHit } from "@/src/lib/secret-scan"
import type { DepVulnFinding } from "@/src/features/dep-vulns"
import type { SarifFinding } from "@/src/features/sarif-evidence"
import type { AstFinding } from "@/src/features/ast-rules/domain/types"
import { DYNAMIC_HTML_SINK_RULE_ID } from "@/src/features/ast-rules/domain/scan-dynamic-html-sink"

function secretHit(overrides: Partial<SecretHit> = {}): SecretHit {
  return {
    ruleId: "generic-api-key",
    category: "generic",
    severity: "error",
    path: "src/config.ts",
    line: 42,
    matchLength: 32,
    redactedPreview: "ab12…ef56",
    fingerprint: "generic-api-key:src/config.ts:42:ab12…ef56",
    ...overrides,
  }
}

function depVuln(overrides: Partial<DepVulnFinding> = {}): DepVulnFinding {
  return {
    ecosystem: "npm",
    package_name: "lodash",
    version: "4.17.20",
    source_path: "package.json",
    advisory_id: "GHSA-xxxx-yyyy-zzzz",
    advisory_source: "github",
    vulnerable_range: "<4.17.21",
    patched_in: "4.17.21",
    severity: "high",
    summary: "Prototype pollution",
    fix_guidance: "Upgrade to 4.17.21",
    match_type: "range-vulnerable",
    ...overrides,
  } as DepVulnFinding
}

function sarifFinding(overrides: Partial<SarifFinding> = {}): SarifFinding {
  return {
    ruleId: "sql-injection",
    severity: "error",
    roleHint: "security",
    category: "injection",
    path: "src/db.ts",
    line: 17,
    message: "Possible SQL injection",
    toolName: "Trivy",
    ...overrides,
  } as SarifFinding
}

function astFinding(overrides: Partial<AstFinding> = {}): AstFinding {
  return {
    ruleId: "eval-call",
    severity: "error",
    roleHint: "security",
    path: "src/exec.ts",
    line: 9,
    column: 2,
    message: "Use of eval()",
    evidence: "eval(userInput)",
    astFindingId: "ast/eval-call/abc1234/9",
    ...overrides,
  }
}

const EMPTY = {
  secretHits: [],
  depVulnFindings: [],
  sarifFindings: [],
  astSecurityFindings: [],
} as const

describe("buildSecurityFactManifest", () => {
  it("returns an empty manifest + empty render when there are no facts", async () => {
    const m = await buildSecurityFactManifest(EMPTY)
    expect(m.manifest.size).toBe(0)
    expect(m.render()).toBe("")
  })

  it("builds a secret evidenceId of shape secret:<ruleId>:<hash>:<line> with CWE-798", async () => {
    const m = await buildSecurityFactManifest({ ...EMPTY, secretHits: [secretHit()] })
    expect(m.manifest.size).toBe(1)
    const [id] = [...m.manifest.keys()]
    expect(id).toMatch(/^secret:generic-api-key:[0-9a-f]{12}:42$/)
    const fact = m.manifest.get(id)!
    expect(fact.tool).toBe("secret")
    expect(fact.path).toBe("src/config.ts")
    expect(fact.line).toBe(42)
    expect(fact.cwe).toBe("CWE-798")
  })

  it("builds a depvuln evidenceId (path-only, no line) of shape depvuln:<advisory>:<hash>", async () => {
    const m = await buildSecurityFactManifest({ ...EMPTY, depVulnFindings: [depVuln()] })
    const [id] = [...m.manifest.keys()]
    expect(id).toMatch(/^depvuln:GHSA-xxxx-yyyy-zzzz:[0-9a-f]{12}$/)
    const fact = m.manifest.get(id)!
    expect(fact.tool).toBe("depvuln")
    expect(fact.path).toBe("package.json")
    expect(fact.line).toBeNull()
  })

  it("builds a sarif evidenceId with line when present", async () => {
    const m = await buildSecurityFactManifest({ ...EMPTY, sarifFindings: [sarifFinding()] })
    const [id] = [...m.manifest.keys()]
    expect(id).toMatch(/^sarif:sql-injection:[0-9a-f]{12}:17$/)
    expect(m.manifest.get(id)!.line).toBe(17)
  })

  it("builds a sarif evidenceId WITHOUT a trailing line for path-only findings", async () => {
    const m = await buildSecurityFactManifest({
      ...EMPTY,
      sarifFindings: [sarifFinding({ line: undefined })],
    })
    const [id] = [...m.manifest.keys()]
    expect(id).toMatch(/^sarif:sql-injection:[0-9a-f]{12}$/)
    expect(m.manifest.get(id)!.line).toBeNull()
  })

  it("builds an ast evidenceId reusing the stable astFindingId", async () => {
    const m = await buildSecurityFactManifest({ ...EMPTY, astSecurityFindings: [astFinding()] })
    const [id] = [...m.manifest.keys()]
    expect(id).toBe("ast:eval-call:ast/eval-call/abc1234/9")
    expect(m.manifest.get(id)!.line).toBe(9)
  })

  it("#64: stamps CWE-79 on the dynamic-HTML-sink AST fact (routes a confirmed XSS to the xss bucket)", async () => {
    const m = await buildSecurityFactManifest({
      ...EMPTY,
      astSecurityFindings: [
        astFinding({
          ruleId: DYNAMIC_HTML_SINK_RULE_ID,
          astFindingId: "ast/no-dangerous-html-dynamic/deadbeef/12",
          path: "src/ui/Note.tsx",
          line: 12,
          message: "Dynamic value rendered as raw HTML",
        }),
      ],
    })
    const [id] = [...m.manifest.keys()]
    expect(m.manifest.get(id)!.cwe).toBe("CWE-79")
    expect(m.render()).toContain("[proposed CWE-79]")
  })

  it("#64: does NOT stamp a CWE on a non-XSS AST fact (e.g. eval-call) — scoped to the sink rule", async () => {
    const m = await buildSecurityFactManifest({ ...EMPTY, astSecurityFindings: [astFinding()] })
    const [id] = [...m.manifest.keys()]
    expect(m.manifest.get(id)!.cwe).toBeUndefined()
  })

  it("produces a DETERMINISTIC id for the same fact across two builds (hash stability)", async () => {
    const a = await buildSecurityFactManifest({ ...EMPTY, secretHits: [secretHit()] })
    const b = await buildSecurityFactManifest({ ...EMPTY, secretHits: [secretHit()] })
    expect([...a.manifest.keys()]).toEqual([...b.manifest.keys()])
  })

  it("produces DIFFERENT hashes when a stable field changes (id can't be guessed without the fact)", async () => {
    const a = await buildSecurityFactManifest({
      ...EMPTY,
      secretHits: [secretHit({ redactedPreview: "aaaa…bbbb" })],
    })
    const b = await buildSecurityFactManifest({
      ...EMPTY,
      secretHits: [secretHit({ redactedPreview: "cccc…dddd" })],
    })
    expect([...a.manifest.keys()][0]).not.toBe([...b.manifest.keys()][0])
  })

  it("includes every fact tool in the render block", async () => {
    const m: SecurityFactManifest = await buildSecurityFactManifest({
      secretHits: [secretHit()],
      depVulnFindings: [depVuln()],
      sarifFindings: [sarifFinding()],
      astSecurityFindings: [astFinding()],
    })
    expect(m.manifest.size).toBe(4)
    const block = m.render()
    expect(block).toContain("[SECURITY EVIDENCE MANIFEST")
    expect(block).toContain("secret:generic-api-key:")
    expect(block).toContain("depvuln:GHSA-xxxx-yyyy-zzzz:")
    expect(block).toContain("sarif:sql-injection:")
    expect(block).toContain("ast:eval-call:ast/eval-call/abc1234/9")
    // The block tells the model how to cite + the NONE exemption.
    expect(block).toContain("evidenceId")
    expect(block).toContain("NONE")
  })

  it("never embeds the raw secret value in the id or render (only the redacted preview)", async () => {
    const m = await buildSecurityFactManifest({
      ...EMPTY,
      secretHits: [secretHit({ redactedPreview: "ab12…ef56" })],
    })
    const block = m.render()
    expect(block).toContain("ab12…ef56")
    // Sanity: the manifest summary uses the preview, not a full key.
    const fact = [...m.manifest.values()][0]!
    expect(fact.summary).toContain("ab12…ef56")
  })
})
