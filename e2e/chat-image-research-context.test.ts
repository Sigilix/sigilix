import { afterEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { CREATOR_HEADER, DeepResearchDO } from "@/src/do/deep-research/deep-research-do"
import type { VerifiedChatImage } from "@/src/lib/chat-image-attachment-route"
import type { ResearchModelFn } from "@/src/do/deep-research/model"
import type { Env } from "@/src/shared/types/env"
import worker from "@/src/index"

const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(21))
const SESSION_COOKIE = "__Host-sigilix_session"
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext

function makeKv(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = values.get(key)
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace
}

function makeR2(): R2Bucket {
  const objects = new Map<
    string,
    { bytes: Uint8Array; customMetadata: Record<string, string>; contentType: string | undefined }
  >()
  return {
    put: async (
      key: string,
      value: ArrayBuffer | ArrayBufferView,
      options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) => {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value.slice(0))
          : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      objects.set(key, {
        bytes,
        customMetadata: { ...(options?.customMetadata ?? {}) },
        contentType: options?.httpMetadata?.contentType,
      })
      return null
    },
    get: async (key: string) => {
      const stored = objects.get(key)
      if (!stored) return null
      return {
        key,
        version: "v1",
        size: stored.bytes.byteLength,
        customMetadata: { ...stored.customMetadata },
        httpMetadata: { contentType: stored.contentType },
        arrayBuffer: async () => stored.bytes.slice().buffer,
      } as unknown as R2ObjectBody
    },
    delete: async (key: string) => void objects.delete(key),
  } as unknown as R2Bucket
}

function makePlatformDb(linkedInstallationId: number): D1Database {
  return {
    prepare: (query: string) => {
      const statement = {
        bind: () => statement,
        all: async () => ({
          results: query.includes("FROM account_tenant") ? [{ installation_id: linkedInstallationId }] : [],
          success: true,
          meta: {},
        }),
        first: async () => (query.includes("FROM user_identity") ? { user_id: "user-42", github_user_id: "42" } : null),
        run: async () => ({ results: [], success: true, meta: {} }),
      }
      return statement
    },
  } as unknown as D1Database
}

function makeDoState(): DurableObjectState {
  const values = new Map<string, unknown>()
  return {
    id: { toString: () => "image-context-run" },
    waitUntil: () => undefined,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void values.set(key, value),
      delete: async (key: string) => values.delete(key),
      deleteAll: async () => void values.clear(),
      setAlarm: async () => undefined,
      list: async <T>(options?: { prefix?: string }) =>
        new Map([...values.entries()].filter(([key]) => key.startsWith(options?.prefix ?? "")) as Array<[string, T]>),
    },
  } as unknown as DurableObjectState
}

function pngBytes(): Uint8Array {
  return Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4)
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
}

async function upload(env: Env, sessionId: string): Promise<string> {
  const response = await worker.fetch(
    new Request("https://api.sigilix.ai/v1/chat/attachments?filename=architecture.png", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        origin: "https://app.sigilix.ai",
      },
      body: pngBytes().slice().buffer,
    }),
    env,
    ctx,
  )
  expect(response.status).toBe(201)
  expect(response.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
  return ((await response.json()) as { id: string }).id
}

function installResearch(env: Env, research: DeepResearchDO): void {
  env.DEEP_RESEARCH = {
    newUniqueId: () => ({ toString: () => "image-context-run" }),
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => research.fetch(new Request(input, init)),
    }),
  } as unknown as DurableObjectNamespace
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("portal image attachment to research model context", () => {
  it("preflights the binary upload and rechecks exact installation access on read", async () => {
    const kv = makeKv()
    await createSession({
      kv,
      sessionId: "scoped-session",
      login: "alice",
      githubUserId: 42,
      userId: "user-42",
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_CHAT_ATTACHMENTS: makeR2(),
      // This stale legacy link is valid for metering attribution only. It must
      // never restore attachment access after GitHub revokes the installation.
      SIGILIX_PLATFORM_DB: makePlatformDb(99),
    } as unknown as Env

    const preflight = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/chat/attachments", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.sigilix.ai",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
      env,
      ctx,
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")

    let hasAccess = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ installations: hasAccess ? [{ id: 99 }] : [] })),
    )
    const uploaded = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/chat/attachments?filename=scoped.png&installationId=99", {
        method: "POST",
        headers: { "content-type": "image/png", cookie: `${SESSION_COOKIE}=scoped-session` },
        body: pngBytes().slice().buffer,
      }),
      env,
      ctx,
    )
    expect(uploaded.status).toBe(201)
    const descriptor = (await uploaded.json()) as { id: string; installationId: number }
    expect(descriptor.installationId).toBe(99)

    hasAccess = false
    const revoked = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/chat/attachments/${descriptor.id}`, {
        headers: { cookie: `${SESSION_COOKIE}=scoped-session` },
      }),
      env,
      ctx,
    )
    expect(revoked.status).toBe(404)
    await expect(revoked.json()).resolves.toEqual({ error: "attachment_unavailable" })

    const research = new DeepResearchDO(makeDoState(), env)
    const analyzeImages = vi.fn(async () => ({ text: "must not run", attachments: [], tokens: 1 }))
    const model = vi.fn<ResearchModelFn>(async () => ({ text: "must not run", tokens: 1 }))
    research.setTestHooks({ analyzeImages, model })
    installResearch(env, research)
    const created = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/research", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=scoped-session` },
        body: JSON.stringify({
          question: "What is shown?",
          mode: "chat",
          installationId: 99,
          imageAttachmentIds: [descriptor.id],
        }),
      }),
      env,
      ctx,
    )
    expect(created.status).toBe(200)
    await (research as unknown as { driveDone: Promise<void> }).driveDone
    const events = await readSse(
      await research.fetch(
        new Request("https://deep-research.do/stream", { headers: { [CREATOR_HEADER]: "session:42" } }),
      ),
    )
    expect(analyzeImages).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: "error", message: "attachment_unavailable" })
  })

  it("loads the exact creator's image, analyzes it once, and preserves its citation", async () => {
    const kv = makeKv()
    await createSession({
      kv,
      sessionId: "alice-session",
      login: "alice",
      githubUserId: 42,
      accessToken: "unused-token",
      encryptionKeyB64url: ENC_KEY,
    })
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_CHAT_ATTACHMENTS: makeR2(),
    } as unknown as Env
    const id = await upload(env, "alice-session")
    const research = new DeepResearchDO(makeDoState(), env)
    const analyzeImages = vi.fn(async ({ images }: { images: VerifiedChatImage[] }) => {
      expect(images).toHaveLength(1)
      expect(images[0]?.id).toBe(id)
      expect(images[0]?.bytes).toEqual(pngBytes())
      return {
        text: `The image is an architecture diagram [attachment:${id}].`,
        attachments: images.map(({ bytes: _bytes, ...descriptor }) => descriptor),
        tokens: 7,
        costUsd: 0.01,
      }
    })
    const model = vi.fn<ResearchModelFn>(async (_role, messages) => {
      const packed = messages.map((message) => message.content).join("\n")
      expect(packed).toContain("BEGIN_UNTRUSTED_IMAGE_EVIDENCE")
      expect(packed).toContain(`[attachment:${id}]`)
      return { text: `It shows an architecture diagram [attachment:${id}].`, tokens: 5 }
    })
    research.setTestHooks({ analyzeImages, model })
    installResearch(env, research)

    const created = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/research", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=alice-session` },
        body: JSON.stringify({
          question: "What does this diagram show?",
          mode: "chat",
          imageAttachmentIds: [id],
        }),
      }),
      env,
      ctx,
    )
    expect(created.status).toBe(200)
    await (research as unknown as { driveDone: Promise<void> }).driveDone
    const events = await readSse(
      await research.fetch(
        new Request("https://deep-research.do/stream", { headers: { [CREATOR_HEADER]: "session:42" } }),
      ),
    )
    expect(analyzeImages).toHaveBeenCalledTimes(1)
    expect(events.find((event) => event.type === "note")?.text).toContain("Analyzed 1 attached image")
    expect(events.find((event) => event.type === "final")?.markdown).toBe(
      `It shows an architecture diagram [attachment:${id}].`,
    )
  })

  it("fails the whole run closed when an attachment belongs to another creator", async () => {
    const kv = makeKv()
    await createSession({
      kv,
      sessionId: "alice-session",
      login: "alice",
      githubUserId: 42,
      accessToken: "unused-token",
      encryptionKeyB64url: ENC_KEY,
    })
    await createSession({
      kv,
      sessionId: "bob-session",
      login: "bob",
      githubUserId: 43,
      accessToken: "unused-token",
      encryptionKeyB64url: ENC_KEY,
    })
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_CHAT_ATTACHMENTS: makeR2(),
    } as unknown as Env
    const id = await upload(env, "alice-session")
    const research = new DeepResearchDO(makeDoState(), env)
    const analyzeImages = vi.fn(async () => ({ text: "must not run", attachments: [], tokens: 1 }))
    const model = vi.fn<ResearchModelFn>(async () => ({ text: "must not run", tokens: 1 }))
    research.setTestHooks({ analyzeImages, model })
    installResearch(env, research)

    const created = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/research", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=bob-session` },
        body: JSON.stringify({ question: "What is shown?", mode: "chat", imageAttachmentIds: [id] }),
      }),
      env,
      ctx,
    )
    expect(created.status).toBe(200)
    await (research as unknown as { driveDone: Promise<void> }).driveDone
    const events = await readSse(
      await research.fetch(
        new Request("https://deep-research.do/stream", { headers: { [CREATOR_HEADER]: "session:43" } }),
      ),
    )
    expect(analyzeImages).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: "error", message: "attachment_unavailable" })
    expect(events.at(-1)).toEqual({ type: "done" })
  })

  it("reports an image-analysis outage without mislabeling the verified upload", async () => {
    const kv = makeKv()
    await createSession({
      kv,
      sessionId: "alice-session",
      login: "alice",
      githubUserId: 42,
      accessToken: "unused-token",
      encryptionKeyB64url: ENC_KEY,
    })
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_CHAT_ATTACHMENTS: makeR2(),
    } as unknown as Env
    const id = await upload(env, "alice-session")
    const research = new DeepResearchDO(makeDoState(), env)
    const analyzeImages = vi.fn(async () => {
      throw new Error("provider unavailable")
    })
    const model = vi.fn<ResearchModelFn>(async () => ({ text: "must not run", tokens: 1 }))
    research.setTestHooks({ analyzeImages, model })
    installResearch(env, research)

    const created = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/research", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=alice-session` },
        body: JSON.stringify({ question: "What is shown?", mode: "chat", imageAttachmentIds: [id] }),
      }),
      env,
      ctx,
    )
    expect(created.status).toBe(200)
    await (research as unknown as { driveDone: Promise<void> }).driveDone
    const events = await readSse(
      await research.fetch(
        new Request("https://deep-research.do/stream", { headers: { [CREATOR_HEADER]: "session:42" } }),
      ),
    )
    expect(analyzeImages).toHaveBeenCalledTimes(1)
    expect(model).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: "error", message: "attachment_analysis_failed" })
    expect(events.at(-1)).toEqual({ type: "done" })
  })
})
