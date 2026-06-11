// ARC-234 — tests for the install / repos-added webhook producer.
//
// Covers:
//   - parseFullName (the only pure-function unit; rejects bad shapes)
//   - enqueueIndexJobsForRepos (the actual fanout):
//       * fans out one OPENCLAW_JOBS.send per valid entry
//       * skips invalid `full_name` entries with telemetry, doesn't crash
//       * skips sensitive repos by env-var allowlist; counts them
//       * one bad enqueue (queue.send throws) doesn't abort the rest
//       * preserves reason ("install" vs "install-repos-added") on each send
//   - isIndexerEnabled (flag gate)

import { beforeEach, describe, expect, it, vi } from "vitest"
import { enqueueIndexJobsForRepos, isIndexerEnabled, parseFullName } from "@/src/lib/index-producer"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

function makeEnv(
  over: Partial<Env> = {},
  sendImpl?: (msg: unknown) => Promise<void> | void,
): {
  env: Env
  sent: JobMessage[]
} {
  const sent: JobMessage[] = []
  const baseSend = async (msg: JobMessage): Promise<void> => {
    sent.push(msg)
  }
  const env = {
    OPENCLAW_JOBS: {
      send: sendImpl ?? baseSend,
    },
    OPENCLAW_SENSITIVE_REPOS: undefined,
    OPENCLAW_INDEXER_ENABLED: undefined,
    ...over,
  } as unknown as Env
  return { env, sent }
}

describe("parseFullName", () => {
  it("accepts canonical owner/repo", () => {
    expect(parseFullName({ full_name: "Sigilix/sigilix" })).toEqual({
      owner: "Sigilix",
      repo: "sigilix",
    })
  })

  it("trims surrounding whitespace before parsing", () => {
    expect(parseFullName({ full_name: "  owner/repo  " })).toEqual({
      owner: "owner",
      repo: "repo",
    })
  })

  it("rejects missing full_name", () => {
    expect(parseFullName({})).toBeNull()
    expect(parseFullName({ name: "repo" })).toBeNull()
  })

  it("rejects non-string full_name", () => {
    expect(parseFullName({ full_name: 42 as unknown as string })).toBeNull()
  })

  it("rejects shapes with zero or multiple slashes", () => {
    expect(parseFullName({ full_name: "norepo" })).toBeNull()
    expect(parseFullName({ full_name: "a/b/c" })).toBeNull()
    expect(parseFullName({ full_name: "/onlyrepo" })).toBeNull()
    expect(parseFullName({ full_name: "owneronly/" })).toBeNull()
    expect(parseFullName({ full_name: "/" })).toBeNull()
  })
})

describe("isIndexerEnabled", () => {
  it("returns true only when env value is exactly 'on'", () => {
    expect(isIndexerEnabled({ OPENCLAW_INDEXER_ENABLED: "on" })).toBe(true)
    expect(isIndexerEnabled({ OPENCLAW_INDEXER_ENABLED: "off" })).toBe(false)
    expect(isIndexerEnabled({ OPENCLAW_INDEXER_ENABLED: "ON" })).toBe(false)
    expect(isIndexerEnabled({ OPENCLAW_INDEXER_ENABLED: "true" })).toBe(false)
    expect(isIndexerEnabled({ OPENCLAW_INDEXER_ENABLED: "" })).toBe(false)
    expect(isIndexerEnabled({ OPENCLAW_INDEXER_ENABLED: undefined })).toBe(false)
    expect(isIndexerEnabled({})).toBe(false)
  })
})

describe("enqueueIndexJobsForRepos", () => {
  const baseRepos = [
    { name: "repo-a", full_name: "Sigilix/repo-a" },
    { name: "repo-b", full_name: "Sigilix/repo-b" },
  ]

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("fans out one OPENCLAW_JOBS.send per valid entry, carries reason", async () => {
    const { env, sent } = makeEnv()
    const result = await enqueueIndexJobsForRepos({
      env,
      installationId: 99,
      repositories: baseRepos,
      reason: "install",
    })
    expect(result).toEqual({
      attempted: 2,
      succeeded: 2,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({
      type: "index-repo",
      owner: "Sigilix",
      repo: "repo-a",
      installationId: 99,
      reason: "install",
    })
    expect(sent[1]?.type).toBe("index-repo")
    if (sent[1]?.type === "index-repo") {
      expect(sent[1].reason).toBe("install")
    }
  })

  it("preserves the 'install-repos-added' reason on every send", async () => {
    const { env, sent } = makeEnv()
    await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: baseRepos,
      reason: "install-repos-added",
    })
    expect(sent).toHaveLength(2)
    for (const msg of sent) {
      if (msg.type === "index-repo") {
        expect(msg.reason).toBe("install-repos-added")
      }
    }
  })

  it("carries entry.id as githubRepoId on the queue message (SIG-243 Phase 1)", async () => {
    // SIG-243: install / installation_repositories webhook payloads
    // include `id` per repo. The producer forwards it onto the queue
    // message so bootstrap manifests carry the canonical immutable
    // identifier from their first write.
    const { env, sent } = makeEnv()
    const reposWithIds = [
      { id: 808247824, name: "sigilix", full_name: "Sigilix/sigilix" },
      { id: 980123456, name: "rubberfit", full_name: "Rubberfit/rubberfit" },
    ]
    await enqueueIndexJobsForRepos({
      env,
      installationId: 99,
      repositories: reposWithIds,
      reason: "install",
    })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({
      type: "index-repo",
      owner: "Sigilix",
      repo: "sigilix",
      githubRepoId: 808247824,
      installationId: 99,
      reason: "install",
    })
    if (sent[1]?.type === "index-repo") {
      expect(sent[1].githubRepoId).toBe(980123456)
    }
  })

  it("omits githubRepoId when the entry has no id (legacy synthetic entries)", async () => {
    // SIG-243: reconciliation cron synthesises InstallRepoEntry from
    // a KV scan of `repo-index-manifest:*` keys and has no `id`
    // available (Phase 3 backfill resolves it via GitHub API). The
    // producer must NOT land `githubRepoId: undefined` on the queue.
    const { env, sent } = makeEnv()
    await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: baseRepos,
      reason: "install-repos-added",
    })
    for (const msg of sent) {
      expect(msg).not.toHaveProperty("githubRepoId")
    }
  })

  it("skips invalid full_name entries with telemetry, continues with the rest", async () => {
    const { env, sent } = makeEnv()
    const result = await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: [
        { full_name: "Sigilix/repo-a" },
        { full_name: "no-slash" },
        { full_name: "a/b/c" },
        { name: "repo-d" }, // missing full_name
        { full_name: "Sigilix/repo-e" },
      ],
      reason: "install",
    })
    expect(result.attempted).toBe(2)
    expect(result.succeeded).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent.map((m) => (m.type === "index-repo" ? m.repo : null))).toEqual(["repo-a", "repo-e"])
  })

  it("skips sensitive repos and counts them separately", async () => {
    const { env, sent } = makeEnv({
      OPENCLAW_SENSITIVE_REPOS: "sigilix/repo-b",
    })
    const result = await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: baseRepos,
      reason: "install",
    })
    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 1,
    })
    expect(sent).toHaveLength(1)
    if (sent[0]?.type === "index-repo") {
      expect(sent[0].repo).toBe("repo-a")
    }
  })

  it("one queue.send throw doesn't abort the rest of the fanout", async () => {
    const sent: JobMessage[] = []
    let calls = 0
    const send = async (msg: JobMessage): Promise<void> => {
      calls += 1
      if (calls === 1) throw new Error("transient queue failure")
      sent.push(msg)
    }
    const env = {
      OPENCLAW_JOBS: { send },
      OPENCLAW_SENSITIVE_REPOS: undefined,
    } as unknown as Env

    const result = await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: baseRepos,
      reason: "install",
    })
    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      perRepoFailed: 1,
      sensitiveSkipped: 0,
    })
    expect(sent).toHaveLength(1)
  })

  it("reports zero success when EVERY send throws (drives 503 fallback)", async () => {
    const send = async (): Promise<void> => {
      throw new Error("queue binding down")
    }
    const env = {
      OPENCLAW_JOBS: { send },
      OPENCLAW_SENSITIVE_REPOS: undefined,
    } as unknown as Env

    const result = await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: baseRepos,
      reason: "install",
    })
    expect(result.attempted).toBe(2)
    expect(result.succeeded).toBe(0)
    expect(result.perRepoFailed).toBe(2)
  })

  it("returns zeros on empty repositories array", async () => {
    const { env, sent } = makeEnv()
    const result = await enqueueIndexJobsForRepos({
      env,
      installationId: 1,
      repositories: [],
      reason: "install",
    })
    expect(result).toEqual({
      attempted: 0,
      succeeded: 0,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })
    expect(sent).toHaveLength(0)
  })
})
