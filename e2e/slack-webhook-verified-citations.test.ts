import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
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
const API_FILE_CONTENT = ["export function canCallApi(role: string): boolean {", '  return role === "admin"', "}"].join(
  "\n",
)
const WEB_FILE_CONTENT = [
  "export function canOpenDashboard(role: string): boolean {",
  '  return role === "member" || role === "admin"',
  "}",
].join("\n")
const ANSWER = "The API requires an admin, while the web dashboard permits members and admins."

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
      text: "<@U0SIGILIX> compare authorization in the API and web dashboard",
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
  chunkId: string
}): RepoIndexManifestV1 {
  return {
    v: 1,
    owner: "acme",
    repo: args.repo,
    namespace: args.namespace,
    githubRepoId: args.githubRepoId,
    defaultBranch: "main",
    headSha: args.headSha,
    runId: args.runId,
    fileCount: 1,
    chunkCount: 1,
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
      byPath: { [FILE_PATH]: [args.chunkId] },
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("signed Slack webhook verified citations", () => {
  it("retrieves and posts two immutable repo-qualified citations for identical paths", async () => {
    const db = await makePlatformDb()
    const kv = makeKv()
    const apiChunkId = await chunkId(API_NAMESPACE, {
      path: FILE_PATH,
      lineStart: 1,
      lineEnd: 3,
      content: API_FILE_CONTENT,
    })
    const webChunkId = await chunkId(WEB_NAMESPACE, {
      path: FILE_PATH,
      lineStart: 1,
      lineEnd: 3,
      content: WEB_FILE_CONTENT,
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
          chunkId: apiChunkId,
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
          chunkId: webChunkId,
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
            path: FILE_PATH,
            lineStart: 1,
            lineEnd: 3,
            content: API_FILE_CONTENT,
            headSha: API_HEAD_SHA,
            runId: API_RUN_ID,
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
      query: vi.fn(async () => ({ matches: [] })),
      upsert: vi.fn(async () => undefined),
      deleteByIds: vi.fn(async () => undefined),
    }
    const ai = {
      run: vi.fn(async () => ({ data: [embedding], shape: [1, embedding.length] })),
    }

    const ollamaBodies: Array<Record<string, unknown>> = []
    const githubPaths: string[] = []
    const slackPosts: Array<Record<string, unknown>> = []
    const observedToolResults: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

      if (url.hostname === "api.github.com") {
        githubPaths.push(`${url.pathname}${url.search}`)
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
        if (url.pathname === `/repos/acme/api/contents/${FILE_PATH}` && url.searchParams.get("ref") === API_HEAD_SHA) {
          return new Response(JSON.stringify({ content: btoa(API_FILE_CONTENT), encoding: "base64" }), {
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
            ],
          })
        }

        const toolMessages = messages.filter((message) => message.role === "tool")
        observedToolResults.push(
          ...toolMessages.map((message) => JSON.parse(String(message.content)) as Record<string, unknown>),
        )
        const citations = observedToolResults.flatMap((result) => {
          const chunks = result.chunks
          if (!Array.isArray(chunks)) return []
          const citation = (chunks[0] as Record<string, unknown> | undefined)?.citation
          return citation ? [citation] : []
        })
        if (citations.length !== 2) {
          throw new Error(
            `retrieve_codebase omitted one of the issued citations: ${JSON.stringify(observedToolResults)}`,
          )
        }
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

    const apiCitation = {
      githubRepoId: API_REPO_ID,
      repo: API_NAMESPACE,
      path: FILE_PATH,
      lineStart: 1,
      lineEnd: 3,
      ref: API_HEAD_SHA,
      runId: API_RUN_ID,
      chunkId: apiChunkId,
    }
    const webCitation = {
      githubRepoId: WEB_REPO_ID,
      repo: WEB_NAMESPACE,
      path: FILE_PATH,
      lineStart: 1,
      lineEnd: 3,
      ref: WEB_HEAD_SHA,
      runId: WEB_RUN_ID,
      chunkId: webChunkId,
    }
    expect(codeIndex.query).toHaveBeenCalledTimes(2)
    expect(codeIndex.query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ namespace: API_NAMESPACE }),
    )
    expect(codeIndex.query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ namespace: WEB_NAMESPACE }),
    )
    expect(observedToolResults).toHaveLength(2)
    expect(observedToolResults[0]).toMatchObject({
      ok: true,
      repo: API_NAMESPACE,
      count: 1,
      chunks: [expect.objectContaining({ citation: expect.objectContaining(apiCitation) })],
    })
    expect(observedToolResults[1]).toMatchObject({
      ok: true,
      repo: WEB_NAMESPACE,
      count: 1,
      chunks: [expect.objectContaining({ citation: expect.objectContaining(webCitation) })],
    })
    expect(ollamaBodies).toHaveLength(2)
    expect(ollamaBodies[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "retrieve_codebase" }) }),
      ]),
    )
    expect(githubPaths).toEqual(
      expect.arrayContaining([
        "/installation/repositories?per_page=100&page=1",
        "/repos/acme/api",
        "/repos/acme/web",
        `/repos/acme/api/contents/${FILE_PATH}?ref=${API_HEAD_SHA}`,
        `/repos/acme/web/contents/${FILE_PATH}?ref=${WEB_HEAD_SHA}`,
      ]),
    )
    expect(githubPaths.filter((path) => path === "/repos/acme/api")).toHaveLength(2)
    expect(githubPaths.filter((path) => path === "/repos/acme/web")).toHaveLength(2)
    expect(kv.get).toHaveBeenCalledWith(repoTenantKey(API_REPO_ID))
    expect(kv.get).toHaveBeenCalledWith(repoTenantKey(WEB_REPO_ID))
    for (const key of mutableManifestKeys) {
      expect(kv.get).toHaveBeenCalledWith(key)
      expect(kv.values.has(key)).toBe(false)
    }

    const apiUrl = `https://github.com/acme/api/blob/${API_HEAD_SHA}/${FILE_PATH}#L1-L3`
    const webUrl = `https://github.com/acme/web/blob/${WEB_HEAD_SHA}/${FILE_PATH}#L1-L3`
    expect(slackPosts).toEqual([
      {
        channel: CHANNEL_ID,
        thread_ts: THREAD_TS,
        text:
          `${ANSWER}\n\nSources:\n` +
          `- <${apiUrl}|acme/api · src/auth.ts:1-3>\n` +
          `- <${webUrl}|acme/web · src/auth.ts:1-3>`,
      },
    ])
    expect(kv.values.has(`slack-event:EvVerifiedCitation`)).toBe(true)
    expect([...kv.values.keys()].some((key) => key.startsWith("agent-loop-telemetry:"))).toBe(true)
  })
})
