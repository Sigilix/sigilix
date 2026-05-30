// SIG-184 PR 3 — review-time receipt lookup + the believability-boundary
// validation. Mocks the DO query + the KV body; asserts the three states +
// fail-closed/demote paths.

import { describe, expect, it } from "vitest"
import { lookupRunnerEvidence, validateRunnerSarifConsistency, readRunnerEvidenceMode } from "../src/lib/runner-evidence/lookup"
import type { Env } from "../src/index"

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("")
}

const SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [{ versionControlProvenance: [{ revisionId: "headcafe", repositoryUri: "https://github.com/Sigilix/sigilix" }] }],
})

function makeEnv(opts: { row?: unknown; rowThrows?: boolean; body?: unknown; bodyThrows?: boolean }): Env {
  const ns = {
    idFromName: (id: string) => ({ id }),
    get: () => ({
      async queryReceiptByHead() {
        if (opts.rowThrows) throw new Error("do down")
        return opts.row ?? null
      },
    }),
  }
  const kv = {
    async get() {
      if (opts.bodyThrows) throw new Error("kv down")
      return opts.body ?? null
    },
  }
  return { RUNNER_RECEIPT_DO: ns, OPENCLAW_STATE: kv } as unknown as Env
}

const baseRow = (scrubbedSha256: string) => ({
  sha: "mergedead",
  headSha: "headcafe",
  runId: "1",
  runAttempt: "1",
  sarifSha256: "rawhash",
  scrubbedSha256,
  repository: "Sigilix/sigilix",
  jobWorkflowRef: "sigilix/runner/.github/workflows/scan.yml@v1",
  runnerEnvironment: "github-hosted",
  ingestedAt: 1,
})

describe("lookupRunnerEvidence", () => {
  it("verified: DO row + matching body hash + consistent SARIF → renders BOUND values", async () => {
    const env = makeEnv({ row: baseRow(await sha256(SARIF)), body: { sarif: SARIF } })
    const r = await lookupRunnerEvidence(env, "424242", "headcafe")
    expect(r).toMatchObject({ state: "verified", repository: "Sigilix/sigilix", sha: "mergedead", headSha: "headcafe", runId: "1" })
    if (r.state === "verified") expect(r.sarif).toBe(SARIF)
  })

  it("runner-absent: no row, and (fail-closed) empty repositoryId", async () => {
    expect((await lookupRunnerEvidence(makeEnv({ row: null }), "424242", "headcafe")).state).toBe("runner-absent")
    expect((await lookupRunnerEvidence(makeEnv({ row: null }), "", "headcafe")).state).toBe("runner-absent")
  })

  it("evidence-pending (not absent) on a transient DO error", async () => {
    expect((await lookupRunnerEvidence(makeEnv({ rowThrows: true }), "424242", "headcafe")).state).toBe("evidence-pending")
  })

  it("evidence-pending when the DO row exists but the KV body is missing", async () => {
    const r = await lookupRunnerEvidence(makeEnv({ row: baseRow("anyhash"), body: null }), "424242", "headcafe")
    expect(r).toMatchObject({ state: "evidence-pending", reason: "body-missing" })
  })

  it("evidence-pending on an integrity mismatch (KV body tampered/corrupt)", async () => {
    const r = await lookupRunnerEvidence(makeEnv({ row: baseRow("wronghash"), body: { sarif: SARIF } }), "424242", "headcafe")
    expect(r).toMatchObject({ state: "evidence-pending", reason: "integrity-mismatch" })
  })

  it("evidence-pending (DEMOTED) when the SARIF's revisionId != the bound head sha", async () => {
    const badSarif = JSON.stringify({ version: "2.1.0", runs: [{ versionControlProvenance: [{ revisionId: "victimsha" }] }] })
    const r = await lookupRunnerEvidence(makeEnv({ row: baseRow(await sha256(badSarif)), body: { sarif: badSarif } }), "424242", "headcafe")
    expect(r.state).toBe("evidence-pending")
    if (r.state === "evidence-pending") expect(r.reason).toContain("sarif-inconsistent")
  })
})

describe("validateRunnerSarifConsistency", () => {
  const bound = { headSha: "headcafe", repository: "Sigilix/sigilix" }
  it("ok when VCS provenance matches (case-insensitive owner/repo + sha)", () => {
    expect(
      validateRunnerSarifConsistency(
        JSON.stringify({ runs: [{ versionControlProvenance: [{ revisionId: "HEADCAFE", repositoryUri: "https://github.com/sigilix/SIGILIX.git" }] }] }),
        bound,
      ),
    ).toEqual({ ok: true })
  })
  it("ok when VCS provenance is ABSENT (the badge attests the receipt, not SARIF self-provenance)", () => {
    expect(validateRunnerSarifConsistency(JSON.stringify({ runs: [{}] }), bound)).toEqual({ ok: true })
  })
  it("rejects a revisionId mismatch", () => {
    expect(validateRunnerSarifConsistency(JSON.stringify({ runs: [{ versionControlProvenance: [{ revisionId: "other" }] }] }), bound)).toEqual({ ok: false, reason: "revision-mismatch" })
  })
  it("rejects a FOREIGN-host repositoryUri (e.g. gitlab) — cannot match a bound GitHub repo (CR)", () => {
    expect(validateRunnerSarifConsistency(JSON.stringify({ runs: [{ versionControlProvenance: [{ repositoryUri: "https://gitlab.com/Sigilix/sigilix" }] }] }), bound)).toEqual({ ok: false, reason: "repository-mismatch" })
  })
  it("rejects a repositoryUri mismatch (cross-repo SARIF)", () => {
    expect(validateRunnerSarifConsistency(JSON.stringify({ runs: [{ versionControlProvenance: [{ repositoryUri: "https://github.com/attacker/repo" }] }] }), bound)).toEqual({ ok: false, reason: "repository-mismatch" })
  })
  it("demotes a malformed SARIF body", () => {
    expect(validateRunnerSarifConsistency("{not json", bound)).toEqual({ ok: false, reason: "sarif-parse" })
  })
})

describe("readRunnerEvidenceMode", () => {
  const mk = (v?: string) => ({ OPENCLAW_RUNNER_EVIDENCE_MODE: v } as unknown as Env)
  it("defaults to off (unset / unknown / blank)", () => {
    expect(readRunnerEvidenceMode(mk(undefined))).toBe("off")
    expect(readRunnerEvidenceMode(mk("nonsense"))).toBe("off")
    expect(readRunnerEvidenceMode(mk("  "))).toBe("off")
  })
  it("parses shadow / post (case-insensitive, trimmed)", () => {
    expect(readRunnerEvidenceMode(mk(" SHADOW "))).toBe("shadow")
    expect(readRunnerEvidenceMode(mk("post"))).toBe("post")
  })
})
