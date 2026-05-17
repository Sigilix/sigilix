// ARC-265 — tests for the auto-label picker.
//
// Unit tests for `parseLabelResponse` (pure) and integration tests
// for `handlePrLabels` (mocked GitHubClient + Ollama + KV).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetPullRequest,
  mockGetPullRequestDiff,
  mockListRepositoryLabels,
  mockAddLabelsToIssue,
  mockRemoveLabelFromIssue,
  mockGetFileContent,
  mockGenerate,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "fake-token"),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListRepositoryLabels: vi.fn(),
  mockAddLabelsToIssue: vi.fn(),
  mockRemoveLabelFromIssue: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockGenerate: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
      getPullRequestDiff: (...args: unknown[]) => mockGetPullRequestDiff(...args),
      listRepositoryLabels: (...args: unknown[]) => mockListRepositoryLabels(...args),
      addLabelsToIssue: (...args: unknown[]) => mockAddLabelsToIssue(...args),
      removeLabelFromIssue: (...args: unknown[]) => mockRemoveLabelFromIssue(...args),
      getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    })),
  }
})

vi.mock("../src/lib/ollama", () => ({
  generate: (args: unknown) => mockGenerate(args),
}))

import { handlePrLabels, parseLabelResponse } from "../src/lib/triage-pr-labels"
import type { Env } from "../src/index"

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: { send: async () => undefined },
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
    OLLAMA_API_KEY: "test",
  } as unknown as Env
}

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 42,
  headSha: "a".repeat(40),
  installationId: 99,
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockReset()
  mockGetPullRequestDiff.mockReset().mockResolvedValue("diff text")
  mockListRepositoryLabels.mockReset().mockResolvedValue([])
  mockAddLabelsToIssue.mockReset().mockResolvedValue(undefined)
  mockRemoveLabelFromIssue.mockReset().mockResolvedValue(undefined)
  mockGetFileContent.mockReset()
  mockGenerate.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  // Only restore the console spies — `vi.restoreAllMocks()` strips
  // `GitHubClient.mockImplementation` (the constructor factory),
  // which would leave subsequent tests with an empty client (no
  // `getFileContent`, no `getPullRequest`, etc. → handler errors
  // silently in `loadSigilixConfig`'s catch and returns EMPTY_CONFIG).
  vi.spyOn(console, "log").mockRestore()
  vi.spyOn(console, "warn").mockRestore()
  vi.spyOn(console, "error").mockRestore()
})

describe("parseLabelResponse", () => {
  it("parses a well-formed JSON object", () => {
    expect(parseLabelResponse('{"labels":["a","b"]}')).toEqual(["a", "b"])
  })

  it("strips a ```json fence", () => {
    expect(parseLabelResponse('```json\n{"labels":["x"]}\n```')).toEqual(["x"])
  })

  it("returns null when labels is missing", () => {
    expect(parseLabelResponse('{"other":[]}')).toBeNull()
  })

  it("returns null when labels is not an array", () => {
    expect(parseLabelResponse('{"labels":"oops"}')).toBeNull()
  })

  it("filters out non-string entries and empty strings", () => {
    expect(parseLabelResponse('{"labels":["a",1,"","b",null,"  "]}'))
      .toEqual(["a", "b"])
  })

  it("trims whitespace around label names", () => {
    expect(parseLabelResponse('{"labels":["  area:security  "]}'))
      .toEqual(["area:security"])
  })
})

describe("handlePrLabels — config gating", () => {
  it("no-ops when sigilix.json has no customLabels (zero behavior change)", async () => {
    mockGetFileContent.mockResolvedValue(null) // no sigilix.json
    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockListRepositoryLabels).not.toHaveBeenCalled()
    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
  })

  it("no-ops when customLabels array is empty", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({ customLabels: [] }))
    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
  })

  it("no-ops when GITHUB_APP_ID is missing", async () => {
    const { kv } = makeKvStub()
    const env = {
      OPENCLAW_STATE: kv,
      // no GITHUB_APP_ID / GITHUB_PRIVATE_KEY
    } as unknown as Env
    await handlePrLabels({ ...baseArgs, env })

    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockGenerate).not.toHaveBeenCalled()
  })
})

describe("handlePrLabels — happy path", () => {
  const configFixture = JSON.stringify({
    customLabels: [
      { name: "area:security", description: "Touches auth or secrets" },
      { name: "breaking-change", description: "API or schema migration" },
    ],
  })

  it("applies labels picked by the model that are in the candidate pool", async () => {
    mockGetFileContent.mockResolvedValue(configFixture)
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "auth refactor", body: "rewrites password hashing",
      head: { sha: "a".repeat(40), ref: "feat/auth" },
      base: { sha: "b".repeat(40), ref: "main" },
      labels: [],
    })
    mockListRepositoryLabels.mockResolvedValue([])
    mockGenerate.mockResolvedValue('{"labels":["area:security"]}')

    const { kv, store } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockAddLabelsToIssue).toHaveBeenCalledTimes(1)
    expect(mockAddLabelsToIssue).toHaveBeenCalledWith("Arc-and-Anchor", "sigilix", 42, ["area:security"])
    expect(mockRemoveLabelFromIssue).not.toHaveBeenCalled()
    // KV record persists the applied set for future runs.
    const kvKey = `sigilix-applied-labels:arc-and-anchor/sigilix#42`
    expect(JSON.parse(store.get(kvKey)!)).toEqual(["area:security"])
  })

  it("drops model hallucinations (labels not in candidate pool)", async () => {
    mockGetFileContent.mockResolvedValue(configFixture)
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y", head: { sha: "a".repeat(40), ref: "x" },
      base: { sha: "b".repeat(40), ref: "main" }, labels: [],
    })
    mockListRepositoryLabels.mockResolvedValue([])
    // Model returns a name not in the candidate pool.
    mockGenerate.mockResolvedValue('{"labels":["area:security","fictional-label"]}')

    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockAddLabelsToIssue).toHaveBeenCalledWith(
      "Arc-and-Anchor", "sigilix", 42, ["area:security"], // fictional-label dropped
    )
  })

  it("includes repo labels with descriptions in the candidate pool", async () => {
    mockGetFileContent.mockResolvedValue(configFixture)
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y", head: { sha: "a".repeat(40), ref: "x" },
      base: { sha: "b".repeat(40), ref: "main" }, labels: [],
    })
    mockListRepositoryLabels.mockResolvedValue([
      { name: "bug", description: "User-facing regression" },
      { name: "no-desc-label", description: "" }, // excluded — no description
    ])
    mockGenerate.mockResolvedValue('{"labels":["bug"]}')

    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockAddLabelsToIssue).toHaveBeenCalledWith(
      "Arc-and-Anchor", "sigilix", 42, ["bug"],
    )
  })

  it("removes only Sigilix-applied labels that the model no longer picks", async () => {
    mockGetFileContent.mockResolvedValue(configFixture)
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y", head: { sha: "a".repeat(40), ref: "x" },
      base: { sha: "b".repeat(40), ref: "main" },
      // Current labels on the PR: `area:security` (Sigilix-applied last run),
      // `breaking-change` (Sigilix-applied last run), AND `wontfix`
      // (human-applied — must NOT be removed).
      labels: [{ name: "area:security" }, { name: "breaking-change" }, { name: "wontfix" }],
    })
    mockListRepositoryLabels.mockResolvedValue([])
    // Model now only picks `area:security` — `breaking-change` should be removed.
    mockGenerate.mockResolvedValue('{"labels":["area:security"]}')

    const { kv, store } = makeKvStub()
    // Seed the prior applied record.
    store.set(
      "sigilix-applied-labels:arc-and-anchor/sigilix#42",
      JSON.stringify(["area:security", "breaking-change"]),
    )

    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    // No add (area:security already on PR), one remove (breaking-change).
    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
    expect(mockRemoveLabelFromIssue).toHaveBeenCalledTimes(1)
    expect(mockRemoveLabelFromIssue).toHaveBeenCalledWith(
      "Arc-and-Anchor", "sigilix", 42, "breaking-change",
    )
    // KV updated.
    expect(JSON.parse(store.get("sigilix-applied-labels:arc-and-anchor/sigilix#42")!))
      .toEqual(["area:security"])
  })

  it("never removes labels that aren't in the Sigilix-applied KV record", async () => {
    mockGetFileContent.mockResolvedValue(configFixture)
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y", head: { sha: "a".repeat(40), ref: "x" },
      base: { sha: "b".repeat(40), ref: "main" },
      labels: [{ name: "wontfix" }], // ONLY a human-applied label
    })
    mockListRepositoryLabels.mockResolvedValue([])
    // Model picks nothing.
    mockGenerate.mockResolvedValue('{"labels":[]}')

    const { kv } = makeKvStub()
    // NO prior applied record — fresh PR for Sigilix.
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
    expect(mockRemoveLabelFromIssue).not.toHaveBeenCalled() // wontfix is NOT touched
  })
})

describe("handlePrLabels — stale-head guard", () => {
  it("skips when meta.head.sha doesn't match the job's headSha (pre-Ollama)", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({
      customLabels: [{ name: "x", description: "y" }],
    }))
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y",
      head: { sha: "b".repeat(40), ref: "x" }, // DIFFERENT from baseArgs.headSha
      base: { sha: "c".repeat(40), ref: "main" }, labels: [],
    })

    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
  })

  // code-reviewer MEDIUM catch on commit 2: Ollama runs 10-60s. If a
  // new commit lands during that window, applying labels from the
  // stale diff would mislabel the PR. Re-check after `generate`.
  it("skips when head moves AFTER Ollama returns (post-Ollama guard)", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({
      customLabels: [{ name: "area:security", description: "auth" }],
    }))
    let getPRCallCount = 0
    mockGetPullRequest.mockImplementation(async () => {
      getPRCallCount += 1
      if (getPRCallCount === 1) {
        // First call (pre-Ollama): head matches → handler proceeds.
        return {
          number: 42, title: "x", body: "y",
          head: { sha: "a".repeat(40), ref: "x" },
          base: { sha: "b".repeat(40), ref: "main" }, labels: [],
        }
      }
      // Second call (post-Ollama re-check): head has drifted.
      return {
        number: 42, title: "x", body: "y",
        head: { sha: "c".repeat(40), ref: "x" },
        base: { sha: "b".repeat(40), ref: "main" }, labels: [],
      }
    })
    mockListRepositoryLabels.mockResolvedValue([])
    mockGenerate.mockResolvedValue('{"labels":["area:security"]}')

    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    // Ollama ran but labels were NOT applied.
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
    expect(getPRCallCount).toBe(2)
  })

  it("bails when the post-Ollama re-fetch itself fails (no apply on unverified head)", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({
      customLabels: [{ name: "x", description: "y" }],
    }))
    let getPRCallCount = 0
    mockGetPullRequest.mockImplementation(async () => {
      getPRCallCount += 1
      if (getPRCallCount === 1) {
        return {
          number: 42, title: "x", body: "y",
          head: { sha: "a".repeat(40), ref: "x" },
          base: { sha: "b".repeat(40), ref: "main" }, labels: [],
        }
      }
      throw new Error("HTTP 502")
    })
    mockListRepositoryLabels.mockResolvedValue([])
    mockGenerate.mockResolvedValue('{"labels":["x"]}')

    const { kv } = makeKvStub()
    await handlePrLabels({ ...baseArgs, env: makeEnv(kv) })

    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
  })
})

describe("handlePrLabels — error paths", () => {
  it("swallows Ollama failures and exits cleanly", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({
      customLabels: [{ name: "x", description: "y" }],
    }))
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y",
      head: { sha: "a".repeat(40), ref: "x" },
      base: { sha: "b".repeat(40), ref: "main" }, labels: [],
    })
    mockGenerate.mockRejectedValue(new Error("ollama timeout"))

    const { kv } = makeKvStub()
    await expect(handlePrLabels({ ...baseArgs, env: makeEnv(kv) })).resolves.toBeUndefined()
    expect(mockAddLabelsToIssue).not.toHaveBeenCalled()
  })

  it("swallows fetch failures (getPullRequest etc.) cleanly", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({
      customLabels: [{ name: "x", description: "y" }],
    }))
    mockGetPullRequest.mockRejectedValue(new Error("HTTP 502"))

    const { kv } = makeKvStub()
    await expect(handlePrLabels({ ...baseArgs, env: makeEnv(kv) })).resolves.toBeUndefined()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("doesn't break when KV-applied record is corrupt JSON", async () => {
    mockGetFileContent.mockResolvedValue(JSON.stringify({
      customLabels: [{ name: "x", description: "y" }],
    }))
    mockGetPullRequest.mockResolvedValue({
      number: 42, title: "x", body: "y",
      head: { sha: "a".repeat(40), ref: "x" },
      base: { sha: "b".repeat(40), ref: "main" }, labels: [],
    })
    mockGenerate.mockResolvedValue('{"labels":["x"]}')

    const { kv, store } = makeKvStub()
    store.set("sigilix-applied-labels:arc-and-anchor/sigilix#42", "not json")

    await expect(handlePrLabels({ ...baseArgs, env: makeEnv(kv) })).resolves.toBeUndefined()
    // Treats the corrupt record as empty — label is added, no removes attempted.
    expect(mockAddLabelsToIssue).toHaveBeenCalled()
    expect(mockRemoveLabelFromIssue).not.toHaveBeenCalled()
  })
})
