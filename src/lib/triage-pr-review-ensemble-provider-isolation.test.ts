import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockChat,
  mockRetrieveChunks,
  mockResolveCrossRepoNamespaces,
  mockRetrieveMultiCorpus,
  mockLoadScopedRules,
  mockGraphContextFor,
  mockBlastRadiusByNamesFor,
  mockContextExpansionForChangedSymbols,
  mockLoadLearnings,
  mockLoadPrecisionProfile,
  mockRunReviewMemoryLookup,
  mockRunSarifEvidence,
  mockLookupRunnerEvidence,
  mockRecordRunnerEvidenceMetric,
  mockResolveDashboardConfigLayers,
  mockCollectPrReviewAppEvidence,
  mockReadRepositoryContextForReview,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockRetrieveChunks: vi.fn(),
  mockResolveCrossRepoNamespaces: vi.fn(),
  mockRetrieveMultiCorpus: vi.fn(),
  mockLoadScopedRules: vi.fn(),
  mockGraphContextFor: vi.fn(),
  mockBlastRadiusByNamesFor: vi.fn(),
  mockContextExpansionForChangedSymbols: vi.fn(),
  mockLoadLearnings: vi.fn(),
  mockLoadPrecisionProfile: vi.fn(),
  mockRunReviewMemoryLookup: vi.fn(),
  mockRunSarifEvidence: vi.fn(),
  mockLookupRunnerEvidence: vi.fn(),
  mockRecordRunnerEvidenceMetric: vi.fn(),
  mockResolveDashboardConfigLayers: vi.fn(),
  mockCollectPrReviewAppEvidence: vi.fn(),
  mockReadRepositoryContextForReview: vi.fn(),
}))

vi.mock("@/src/features/repository-context", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/repository-context")>(
    "@/src/features/repository-context",
  )
  return {
    ...actual,
    readRepositoryContextForReview: (...args: Parameters<typeof actual.readRepositoryContextForReview>) => {
      mockReadRepositoryContextForReview(...args)
      return actual.readRepositoryContextForReview(...args)
    },
  }
})

vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (...args: unknown[]) => mockChat(...args) }
})

vi.mock("@/src/lib/retrieval", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/retrieval")>("@/src/lib/retrieval")
  return { ...actual, retrieveChunks: (...args: unknown[]) => mockRetrieveChunks(...args) }
})

vi.mock("@/src/lib/cross-repo-context", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/cross-repo-context")>("@/src/lib/cross-repo-context")
  return {
    ...actual,
    resolveReviewCrossRepoNamespaces: (...args: unknown[]) => mockResolveCrossRepoNamespaces(...args),
  }
})

vi.mock("@/src/lib/multi-corpus", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/multi-corpus")>("@/src/lib/multi-corpus")
  return { ...actual, retrieveMultiCorpus: (...args: unknown[]) => mockRetrieveMultiCorpus(...args) }
})

vi.mock("@/src/lib/scoped-rules-kv", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/scoped-rules-kv")>("@/src/lib/scoped-rules-kv")
  return { ...actual, loadCompiledScopedRulesManifest: (...args: unknown[]) => mockLoadScopedRules(...args) }
})

vi.mock("@/src/lib/repo-graph-client", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/repo-graph-client")>("@/src/lib/repo-graph-client")
  return {
    ...actual,
    graphContextFor: (...args: unknown[]) => mockGraphContextFor(...args),
    blastRadiusByNamesFor: (...args: unknown[]) => mockBlastRadiusByNamesFor(...args),
    contextExpansionForChangedSymbolsFor: (...args: unknown[]) => mockContextExpansionForChangedSymbols(...args),
  }
})

vi.mock("@/src/features/learnings", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/learnings")>("@/src/features/learnings")
  return { ...actual, loadEffectiveLearnings: (...args: unknown[]) => mockLoadLearnings(...args) }
})

vi.mock("@/src/features/precision-profile", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/precision-profile")>(
    "@/src/features/precision-profile",
  )
  return { ...actual, loadPrecisionProfile: (...args: unknown[]) => mockLoadPrecisionProfile(...args) }
})

vi.mock("@/src/lib/review-memory/lookup", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/review-memory/lookup")>(
    "@/src/lib/review-memory/lookup",
  )
  return { ...actual, runReviewMemoryLookup: (...args: unknown[]) => mockRunReviewMemoryLookup(...args) }
})

vi.mock("@/src/features/sarif-evidence", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/sarif-evidence")>("@/src/features/sarif-evidence")
  return { ...actual, runSarifEvidence: (...args: unknown[]) => mockRunSarifEvidence(...args) }
})

vi.mock("@/src/lib/runner-evidence/lookup", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/runner-evidence/lookup")>(
    "@/src/lib/runner-evidence/lookup",
  )
  return { ...actual, lookupRunnerEvidence: (...args: unknown[]) => mockLookupRunnerEvidence(...args) }
})

vi.mock("@/src/lib/runner-evidence-metrics-client", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/runner-evidence-metrics-client")>(
    "@/src/lib/runner-evidence-metrics-client",
  )
  return { ...actual, recordRunnerEvidenceMetric: (...args: unknown[]) => mockRecordRunnerEvidenceMetric(...args) }
})

vi.mock("@/src/lib/review-config-store", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/review-config-store")>("@/src/lib/review-config-store")
  return { ...actual, resolveDashboardConfigLayers: (...args: unknown[]) => mockResolveDashboardConfigLayers(...args) }
})

vi.mock("@/src/features/pr-review-app-evidence", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/pr-review-app-evidence")>(
    "@/src/features/pr-review-app-evidence",
  )
  return { ...actual, collectPrReviewAppEvidence: (...args: unknown[]) => mockCollectPrReviewAppEvidence(...args) }
})

import { handlePrReviewEnsemble } from "@/src/lib/triage-pr-review-ensemble"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import {
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  replaceRepositoryContext,
} from "@/src/features/repository-context"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const HEAD_SHA = "deadbeef1234567890abcdef1234567890abcdef"
const BASE_SHA = "basesha000000000000000000000000000000000"
const MERGE_SHA = "mergeabc1234567890abcdef1234567890abcdef"
const GITHUB_SENTINEL = "GITHUB_ACME_API_CONTEXT_MUST_NOT_REACH_GITLAB"
const GITLAB_REPOSITORY_CONTEXT_IDENTITY = {
  provider: "gitlab" as const,
  scopeId: "user-a",
  repositoryExternalId: `gl:v1:${"a".repeat(43)}`,
  authorityClaimToken: "b".repeat(43),
}
const RUNNER_SARIF = JSON.stringify({ version: "2.1.0", runs: [] })
const REPOSITORY_CONTEXT_MIGRATION = readFileSync(
  new URL("../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const REPOSITORY_AUTHORITY_MIGRATION = readFileSync(
  new URL("../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
  "utf8",
)
const DIFF = `diff --git a/src/api.ts b/src/api.ts
index abc1234..def5678 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,4 @@
 export function parseApi(value: string) {
+  if (!value) throw new Error("value is required")
   return value.trim()
 }
`

function makeEnv(): Env {
  const state = new Map<string, string>()
  return {
    OPENCLAW_STATE: {
      get: async (key: string) => state.get(key) ?? null,
      put: async (key: string, value: string) => void state.set(key, value),
      delete: async (key: string) => void state.delete(key),
    },
    OLLAMA_API_KEY: "test-key",
    OPENROUTER_API_KEY: "test-key",
    OLLAMA_CHAT_ENABLE: "on",
    OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "4",
    OPENCLAW_MULTICORPUS_RETRIEVAL: "on",
    OPENCLAW_GRAPH_RETRIEVAL: "post",
    OPENCLAW_GRAPH_EXPANSION: "post",
    OPENCLAW_LEARNINGS_MODE: "on",
    OPENCLAW_PRECISION_PROFILE_MODE: "shadow",
    OPENCLAW_REVIEW_MEMORY: "on",
    OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "post",
    OPENCLAW_RUNNER_EVIDENCE_MODE: "post",
    OPENCLAW_RECEIPTJOIN_MODE: "enforce",
  } as unknown as Env
}

function chatResult(payload: unknown) {
  return {
    message: { role: "assistant" as const, content: JSON.stringify(payload) },
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

function allPromptText(): string {
  return mockChat.mock.calls
    .flatMap((call) => {
      const messages = (call[0] as { messages?: Array<{ content?: unknown }> } | undefined)?.messages ?? []
      return messages.map((message) => String(message.content ?? ""))
    })
    .join("\n")
}

function makeGitLabClient(mergeCommitSha?: string) {
  const submitReview = vi.fn(async () => ({ id: 77, state: "COMMENTED" }))
  const client = {
    getPullRequest: vi.fn(async () => ({
      head: { sha: HEAD_SHA, ref: "gitlab-feature" },
      base: { sha: BASE_SHA, ref: "main" },
      merged_at: null,
      labels: [],
      title: "Validate API input",
      body: "GitLab merge request body",
      user: { login: "gitlab-user" },
      ...(mergeCommitSha ? { merge_commit_sha: mergeCommitSha } : {}),
    })),
    getPullRequestDiff: vi.fn(async () => DIFF),
    listOpenPullRequests: vi.fn(async () => []),
    getFileContent: vi.fn(async (_owner: string, _repo: string, path: string) => {
      if (path === "sigilix.json") return JSON.stringify({ reviewMemory: { enabled: true } })
      return "export function parseApi(value: string) { return value.trim() }"
    }),
    submitReview,
    listPullRequestReviews: vi.fn(async () => [{ id: 77, state: "COMMENTED", commitId: HEAD_SHA }]),
    listPullRequestFiles: vi.fn(async () => [
      { filename: "src/api.ts", sha: "blob-sha", status: "modified", additions: 1, deletions: 0 },
    ]),
    createIssueComment: vi.fn(async () => ({ id: 1 })),
  }
  return { client: client as unknown as GitHubClient, submitReview }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  mockRetrieveChunks.mockResolvedValue([
    {
      path: "github-only.ts",
      lineStart: 1,
      lineEnd: 1,
      content: GITHUB_SENTINEL,
      score: 1,
    },
  ])
  mockResolveCrossRepoNamespaces.mockResolvedValue(["github/acme-api-sibling"])
  mockRetrieveMultiCorpus.mockResolvedValue({
    pr: [{ kind: "pr", ref: "#1", label: "approved", content: GITHUB_SENTINEL, score: 1 }],
    issue: [],
  })
  mockLoadScopedRules.mockResolvedValue({
    perDirectoryRules: [{ dirPath: "src", body: GITHUB_SENTINEL }],
    globRules: [],
  })
  mockGraphContextFor.mockResolvedValue({ nodes: [] })
  mockBlastRadiusByNamesFor.mockResolvedValue({ callerPaths: [], importDependents: [] })
  mockContextExpansionForChangedSymbols.mockResolvedValue({
    graphAvailable: true,
    headSha: HEAD_SHA,
    definitions: [],
    callers: [],
    importDependents: [],
  })
  mockLoadLearnings.mockResolvedValue([])
  mockLoadPrecisionProfile.mockResolvedValue(null)
  mockRunReviewMemoryLookup.mockResolvedValue({ skipped: true, reason: "no-paths-to-query", findings: [] })
  mockRunSarifEvidence.mockResolvedValue({ skipped: true, reason: "disabled-config" })
  mockLookupRunnerEvidence.mockResolvedValue({ state: "verified", payload: GITHUB_SENTINEL })
  mockRecordRunnerEvidenceMetric.mockResolvedValue(undefined)
  mockResolveDashboardConfigLayers.mockResolvedValue({
    org: { config: { guidance: GITHUB_SENTINEL } },
    repo: { config: { guidance: GITHUB_SENTINEL } },
  })
  mockCollectPrReviewAppEvidence.mockResolvedValue({ block: GITHUB_SENTINEL, citations: [] })
  mockChat.mockImplementation(async (arg: unknown) => {
    const text = ((arg as { messages?: Array<{ content?: unknown }> }).messages ?? [])
      .map((message) => String(message.content ?? ""))
      .join("\n")
    if (
      text.includes("**LOGIC specialist**") ||
      text.includes("**SECURITY specialist**") ||
      text.includes("**TESTS specialist**") ||
      text.includes("**PERFORMANCE specialist**")
    ) {
      return chatResult({ summary: "No issues found.", confidence: 5, confidenceReason: "fixture", findings: [] })
    }
    return chatResult({
      verdict: { summary: "No issues found.", confidence: 5, confidenceReason: "fixture", findings: [] },
      provenance: { findings: [], dropped: [] },
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GitLab review provider isolation", () => {
  it("injects exact active GitLab multi-repository context into specialists but never synth", async () => {
    const db = makeD1()
    await db.exec(REPOSITORY_CONTEXT_MIGRATION)
    await db.exec(REPOSITORY_AUTHORITY_MIGRATION)
    const current = await claimGitLabRepositoryAuthority(db, {
      scopeId: "user-a",
      instanceOrigin: "https://gitlab.com",
      sourceId: 101,
      fullName: "group/api",
    })
    const related = await claimGitLabRepositoryAuthority(db, {
      scopeId: "user-a",
      instanceOrigin: "https://gitlab.com",
      sourceId: 202,
      fullName: "group/worker",
    })
    if (current.status !== "claimed" || related.status !== "claimed") {
      throw new Error("expected GitLab authority claims")
    }
    for (const claim of [current, related]) {
      await expect(
        activateGitLabRepositoryAuthority(db, {
          scopeId: "user-a",
          externalId: claim.repository.externalId,
          claimToken: claim.claimToken,
        }),
      ).resolves.toMatchObject({ status: "activated" })
    }
    await expect(
      replaceRepositoryContext(db, {
        provider: "gitlab",
        scopeId: "user-a",
        expectedRevision: 0,
        repositories: [
          { ...current.repository, context: "GitLab API service", position: 0 },
          { ...related.repository, context: "GitLab background worker", position: 1 },
        ],
        relationships: [
          {
            fromExternalId: current.repository.externalId,
            toExternalId: related.repository.externalId,
            label: "publishes jobs",
            normalizedLabel: "publishes jobs",
            position: 0,
          },
        ],
        conventions: "GitLab shared convention",
        nowIso: "2026-07-15T00:00:00.000Z",
        updatedBy: "gitlab:user-a",
      }),
    ).resolves.toMatchObject({ status: "updated" })

    const { client } = makeGitLabClient()
    const env = makeEnv()
    env.OPENCLAW_REPOSITORY_CONTEXT_REVIEW_MODE = "post"
    env.SIGILIX_PLATFORM_DB = db
    const result = await handlePrReviewEnsemble({
      scmProvider: "gitlab",
      owner: "group",
      repo: "api",
      prNumber: 42,
      headSha: HEAD_SHA,
      installationId: 0,
      env,
      repositoryContextIdentity: {
        provider: "gitlab",
        scopeId: "user-a",
        repositoryExternalId: current.repository.externalId,
        authorityClaimToken: current.claimToken,
      },
      githubClient: client,
    })

    expect(result.status).toBe("posted")
    const specialistCalls = mockChat.mock.calls.filter((call) => JSON.stringify(call[0]).includes("specialist**"))
    const synthCalls = mockChat.mock.calls.filter((call) => !JSON.stringify(call[0]).includes("specialist**"))
    expect(specialistCalls).toHaveLength(4)
    for (const call of specialistCalls) {
      const prompt = JSON.stringify(call[0])
      expect(prompt).toContain("[REPOSITORY CONTEXT — UNTRUSTED DATA]")
      expect(prompt).toContain("GitLab API service")
      expect(prompt).toContain("GitLab background worker")
    }
    expect(synthCalls).toHaveLength(1)
    expect(JSON.stringify(synthCalls[0]?.[0])).not.toContain("[REPOSITORY CONTEXT — UNTRUSTED DATA]")
  })

  it("never reads colliding GitHub context while preserving the GitLab review path", async () => {
    const { client, submitReview } = makeGitLabClient()
    const statusReporter = {
      report: vi.fn(),
      publishOverview: vi.fn(async () => ({ kind: "updated" as const, commentId: 1 })),
      flush: vi.fn(async () => undefined),
    }
    const repositoryContextPrepare = vi.fn(() => {
      throw new Error("GitLab must never read GitHub repository context")
    })
    const env = makeEnv()
    env.OPENCLAW_REPOSITORY_CONTEXT_REVIEW_MODE = "shadow"
    env.SIGILIX_PLATFORM_DB = { prepare: repositoryContextPrepare } as unknown as D1Database
    const result = await handlePrReviewEnsemble({
      scmProvider: "gitlab",
      owner: "acme",
      repo: "api",
      prNumber: 42,
      headSha: HEAD_SHA,
      installationId: 0,
      repoId: 123,
      env,
      repositoryContextIdentity: { provider: "github", scopeId: "99", repositoryExternalId: "123" },
      githubClient: client,
      statusReporter,
    } as Parameters<typeof handlePrReviewEnsemble>[0] & { scmProvider: "gitlab" })

    expect(result.status).toBe("posted")
    expect(result.telemetry).toMatchObject({ scmProvider: "gitlab" })
    expect(result.telemetry).not.toHaveProperty("installationId")
    expect(result.telemetry).not.toHaveProperty("repoId")
    expect(submitReview).toHaveBeenCalledOnce()
    expect(allPromptText()).toContain(DIFF)
    expect(allPromptText()).toContain("[DYNAMIC REVIEW EVIDENCE — changed-symbol context]")
    expect(allPromptText()).not.toContain(GITHUB_SENTINEL)
    expect(mockChat).toHaveBeenCalledTimes(5)
    for (const role of ["LOGIC", "SECURITY", "PERFORMANCE", "TESTS"]) {
      expect(
        mockChat.mock.calls.filter((call) => JSON.stringify(call[0]).includes(`**${role} specialist**`)),
      ).toHaveLength(1)
    }
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
    expect(mockResolveCrossRepoNamespaces).not.toHaveBeenCalled()
    expect(mockRetrieveMultiCorpus).not.toHaveBeenCalled()
    expect(mockLoadScopedRules).not.toHaveBeenCalled()
    expect(mockGraphContextFor).not.toHaveBeenCalled()
    expect(mockBlastRadiusByNamesFor).not.toHaveBeenCalled()
    expect(mockContextExpansionForChangedSymbols).not.toHaveBeenCalled()
    expect(mockLoadLearnings).not.toHaveBeenCalled()
    expect(mockLoadPrecisionProfile).not.toHaveBeenCalled()
    expect(mockRunReviewMemoryLookup).not.toHaveBeenCalled()
    expect(mockLookupRunnerEvidence).not.toHaveBeenCalled()
    expect(mockRecordRunnerEvidenceMetric).not.toHaveBeenCalled()
    expect(mockResolveDashboardConfigLayers).not.toHaveBeenCalled()
    expect(mockCollectPrReviewAppEvidence).not.toHaveBeenCalled()
    expect(mockReadRepositoryContextForReview).toHaveBeenCalledWith({
      mode: "shadow",
      db: env.SIGILIX_PLATFORM_DB,
    })
    expect(Object.hasOwn(mockReadRepositoryContextForReview.mock.calls.at(-1)?.[0] ?? {}, "identity")).toBe(false)
    expect(repositoryContextPrepare).not.toHaveBeenCalled()
    expect(statusReporter.report).not.toHaveBeenCalled()
    expect(statusReporter.flush).not.toHaveBeenCalled()
    expect(mockRunSarifEvidence).toHaveBeenCalled()
    expect(client.getFileContent).toHaveBeenCalledWith("acme", "api", "sigilix.json", HEAD_SHA)
    expect(client.getFileContent).toHaveBeenCalledWith("acme", "api", "src/api.ts", HEAD_SHA)
  })

  it("never reads GitLab context when a GitHub review receives a GitLab identity", async () => {
    const { client } = makeGitLabClient()
    const repositoryContextPrepare = vi.fn(() => {
      throw new Error("GitHub must never read GitLab repository context")
    })
    const env = makeEnv()
    env.OPENCLAW_REPOSITORY_CONTEXT_REVIEW_MODE = "shadow"
    env.SIGILIX_PLATFORM_DB = { prepare: repositoryContextPrepare } as unknown as D1Database
    env.OPENCLAW_RUNNER_EVIDENCE_MODE = "off"
    env.OPENCLAW_RECEIPTJOIN_MODE = "off"

    const result = await handlePrReviewEnsemble({
      scmProvider: "github",
      owner: "acme",
      repo: "api",
      prNumber: 42,
      headSha: HEAD_SHA,
      installationId: 99,
      repoId: 123,
      env,
      repositoryContextIdentity: GITLAB_REPOSITORY_CONTEXT_IDENTITY,
      githubClient: client,
      dryRun: true,
    })

    expect(result.status).toBe("skipped")
    expect(mockReadRepositoryContextForReview).toHaveBeenCalledWith({
      mode: "shadow",
      db: env.SIGILIX_PLATFORM_DB,
    })
    expect(Object.hasOwn(mockReadRepositoryContextForReview.mock.calls.at(-1)?.[0] ?? {}, "identity")).toBe(false)
    expect(repositoryContextPrepare).not.toHaveBeenCalled()
  })

  it("keeps the GitHub retrieval path enabled as a positive control", async () => {
    const { client } = makeGitLabClient()
    const env = makeEnv()
    env.OPENCLAW_RUNNER_EVIDENCE_MODE = "off"
    env.OPENCLAW_RECEIPTJOIN_MODE = "off"

    const result = await handlePrReviewEnsemble({
      scmProvider: "github",
      owner: "acme",
      repo: "api",
      prNumber: 42,
      headSha: HEAD_SHA,
      installationId: 99,
      repoId: 123,
      env,
      githubClient: client,
      dryRun: true,
    })

    expect(result.status).toBe("skipped")
    expect(result.telemetry).toMatchObject({ scmProvider: "github", installationId: 99, repoId: 123 })
    expect(mockRetrieveChunks).toHaveBeenCalled()
    expect(mockResolveCrossRepoNamespaces).toHaveBeenCalledWith(env, 99, "acme", "api")
    expect(mockRetrieveMultiCorpus).toHaveBeenCalled()
    expect(mockLoadScopedRules).toHaveBeenCalled()
    expect(mockGraphContextFor).toHaveBeenCalled()
    expect(mockBlastRadiusByNamesFor).toHaveBeenCalled()
    expect(mockContextExpansionForChangedSymbols).toHaveBeenCalled()
    expect(mockLoadLearnings).toHaveBeenCalled()
    expect(mockLoadPrecisionProfile).toHaveBeenCalled()
    expect(mockRunReviewMemoryLookup).toHaveBeenCalled()
    expect(mockResolveDashboardConfigLayers).toHaveBeenCalled()
    expect(mockCollectPrReviewAppEvidence).toHaveBeenCalled()
    expect(allPromptText()).toContain(GITHUB_SENTINEL)
  })

  it("keeps GitHub runner receipt lookup, metrics, and SARIF override enabled", async () => {
    const { client } = makeGitLabClient(MERGE_SHA)
    const env = makeEnv()
    mockLookupRunnerEvidence.mockResolvedValueOnce({
      state: "verified",
      sarif: RUNNER_SARIF,
      repository: "acme/api",
      sha: MERGE_SHA,
      pullNumber: 42,
      runId: "17",
      runAttempt: "1",
    })

    const result = await handlePrReviewEnsemble({
      scmProvider: "github",
      owner: "acme",
      repo: "api",
      prNumber: 42,
      headSha: HEAD_SHA,
      installationId: 99,
      repoId: 123,
      env,
      githubClient: client,
      dryRun: true,
    })

    expect(result.status).toBe("skipped")
    expect(mockLookupRunnerEvidence).toHaveBeenCalledWith(
      env,
      "123",
      42,
      MERGE_SHA,
      expect.objectContaining({ headSha: HEAD_SHA, resolveMergeHead: expect.any(Function) }),
    )
    expect(mockRecordRunnerEvidenceMetric).toHaveBeenCalledWith(env, {
      owner: "acme",
      repo: "api",
      prNumber: 42,
      state: "verified",
    })
    expect(mockRunSarifEvidence).toHaveBeenCalledWith(expect.objectContaining({ rawOverride: RUNNER_SARIF }))
  })

  it("fails closed when GitLab has no injected provider client", async () => {
    const result = await handlePrReviewEnsemble({
      scmProvider: "gitlab",
      owner: "acme",
      repo: "api",
      prNumber: 42,
      headSha: HEAD_SHA,
      installationId: 0,
      repoId: 123,
      env: makeEnv(),
    })

    expect(result.status).toBe("errored")
    expect(result.telemetry).toMatchObject({
      scmProvider: "gitlab",
      fellBackReason: "internal_error",
      internalError: "GitLab reviews require an injected GitLab client",
    })
    expect(mockChat).not.toHaveBeenCalled()
  })
})
