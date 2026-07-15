import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_CHUNK_CHARS } from "@/src/lib/chunk-core"
import { chunkId } from "@/src/lib/indexer-internals"
import { repoTenantKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { handleSlackRequest } from "@/src/index-slack-webhook"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const BASE_SQL = readFileSync(new URL("../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(new URL("../migrations/0019_create_slack_channel_repo.sql", import.meta.url), "utf8")

const SIGNING_SECRET = "slack-verified-citation-secret"
const TEAM_ID = "T0CITATION"
const CHANNEL_ID = "C0CITATION"
const SLACK_USER_ID = "U0CITATION"
const THREAD_TS = "1783999999.000100"
const INSTALLATION_ID = 42
const API_REPO_ID = 101
const WEB_REPO_ID = 102
const GITHUB_TOKEN = "ghs_verified_citation_test"
const BOT_TOKEN = "xoxb-verified-citation-test"
const API_NAMESPACE = "acme/api"
const WEB_NAMESPACE = "acme/web"
const API_HEAD_SHA = "a".repeat(40)
const WEB_HEAD_SHA = "b".repeat(40)
const API_RUN_ID = "1".repeat(16)
const WEB_RUN_ID = "2".repeat(16)
const FILE_PATH = "src/auth.ts"
const API_FRAGMENT_PATH = "src/generated.ts"
const API_FRAGMENT_SOURCE = "=".repeat(MAX_CHUNK_CHARS * 2)
const API_FRAGMENT_CONTENT = API_FRAGMENT_SOURCE.slice(MAX_CHUNK_CHARS)
const API_FRAGMENT_INDEX = 1
const WEB_FILE_CONTENT = [
  "export function canOpenDashboard(role: string): boolean {",
  '  return role === "member" || role === "admin"',
  "}",
].join("\n")
const READ_FILE_PATH = "src/config.ts"
const READ_FILE_CONTENT = ["export const config = {", '  apiRole: "admin",', '  webRole: "member",', "}"].join("\n")
const READ_LINE_START = 2
const READ_LINE_END = 3
const PR_NUMBER = 7
const PR_BASE_SHA = "c".repeat(40)
const PR_HEAD_SHA = "d".repeat(40)
const ANSWER = "The generated guard, dashboard policy, exact config lines, and PR snapshot support this comparison."

interface FakeKv extends KVNamespace {
  values: Map<string, string>
}

function makeKv(): FakeKv {
  const values = new Map<string, string>()
  return {
    values,
    get: vi.fn(async (key: string, type?: string) => {
      const raw = values.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    }),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: [...values.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as FakeKv
}

function makeExecutionContext(): ExecutionContext & { flush(): Promise<void>; pendingCount(): number } {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
    async flush() {
      await Promise.all(pending)
    },
    pendingCount() {
      return pending.length
    },
  } as ExecutionContext & { flush(): Promise<void>; pendingCount(): number }
}

async function signSlackBody(timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`))
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `v0=${hex}`
}

async function signedMention(): Promise<Request> {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: TEAM_ID,
    event_id: "EvVerifiedCitation",
    event: {
      type: "app_mention",
      user: SLACK_USER_ID,
      channel: CHANNEL_ID,
      text: "<@U0SIGILIX> compare authorization in the API and web dashboard, including config lines and PR #7",
      ts: THREAD_TS,
    },
  })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  return new Request("https://api.sigilix.ai/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await signSlackBody(timestamp, body),
    },
    body,
  })
}

async function makePlatformDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(SLACK_SQL)
  const now = "2026-07-14T00:00:00.000Z"
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, 'acme', 'Organization', ?, ?)",
    )
    .bind(INSTALLATION_ID, now, now)
    .run()
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at)" + " VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    )
    .bind(API_REPO_ID, INSTALLATION_ID, API_NAMESPACE, now, WEB_REPO_ID, INSTALLATION_ID, WEB_NAMESPACE, now)
    .run()
  await db
    .prepare(
      "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
        " VALUES (?, ?, 'acme-admin', ?, ?)",
    )
    .bind(TEAM_ID, INSTALLATION_ID, now, now)
    .run()
  await db
    .prepare(
      "INSERT INTO slack_channel_binding" +
        " (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
        " VALUES (?, ?, ?, 0, ?, ?)",
    )
    .bind(TEAM_ID, CHANNEL_ID, INSTALLATION_ID, now, now)
    .run()
  await db
    .prepare(
      "INSERT INTO slack_channel_repo" +
        " (team_id, channel_id, installation_id, github_repo_id, github_repo_full_name, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      TEAM_ID,
      CHANNEL_ID,
      INSTALLATION_ID,
      API_REPO_ID,
      API_NAMESPACE,
      now,
      now,
      TEAM_ID,
      CHANNEL_ID,
      INSTALLATION_ID,
      WEB_REPO_ID,
      WEB_NAMESPACE,
      now,
      now,
    )
    .run()
  return db
}

function ollamaStream(message: Record<string, unknown>): Response {
  return new Response(`${JSON.stringify({ message, done: true, prompt_eval_count: 10, eval_count: 5 })}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  })
}

function makeManifest(args: {
  githubRepoId: number
  repo: string
  namespace: string
  headSha: string
  runId: string
  byPath: Record<string, string[]>
}): RepoIndexManifestV1 {
  const chunkCount = Object.values(args.byPath).reduce((total, ids) => total + ids.length, 0)
  return {
    v: 1,
    owner: "acme",
    repo: args.repo,
    namespace: args.namespace,
    githubRepoId: args.githubRepoId,
    defaultBranch: "main",
    headSha: args.headSha,
    runId: args.runId,
    fileCount: Object.keys(args.byPath).length,
    chunkCount,
    shardCount: 1,
    indexedAt: "2026-07-14T00:00:00.000Z",
    modelId: "@cf/baai/bge-base-en-v1.5",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 30,
    overlapLines: 10,
    activeIndex: {
      version: 1,
      githubRepoId: args.githubRepoId,
      builtMode: "on",
      byPath: args.byPath,
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("signed Slack webhook verified citations", () => {
  it("posts versioned code, exact file-line, and immutable PR citations from one tool turn", async () => {
    const db = await makePlatformDb()
    const kv = makeKv()
    const apiChunkId = await chunkId(API_NAMESPACE, {
      path: API_FRAGMENT_PATH,
      lineStart: 1,
      lineEnd: 1,
      content: API_FRAGMENT_CONTENT,
      fragmentIndex: API_FRAGMENT_INDEX,
    })
    const webChunkId = await chunkId(WEB_NAMESPACE, {
      path: FILE_PATH,
      lineStart: 1,
      lineEnd: 3,
      content: WEB_FILE_CONTENT,
    })
    const readFileChunkId = await chunkId(API_NAMESPACE, {
      path: READ_FILE_PATH,
      lineStart: 1,
      lineEnd: 4,
      content: READ_FILE_CONTENT,
    })
    kv.values.set(
      `gh-installation-token:${INSTALLATION_ID}`,
      JSON.stringify({ token: GITHUB_TOKEN, expiresAt: Date.now() + 60 * 60 * 1_000 }),
    )
    kv.values.set(`slack-install:${TEAM_ID}`, JSON.stringify({ botToken: BOT_TOKEN }))
    kv.values.set(
      repoTenantKey(API_REPO_ID),
      JSON.stringify(
        makeManifest({
          githubRepoId: API_REPO_ID,
          repo: "api",
          namespace: API_NAMESPACE,
          headSha: API_HEAD_SHA,
          runId: API_RUN_ID,
          byPath: {
            [API_FRAGMENT_PATH]: [apiChunkId],
            [READ_FILE_PATH]: [readFileChunkId],
          },
        }),
      ),
    )
    kv.values.set(
      repoTenantKey(WEB_REPO_ID),
      JSON.stringify(
        makeManifest({
          githubRepoId: WEB_REPO_ID,
          repo: "web",
          namespace: WEB_NAMESPACE,
          headSha: WEB_HEAD_SHA,
          runId: WEB_RUN_ID,
          byPath: { [FILE_PATH]: [webChunkId] },
        }),
      ),
    )
    const mutableManifestKeys = [`repo-index-manifest:${API_NAMESPACE}`, `repo-index-manifest:${WEB_NAMESPACE}`]
    for (const key of mutableManifestKeys) expect(kv.values.has(key)).toBe(false)

    const embedding = Array.from({ length: 768 }, () => 0.01)
    const vectorMatches = new Map<string, Record<string, unknown>>([
      [
        API_NAMESPACE,
        {
          id: apiChunkId,
          score: 0.99,
          metadata: {
            repo: API_NAMESPACE,
            path: API_FRAGMENT_PATH,
            lineStart: 1,
            lineEnd: 1,
            content: API_FRAGMENT_CONTENT,
            headSha: API_HEAD_SHA,
            runId: API_RUN_ID,
            citationChunkVersion: 1,
            fragmentIndex: API_FRAGMENT_INDEX,
          },
        },
      ],
      [
        WEB_NAMESPACE,
        {
          id: webChunkId,
          score: 0.98,
          metadata: {
            repo: WEB_NAMESPACE,
            path: FILE_PATH,
            lineStart: 1,
            lineEnd: 3,
            content: WEB_FILE_CONTENT,
            headSha: WEB_HEAD_SHA,
            runId: WEB_RUN_ID,
            citationChunkVersion: 1,
            fragmentIndex: -1,
          },
        },
      ],
    ])
    const codeIndex = {
      query: vi.fn(async (_vector: number[], options: { namespace?: string }) => {
        const match = options.namespace ? vectorMatches.get(options.namespace) : undefined
        if (!match) throw new Error(`unexpected Vectorize namespace: ${String(options.namespace)}`)
        return { matches: [match] }
      }),
    }
    const memoryIndex = {
      query: vi.fn(async (_vector: number[], _options: { topK?: number; namespace?: string }) => ({ matches: [] })),
      upsert: vi.fn(async (_vectors: Array<{ namespace: string }>) => undefined),
      deleteByIds: vi.fn(async () => undefined),
    }
    const ai = {
      run: vi.fn(async () => ({ data: [embedding], shape: [1, embedding.length] })),
    }

    const ollamaBodies: Array<Record<string, unknown>> = []
    const githubRequests: Array<{ path: string; accept: string }> = []
    const slackPosts: Array<Record<string, unknown>> = []
    const observedToolResults = new Map<string, { toolName: string; result: Record<string, unknown> }>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

      if (url.hostname === "api.github.com") {
        githubRequests.push({ path: `${url.pathname}${url.search}`, accept: headers.get("accept") ?? "" })
        expect(headers.get("authorization")).toBe(`token ${GITHUB_TOKEN}`)
        if (url.pathname === "/installation/repositories") {
          return new Response(
            JSON.stringify({
              total_count: 2,
              repositories: [
                { id: API_REPO_ID, full_name: API_NAMESPACE },
                { id: WEB_REPO_ID, full_name: WEB_NAMESPACE },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.pathname === "/repos/acme/api") {
          return new Response(JSON.stringify({ id: API_REPO_ID, default_branch: "main" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === "/repos/acme/web") {
          return new Response(JSON.stringify({ id: WEB_REPO_ID, default_branch: "main" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (
          url.pathname === `/repos/acme/api/contents/${API_FRAGMENT_PATH}` &&
          url.searchParams.get("ref") === API_HEAD_SHA
        ) {
          return new Response(JSON.stringify({ content: btoa(API_FRAGMENT_SOURCE), encoding: "base64" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (
          url.pathname === `/repos/acme/api/contents/${READ_FILE_PATH}` &&
          url.searchParams.get("ref") === API_HEAD_SHA
        ) {
          return new Response(JSON.stringify({ content: btoa(READ_FILE_CONTENT), encoding: "base64" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === `/repos/acme/web/contents/${FILE_PATH}` && url.searchParams.get("ref") === WEB_HEAD_SHA) {
          return new Response(JSON.stringify({ content: btoa(WEB_FILE_CONTENT), encoding: "base64" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === `/repos/acme/api/pulls/${PR_NUMBER}`) {
          if (headers.get("accept")?.includes("diff")) {
            return new Response("mutable pull-request diff is forbidden in citation mode", { status: 409 })
          }
          return new Response(
            JSON.stringify({
              number: PR_NUMBER,
              title: "Pin authorization context",
              body: "Use immutable authorization evidence.",
              state: "open",
              merged_at: null,
              changed_files: 1,
              base: { sha: PR_BASE_SHA, ref: "main" },
              head: { sha: PR_HEAD_SHA, ref: "feat/pin-auth-context" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.pathname === `/repos/acme/api/pulls/${PR_NUMBER}/files`) {
          return new Response("mutable pull-request files are forbidden in citation mode", { status: 409 })
        }
        if (url.pathname === `/repos/acme/api/compare/${PR_BASE_SHA}...${PR_HEAD_SHA}`) {
          if (headers.get("accept")?.includes("diff")) {
            return new Response(`diff --git a/${READ_FILE_PATH} b/${READ_FILE_PATH}\n+immutable snapshot`, {
              status: 200,
              headers: { "content-type": "text/plain" },
            })
          }
          return new Response(
            JSON.stringify({
              status: "ahead",
              total_commits: 1,
              files: [{ status: "modified", filename: READ_FILE_PATH, previous_filename: null }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
      }

      if (url.href === "https://ollama.com/api/chat") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        ollamaBodies.push(body)
        const messages = body.messages as Array<Record<string, unknown>>
        const toolMessage = [...messages].reverse().find((message) => message.role === "tool")
        if (!toolMessage) {
          return ollamaStream({
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "retrieve-api",
                function: {
                  name: "retrieve_codebase",
                  arguments: JSON.stringify({ query: "API authorization guard", repo: API_NAMESPACE }),
                },
              },
              {
                id: "retrieve-web",
                function: {
                  name: "retrieve_codebase",
                  arguments: JSON.stringify({ query: "web authorization guard", repo: WEB_NAMESPACE }),
                },
              },
              {
                id: "fetch-api-pr",
                function: {
                  name: "fetch_pr",
                  arguments: JSON.stringify({ owner: "acme", repo: "api", number: PR_NUMBER }),
                },
              },
              {
                id: "read-api-config",
                function: {
                  name: "read_file_lines",
                  arguments: JSON.stringify({
                    owner: "acme",
                    repo: "api",
                    path: READ_FILE_PATH,
                    lineStart: READ_LINE_START,
                    lineEnd: READ_LINE_END,
                  }),
                },
              },
            ],
          })
        }

        const toolMessages = messages.filter((message) => message.role === "tool")
        for (const message of toolMessages) {
          observedToolResults.set(String(message.tool_call_id), {
            toolName: String(message.tool_name),
            result: JSON.parse(String(message.content)) as Record<string, unknown>,
          })
        }
        const citationFor = (callId: string): Record<string, unknown> | null => {
          const observed = observedToolResults.get(callId)?.result
          const chunks = observed?.chunks
          const raw = Array.isArray(chunks)
            ? (chunks[0] as Record<string, unknown> | undefined)?.citation
            : observed?.citation
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
          const citation = raw as Record<string, unknown>
          if (
            Object.keys(citation).sort().join(",") !== "id,kind" ||
            typeof citation.id !== "string" ||
            citation.id.length === 0 ||
            typeof citation.kind !== "string"
          ) {
            return null
          }
          return citation
        }
        const citations = [
          citationFor("retrieve-api"),
          citationFor("retrieve-web"),
          citationFor("fetch-api-pr"),
          citationFor("read-api-config"),
        ].filter((citation): citation is Record<string, unknown> => citation !== null)
        return ollamaStream({
          role: "assistant",
          content: JSON.stringify({ answer: ANSWER, confidence: 5, abstain: false, citations }),
        })
      }

      if (url.hostname === "slack.com" && url.pathname === "/api/conversations.replies") {
        expect(headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`)
        return new Response(JSON.stringify({ ok: true, messages: [{ text: "Where is the authorization guard?" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.hostname === "slack.com" && url.pathname === "/api/chat.postMessage") {
        expect(headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        slackPosts.push(body)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      return new Response(`unexpected external request: ${url.href}`, { status: 500 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_SLACK_MODE: "on",
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "unused-cached-private-key",
      OLLAMA_CHAT_ENABLE: "on",
      OLLAMA_API_KEY: "ollama-test-key",
      OPENCLAW_MODEL: "glm-5.1:cloud",
      OPENCLAW_SLACK_CODE_CITATIONS_MODE: "on",
      OPENCLAW_SLACK_MEMORY_SCOPE_MODE: "on",
      SIGILIX_USAGE_METER_MODE: "off",
      OPENCLAW_ENTITLEMENTS_MODE: "off",
      OPENCLAW_REPOSITORY_CONTEXT_SLACK_MODE: "off",
      OPENCLAW_SURFACE_MEMORY_APPLY: "off",
      OPENCLAW_LEARNINGS_MODE: "off",
      OPENCLAW_ORG_MEMORY_CAPTURE: "off",
      SIGILIX_SKILLS_MODE: "off",
      OPENCLAW_RETRIEVAL_HYBRID: "off",
      AI: ai,
      OPENCLAW_CODE_INDEX: codeIndex,
      OPENCLAW_AGENT_MEMORY_INDEX: memoryIndex,
    } as unknown as Env

    const ctx = makeExecutionContext()
    const response = await handleSlackRequest(await signedMention(), env, ctx)

    expect(response.status).toBe(200)
    expect(ctx.pendingCount()).toBe(1)
    await ctx.flush()

    expect(codeIndex.query).toHaveBeenCalledTimes(2)
    expect(codeIndex.query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ namespace: API_NAMESPACE }),
    )
    expect(codeIndex.query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ namespace: WEB_NAMESPACE }),
    )
    expect(observedToolResults.size).toBe(4)
    expect(observedToolResults.get("retrieve-api")).toMatchObject({
      toolName: "retrieve_codebase",
      result: {
        ok: true,
        repo: API_NAMESPACE,
        count: 1,
        chunks: [expect.objectContaining({ citation: { kind: "code", id: expect.any(String) } })],
      },
    })
    expect(observedToolResults.get("retrieve-web")).toMatchObject({
      toolName: "retrieve_codebase",
      result: {
        ok: true,
        repo: WEB_NAMESPACE,
        count: 1,
        chunks: [expect.objectContaining({ citation: { kind: "code", id: expect.any(String) } })],
      },
    })
    expect(observedToolResults.get("fetch-api-pr")).toMatchObject({
      toolName: "fetch_pr",
      result: {
        ok: true,
        citation: { kind: "pull_request", id: expect.any(String) },
      },
    })
    expect(observedToolResults.get("read-api-config")).toMatchObject({
      toolName: "read_file_lines",
      result: {
        ok: true,
        ref: API_HEAD_SHA,
        lineStart: READ_LINE_START,
        lineEnd: READ_LINE_END,
        citation: { kind: "file_lines", id: expect.any(String) },
      },
    })
    for (const callId of ["retrieve-api", "retrieve-web", "fetch-api-pr", "read-api-config"]) {
      const result = observedToolResults.get(callId)?.result
      const chunks = result?.chunks
      const citation = Array.isArray(chunks)
        ? (chunks[0] as Record<string, unknown> | undefined)?.citation
        : result?.citation
      expect(Object.keys(citation as Record<string, unknown>).sort()).toEqual(["id", "kind"])
    }
    expect(observedToolResults.get("retrieve-api")?.result).toMatchObject({
      ok: true,
      chunks: [
        expect.objectContaining({
          path: API_FRAGMENT_PATH,
          lineStart: 1,
          lineEnd: 1,
          content: API_FRAGMENT_CONTENT,
        }),
      ],
    })
    expect(ollamaBodies).toHaveLength(2)
    expect(ollamaBodies[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "retrieve_codebase" }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: "fetch_pr" }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: "read_file_lines" }) }),
      ]),
    )
    const githubPaths = githubRequests.map((request) => request.path)
    expect(githubPaths).toEqual(
      expect.arrayContaining([
        "/installation/repositories?per_page=100&page=1",
        "/repos/acme/api",
        "/repos/acme/web",
        `/repos/acme/api/contents/${API_FRAGMENT_PATH}?ref=${API_HEAD_SHA}`,
        `/repos/acme/api/contents/${READ_FILE_PATH}?ref=${API_HEAD_SHA}`,
        `/repos/acme/web/contents/${FILE_PATH}?ref=${WEB_HEAD_SHA}`,
        `/repos/acme/api/pulls/${PR_NUMBER}`,
        `/repos/acme/api/compare/${PR_BASE_SHA}...${PR_HEAD_SHA}`,
      ]),
    )
    expect(githubPaths).not.toContain(`/repos/acme/api/contents/${READ_FILE_PATH}?ref=main`)
    expect(
      githubRequests.some(
        (request) => request.path === `/repos/acme/api/pulls/${PR_NUMBER}` && request.accept.includes("diff"),
      ),
    ).toBe(false)
    expect(githubPaths.filter((path) => path === `/repos/acme/api/pulls/${PR_NUMBER}`)).toHaveLength(1)
    expect(githubPaths.some((path) => path.startsWith(`/repos/acme/api/pulls/${PR_NUMBER}/files`))).toBe(false)
    const compareRequests = githubRequests.filter(
      (request) => request.path === `/repos/acme/api/compare/${PR_BASE_SHA}...${PR_HEAD_SHA}`,
    )
    expect(compareRequests.length).toBeGreaterThanOrEqual(2)
    expect(compareRequests.some((request) => request.accept.includes("diff"))).toBe(true)
    expect(compareRequests.some((request) => !request.accept.includes("diff"))).toBe(true)
    expect(githubPaths.filter((path) => path === "/repos/acme/api").length).toBeGreaterThanOrEqual(2)
    expect(githubPaths.filter((path) => path === "/repos/acme/web").length).toBeGreaterThanOrEqual(2)
    expect(kv.get).toHaveBeenCalledWith(repoTenantKey(API_REPO_ID))
    expect(kv.get).toHaveBeenCalledWith(repoTenantKey(WEB_REPO_ID))
    for (const key of mutableManifestKeys) {
      expect(kv.get).toHaveBeenCalledWith(key)
      expect(kv.values.has(key)).toBe(false)
    }

    const apiUrl = `https://github.com/acme/api/blob/${API_HEAD_SHA}/${API_FRAGMENT_PATH}#L1`
    const webUrl = `https://github.com/acme/web/blob/${WEB_HEAD_SHA}/${FILE_PATH}#L1-L3`
    const fileUrl = `https://github.com/acme/api/blob/${API_HEAD_SHA}/${READ_FILE_PATH}#L${READ_LINE_START}-L${READ_LINE_END}`
    const compareUrl = `https://github.com/acme/api/compare/${PR_BASE_SHA}...${PR_HEAD_SHA}`
    expect(slackPosts).toHaveLength(1)
    expect(slackPosts[0]).toMatchObject({ channel: CHANNEL_ID, thread_ts: THREAD_TS })
    const slackText = String(slackPosts[0]?.text)
    expect(slackText).toContain(ANSWER)
    expect(slackText).toContain(apiUrl)
    expect(slackText).toContain(webUrl)
    expect(slackText).toContain(fileUrl)
    expect(slackText).toContain(compareUrl)
    expect(slackText).not.toContain(`/pull/${PR_NUMBER}`)
    expect(kv.values.has(`slack-event:EvVerifiedCitation`)).toBe(true)
    expect([...kv.values.keys()].some((key) => key.startsWith("agent-loop-telemetry:"))).toBe(true)

    expect(memoryIndex.query).toHaveBeenCalledOnce()
    expect(memoryIndex.upsert).toHaveBeenCalledOnce()
    const queryOptions = memoryIndex.query.mock.calls[0]?.[1]
    const upserted = memoryIndex.upsert.mock.calls[0]?.[0]
    const queryNamespace = queryOptions?.namespace
    const writeNamespace = upserted?.[0]?.namespace
    expect(queryOptions).toMatchObject({ topK: 5, returnMetadata: "all" })
    expect(queryNamespace).toBe(writeNamespace)
    expect(queryNamespace).toMatch(/^slack:v2:[0-9a-f]{26}\/s-[0-9a-f]{26}$/)
    expect(new TextEncoder().encode(queryNamespace)).toHaveLength(64)
    expect(queryNamespace).not.toBe("slack:t0citation/acme/api")

    const memoryKeys = [...kv.values.keys()].filter((key) => key.startsWith("agent-memory"))
    expect(memoryKeys.some((key) => key.startsWith("agent-memory:slack:v2:") && key.includes(":s-"))).toBe(true)
    expect(memoryKeys.some((key) => key.startsWith("agent-memory-hash:slack:v2:") && key.includes(":s-"))).toBe(true)
    expect(memoryKeys.some((key) => key.startsWith("agent-memory:slack:t0citation:"))).toBe(false)
    expect(memoryKeys.some((key) => key.startsWith("agent-memory-hash:slack:t0citation:"))).toBe(false)
    expect(memoryKeys.some((key) => key.includes(API_NAMESPACE) || key.includes(WEB_NAMESPACE))).toBe(false)
  })
})
