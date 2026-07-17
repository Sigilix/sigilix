import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleDeleteChatImageAttachment,
  handleGetChatImageAttachment,
  handleUploadChatImageAttachment,
  loadVerifiedChatImages,
} from "@/src/lib/chat-image-attachment-route"
import type { Env } from "@/src/shared/types/env"

const authState = vi.hoisted(() => ({
  principal: { kind: "tenant" as const, scope: "tenant:99", installationId: 99 },
}))

vi.mock("@/src/lib/runtime-principal", () => ({
  requireRuntimePrincipal: vi.fn(async () => ({ principal: authState.principal })),
}))

interface StoredObject {
  bytes: Uint8Array
  customMetadata: Record<string, string>
  contentType: string | undefined
}

function makeR2(): { bucket: R2Bucket; objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>()
  const bucket = {
    put: async (
      key: string,
      value: ArrayBuffer | ArrayBufferView,
      options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) => {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value.slice(0))
          : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      const stored = {
        bytes,
        customMetadata: { ...(options?.customMetadata ?? {}) },
        contentType: options?.httpMetadata?.contentType,
      }
      objects.set(key, stored)
      return objectFor(key, stored)
    },
    get: async (key: string) => {
      const stored = objects.get(key)
      return stored ? objectFor(key, stored) : null
    },
    delete: async (key: string) => {
      objects.delete(key)
    },
  } as unknown as R2Bucket
  return { bucket, objects }
}

function objectFor(key: string, stored: StoredObject): R2ObjectBody {
  return {
    key,
    version: "v1",
    size: stored.bytes.byteLength,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date(),
    checksums: {},
    storageClass: "Standard",
    customMetadata: { ...stored.customMetadata },
    httpMetadata: { contentType: stored.contentType },
    body: new Blob([stored.bytes.slice().buffer as ArrayBuffer]).stream(),
    bodyUsed: false,
    arrayBuffer: async () => stored.bytes.slice().buffer,
    text: async () => new TextDecoder().decode(stored.bytes),
    json: async <T>() => JSON.parse(new TextDecoder().decode(stored.bytes)) as T,
    blob: async () =>
      new Blob(
        [stored.bytes.slice().buffer as ArrayBuffer],
        stored.contentType ? { type: stored.contentType } : undefined,
      ),
    writeHttpMetadata: () => undefined,
    range: undefined,
    ssecKeyMd5: undefined,
  } as unknown as R2ObjectBody
}

function pngBytes(): Uint8Array {
  return Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)
}

function request(
  method: "POST" | "GET" | "DELETE",
  path = "/v1/chat/attachments",
  body?: Uint8Array,
  contentType = "image/png",
): Request {
  const init: RequestInit = {
    method,
    ...(body ? { headers: { "content-type": contentType }, body: body.slice().buffer as ArrayBuffer } : {}),
  }
  return new Request(`https://api.sigilix.ai${path}`, init)
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext

describe("chat image attachment route", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"))
    authState.principal = { kind: "tenant", scope: "tenant:99", installationId: 99 }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("uploads a verified image and returns it only to the exact creator", async () => {
    const r2 = makeR2()
    const env = { SIGILIX_CHAT_ATTACHMENTS: r2.bucket } as unknown as Env
    const uploaded = await handleUploadChatImageAttachment(
      request("POST", "/v1/chat/attachments?filename=diagram.png", pngBytes()),
      env,
      ctx,
    )

    expect(uploaded.status).toBe(201)
    const descriptor = (await uploaded.json()) as { id: string; filename: string; mimeType: string; expiresAt: string }
    expect(descriptor).toMatchObject({ filename: "diagram.png", mimeType: "image/png" })
    expect(descriptor.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(descriptor.expiresAt).toBe("2026-07-17T11:00:00.000Z")

    const fetched = await handleGetChatImageAttachment(
      request("GET", `/v1/chat/attachments/${descriptor.id}`),
      env,
      ctx,
      descriptor.id,
    )
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get("content-type")).toBe("image/png")
    expect(fetched.headers.get("cache-control")).toBe("private, no-store")
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(pngBytes())

    authState.principal = { kind: "tenant", scope: "tenant:100", installationId: 100 }
    const hidden = await handleGetChatImageAttachment(
      request("GET", `/v1/chat/attachments/${descriptor.id}`),
      env,
      ctx,
      descriptor.id,
    )
    expect(hidden.status).toBe(404)
    await expect(hidden.json()).resolves.toEqual({ error: "attachment_unavailable" })
  })

  it("rejects an oversized or signature-mismatched upload before writing", async () => {
    const r2 = makeR2()
    const env = { SIGILIX_CHAT_ATTACHMENTS: r2.bucket } as unknown as Env
    const tooLarge = new Request("https://api.sigilix.ai/v1/chat/attachments?filename=large.png", {
      method: "POST",
      headers: { "content-type": "image/png", "content-length": String(8 * 1024 * 1024 + 1) },
      body: pngBytes().slice().buffer,
    })
    expect((await handleUploadChatImageAttachment(tooLarge, env, ctx)).status).toBe(413)

    const mismatch = await handleUploadChatImageAttachment(
      request("POST", "/v1/chat/attachments?filename=fake.jpg", pngBytes(), "image/jpeg"),
      env,
      ctx,
    )
    expect(mismatch.status).toBe(415)
    expect(r2.objects.size).toBe(0)
  })

  it("fails closed for an expired or digest-corrupt object", async () => {
    const r2 = makeR2()
    const env = { SIGILIX_CHAT_ATTACHMENTS: r2.bucket } as unknown as Env
    const uploaded = await handleUploadChatImageAttachment(
      request("POST", "/v1/chat/attachments?filename=proof.png", pngBytes()),
      env,
      ctx,
    )
    const { id } = (await uploaded.json()) as { id: string }
    const key = `chat/v1/${id}`
    const stored = r2.objects.get(key)!
    const last = stored.bytes.length - 1
    stored.bytes[last] = stored.bytes[last]! ^ 0xff
    await expect(
      loadVerifiedChatImages(env, { ids: [id], creator: "tenant:99", installationId: 99, nowMs: Date.now() }),
    ).rejects.toMatchObject({ code: "attachment_unavailable" })

    stored.bytes = pngBytes()
    vi.setSystemTime(new Date("2026-07-17T11:00:00.000Z"))
    const expired = await handleGetChatImageAttachment(request("GET", `/v1/chat/attachments/${id}`), env, ctx, id)
    expect(expired.status).toBe(404)
  })

  it("deletes immediately and returns unavailable when the binding is absent", async () => {
    const r2 = makeR2()
    const env = { SIGILIX_CHAT_ATTACHMENTS: r2.bucket } as unknown as Env
    const uploaded = await handleUploadChatImageAttachment(
      request("POST", "/v1/chat/attachments?filename=remove.png", pngBytes()),
      env,
      ctx,
    )
    const { id } = (await uploaded.json()) as { id: string }
    const deleted = await handleDeleteChatImageAttachment(request("DELETE", `/v1/chat/attachments/${id}`), env, ctx, id)
    expect(deleted.status).toBe(200)
    expect(r2.objects.size).toBe(0)

    const absent = await handleUploadChatImageAttachment(
      request("POST", "/v1/chat/attachments?filename=x.png", pngBytes()),
      {} as Env,
      ctx,
    )
    expect(absent.status).toBe(503)
  })
})
