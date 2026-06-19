// SIG-471 (quiet-VERIFIED) — `overview-proof-update` handler + proof-count tests.
//
// Two layers:
//   1. `computeProofCounts` — the pure bucketing (verified/grounded/model;
//      missing tier → model; verified excludes grounded). No mocks.
//   2. `handleOverviewProofUpdate` — skip/retry decisions (manifest missing →
//      retry; fields not enriched → retry; happy path → patches the Proof line).
//      The GitHub client, lookupRunnerEvidence, the manifest read, and KV are
//      mocked the way the sibling suites do.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  computeProofCounts,
  handleOverviewProofUpdate,
  MAX_PROOF_UPDATE_ATTEMPTS,
} from "@/src/lib/overview-proof-update"
import type { ReviewManifestFinding } from "@/src/lib/review-manifest"
import type { Env } from "@/src/shared/types/env"

// ── module mocks ────────────────────────────────────────────────────────────
// The handler builds an installation client + reads the manifest + looks up the
// receipt. Mock each seam; the AST scan + sarif parse run for real on stubbed
// client returns (empty diff → no AST facts → join on the finding's own class).

vi.mock("@/src/shared/adapters/github/github-app", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github/github-app")>(
    "@/src/shared/adapters/github/github-app",
  )
  // Inline the stub (no module-level ref) — vi.mock factories are hoisted above
  // top-level consts, so referencing one here would hit its TDZ.
  return { ...actual, getInstallationToken: vi.fn(async () => "inst-token") }
})

const clientState = {
  mergeCommitSha: "merge-sha" as string | null,
  getCommitParents: ["base", "pr-head-sha"] as string[] | null,
  repoId: 424242 as number | undefined,
  overview: null as { id: number; body: string } | null,
  diff: "" as string,
  fileContents: new Map<string, string>(),
  updatedComment: null as { id: number; body: string } | null,
}
vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {
    async getPullRequest() {
      return {
        number: 1,
        title: "",
        body: null,
        user: null,
        head: { sha: "pr-head-sha", ref: "f" },
        base: { sha: "b", ref: "main" },
        merge_commit_sha: clientState.mergeCommitSha,
      }
    }
    async getCommit() {
      return clientState.getCommitParents === null
        ? null
        : { headSha: "merge-sha", treeSha: "tree", parents: clientState.getCommitParents }
    }
    async getRepository() {
      return clientState.repoId === undefined ? null : { default_branch: "main", id: clientState.repoId }
    }
    async getPullRequestDiff() {
      return clientState.diff
    }
    async getFileContent(_o: string, _r: string, path: string) {
      return clientState.fileContents.get(path) ?? null
    }
    async updateIssueComment(_o: string, _r: string, id: number, body: string) {
      clientState.updatedComment = { id, body }
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

// The verified-receipt lookup — keyed by `state` so a test can choose
// verified (with a SARIF body) vs evidence-pending (→ retry).
const lookupState = { result: { state: "runner-absent" } as { state: string; sarif?: string; reason?: string } }
vi.mock("@/src/lib/runner-evidence/lookup", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/runner-evidence/lookup")>(
    "@/src/lib/runner-evidence/lookup",
  )
  return { ...actual, lookupRunnerEvidence: vi.fn(async () => lookupState.result) }
})

// The prior review's manifest read.
const manifestState = {
  result: { kind: "missing" } as
    | { kind: "missing" }
    | { kind: "invalid"; reason: string }
    | { kind: "ok"; manifest: { headSha?: string; findings?: ReviewManifestFinding[] } },
}
vi.mock("@/src/lib/review-manifest", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/review-manifest")>("@/src/lib/review-manifest")
  return { ...actual, readReviewManifest: vi.fn(async () => manifestState.result) }
})

// Locate the overview comment by its marker.
vi.mock("@/src/lib/triage-pr-overview-scan", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/triage-pr-overview-scan")>(
    "@/src/lib/triage-pr-overview-scan",
  )
  return { ...actual, findExistingOverviewComment: vi.fn(async () => clientState.overview) }
})

const APP_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
}

function makeEnv(jobsSent: unknown[]): Env {
  return {
    ...APP_ENV,
    OPENCLAW_STATE: {
      async get() {
        return null
      },
      async put() {},
    },
    OPENCLAW_JOBS: {
      async send(m: unknown) {
        jobsSent.push(m)
      },
    },
  } as unknown as Env
}

const baseMessage = {
  type: "overview-proof-update" as const,
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "pr-head-sha",
  installationId: 99,
  repoId: 424242,
}

const STATUS_BLOCK = [
  "<!-- sigilix:pr-overview -->",
  "## Sigilix Overview",
  "",
  "<!-- sigilix:review-run-status:start -->",
  "",
  "**Phase:** Posted",
  "**Commit:** `abc1234`",
  "**Result:** Posted - 2 findings",
  "",
  "<!-- sigilix:review-run-status:end -->",
].join("\n")

beforeEach(() => {
  clientState.mergeCommitSha = "merge-sha"
  clientState.getCommitParents = ["base", "pr-head-sha"]
  clientState.repoId = 424242
  clientState.overview = null
  clientState.diff = ""
  clientState.fileContents = new Map()
  clientState.updatedComment = null
  lookupState.result = { state: "runner-absent" }
  manifestState.result = { kind: "missing" }
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── computeProofCounts ──────────────────────────────────────────────────────

describe("computeProofCounts", () => {
  const f = (key: string, trustTier?: string): Pick<ReviewManifestFinding, "key" | "trustTier"> =>
    trustTier === undefined ? { key } : { key, trustTier }

  it("buckets grounded tiers as grounded and body-only/missing as model", () => {
    const findings = [
      f("a", "grounded-model"),
      f("b", "deterministic-grounded"),
      f("c", "worker-token-confirmed"),
      f("d", "runner-confirmed"),
      f("e", "body-only-ungrounded"),
      f("f"), // missing tier → model
      f("g", "totally-unknown"), // unknown → model
    ]
    expect(computeProofCounts(findings, new Set())).toEqual({ verified: 0, grounded: 4, model: 3 })
  })

  it("counts a confirmed finding ONLY as verified (never also grounded)", () => {
    const findings = [f("a", "grounded-model"), f("b", "deterministic-grounded"), f("c", "body-only-ungrounded")]
    // `a` and `b` are grounded tiers, but `a` is receipt-verified → verified only.
    expect(computeProofCounts(findings, new Set(["a"]))).toEqual({ verified: 1, grounded: 1, model: 1 })
  })

  it("the three buckets always sum to the finding count", () => {
    const findings = [f("a", "grounded-model"), f("b"), f("c", "runner-confirmed"), f("d", "body-only-ungrounded")]
    const proof = computeProofCounts(findings, new Set(["c"]))
    expect(proof.verified + proof.grounded + proof.model).toBe(findings.length)
  })
})

// ── handleOverviewProofUpdate skip / retry / happy-path ──────────────────────

describe("handleOverviewProofUpdate", () => {
  it("retries when the manifest is missing", async () => {
    manifestState.result = { kind: "missing" }
    const sent: unknown[] = []
    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: "overview-proof-update", attempt: 1 })
  })

  it("retries when the manifest findings lack the enriched fields", async () => {
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "pr-head-sha",
        findings: [{ key: "a", path: "x.ts", headline: "h", score: 5, consensus: 1 }],
      },
    }
    const sent: unknown[] = []
    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: "overview-proof-update", attempt: 1 })
  })

  it("retries when no verified receipt is available yet (evidence-pending)", async () => {
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "pr-head-sha",
        findings: [{ key: "a", path: "x.ts", headline: "h", score: 5, consensus: 1, line: 10, category: "security" }],
      },
    }
    lookupState.result = { state: "evidence-pending", reason: "head-sha-mismatch" }
    const sent: unknown[] = []
    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ attempt: 1 })
  })

  it("stops retrying at the attempt cap (no infinite loop)", async () => {
    manifestState.result = { kind: "missing" }
    const sent: unknown[] = []
    await handleOverviewProofUpdate({ ...baseMessage, attempt: MAX_PROOF_UPDATE_ATTEMPTS - 1 }, makeEnv(sent))
    expect(sent).toHaveLength(0)
  })

  it("happy path: patches the overview Proof line in place (no second review)", async () => {
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "pr-head-sha",
        findings: [
          // grounded (cites evidence, not verified by the receipt)
          {
            key: "a",
            path: "x.ts",
            headline: "h",
            score: 5,
            consensus: 1,
            line: 10,
            category: "security",
            trustTier: "grounded-model",
          },
          // model-only
          {
            key: "b",
            path: "y.ts",
            headline: "h2",
            score: 3,
            consensus: 1,
            line: 20,
            category: "logic",
            trustTier: "body-only-ungrounded",
          },
        ],
      },
    }
    // A verified receipt with an empty SARIF → no confirmations (verified=0).
    lookupState.result = { state: "verified", sarif: JSON.stringify({ version: "2.1.0", runs: [] }) }
    clientState.overview = { id: 555, body: STATUS_BLOCK }
    const sent: unknown[] = []

    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))

    expect(sent).toHaveLength(0) // no retry
    expect(clientState.updatedComment).not.toBeNull()
    expect(clientState.updatedComment!.id).toBe(555)
    // Proof line patched in place; the status details survive (targeted patch).
    expect(clientState.updatedComment!.body).toContain("**Proof:** 1 grounded · 1 model-only")
    expect(clientState.updatedComment!.body).toContain("**Phase:** Posted")
    expect(clientState.updatedComment!.body).toContain("**Result:** Posted - 2 findings")
  })

  it("retries when the overview comment is not present yet", async () => {
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "pr-head-sha",
        findings: [
          {
            key: "a",
            path: "x.ts",
            headline: "h",
            score: 5,
            consensus: 1,
            line: 10,
            category: "security",
            trustTier: "grounded-model",
          },
        ],
      },
    }
    lookupState.result = { state: "verified", sarif: JSON.stringify({ version: "2.1.0", runs: [] }) }
    clientState.overview = null // overview not written yet (review still in flight)
    const sent: unknown[] = []

    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ attempt: 1 })
    expect(clientState.updatedComment).toBeNull()
  })

  it("CREDIBILITY: a receipt that confirms the finding renders runner-verified (positive seam; fails on revert)", async () => {
    // The finding's class (CWE-94 → code-injection) + a runner receipt flagging the
    // SAME class at the SAME path/line → verifyFindingAgainstReceipt confirms → verified=1.
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "pr-head-sha",
        findings: [
          {
            key: "a",
            path: "x.ts",
            headline: "eval of untrusted input",
            score: 5,
            consensus: 1,
            line: 10,
            category: "security",
            cweId: "CWE-94",
            trustTier: "grounded-model",
          },
        ],
      },
    }
    lookupState.result = {
      state: "verified",
      sarif: JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "semgrep" } },
            results: [
              {
                ruleId: "detect-eval",
                message: { text: "untrusted input flows into eval" },
                properties: { sigilixRuleClass: "code-injection" },
                locations: [{ physicalLocation: { artifactLocation: { uri: "x.ts" }, region: { startLine: 10 } } }],
              },
            ],
          },
        ],
      }),
    }
    clientState.overview = { id: 777, body: STATUS_BLOCK }
    const sent: unknown[] = []

    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))

    expect(sent).toHaveLength(0)
    expect(clientState.updatedComment!.body).toContain("**Proof:** 1 runner-verified")
    expect(clientState.updatedComment!.body).not.toContain("grounded")
    // status details preserved (targeted patch)
    expect(clientState.updatedComment!.body).toContain("**Phase:** Posted")
  })

  it("CREDIBILITY: a line-less (file-scope) finding is NOT receipt-join eligible (no line:0 over-confirm)", async () => {
    // Same confirming receipt, but the finding has NO manifest line (file/PR-scope).
    // It must NOT become verified (line:0 would wrongly window-confirm); it stays grounded.
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "pr-head-sha",
        findings: [
          {
            key: "a",
            path: "x.ts",
            headline: "module-level injection risk",
            score: 5,
            consensus: 1,
            // no `line` → file/PR-scope
            category: "security",
            cweId: "CWE-94",
            trustTier: "grounded-model",
          },
        ],
      },
    }
    lookupState.result = {
      state: "verified",
      sarif: JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "semgrep" } },
            results: [
              {
                ruleId: "detect-eval",
                message: { text: "untrusted input flows into eval" },
                properties: { sigilixRuleClass: "code-injection" },
                locations: [{ physicalLocation: { artifactLocation: { uri: "x.ts" }, region: { startLine: 3 } } }],
              },
            ],
          },
        ],
      }),
    }
    clientState.overview = { id: 778, body: STATUS_BLOCK }
    const sent: unknown[] = []

    await handleOverviewProofUpdate(baseMessage, makeEnv(sent))

    expect(clientState.updatedComment!.body).toContain("**Proof:** 1 grounded")
    expect(clientState.updatedComment!.body).not.toContain("runner-verified")
  })

  it("HEAD-BIND: a stale receipt (manifest head advanced past the receipt head) SKIPS — no patch, no retry", async () => {
    manifestState.result = {
      kind: "ok",
      manifest: {
        headSha: "newer-head-sha", // PR advanced past the receipt's head
        findings: [
          {
            key: "a",
            path: "x.ts",
            headline: "h",
            score: 5,
            consensus: 1,
            line: 10,
            category: "security",
            cweId: "CWE-94",
            trustTier: "grounded-model",
          },
        ],
      },
    }
    lookupState.result = { state: "verified", sarif: JSON.stringify({ version: "2.1.0", runs: [] }) }
    clientState.overview = { id: 779, body: STATUS_BLOCK }
    const sent: unknown[] = []

    await handleOverviewProofUpdate(baseMessage, makeEnv(sent)) // message.headSha = "pr-head-sha"

    expect(clientState.updatedComment).toBeNull() // never patched a newer review's overview
    expect(sent).toHaveLength(0) // stale → skip, NOT retry
  })
})
