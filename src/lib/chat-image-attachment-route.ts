import { getValidGithubToken } from "@/src/lib/github-user-token"
import { requireRuntimePrincipal, type RuntimePrincipal } from "@/src/lib/runtime-principal"
import { userCanAccessInstallation } from "@/src/shared/adapters/github/user-installation-access"
import type { Env } from "@/src/shared/types/env"

const OBJECT_PREFIX = "chat/v1/"
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const LOGICAL_RETENTION_MS = 23 * 60 * 60 * 1000
const MAX_FILENAME_CHARS = 128
const MAX_ATTACHMENTS_PER_RUN = 4
const SAFE_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type VerifiedMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

interface StoredMetadata {
  creator: string
  installationId?: number
  filename: string
  mimeType: VerifiedMimeType
  size: number
  sha256: string
  createdAtMs: number
  expiresAtMs: number
}

export interface ChatImageAttachmentDescriptor {
  id: string
  filename: string
  mimeType: VerifiedMimeType
  size: number
  createdAt: string
  expiresAt: string
  installationId?: number
}

export interface VerifiedChatImage extends ChatImageAttachmentDescriptor {
  bytes: Uint8Array
}

export class ChatImageAttachmentError extends Error {
  readonly code = "attachment_unavailable"

  constructor() {
    super("attachment_unavailable")
    this.name = "ChatImageAttachmentError"
  }
}

export function isChatImageAttachmentPath(pathname: string): boolean {
  return pathname === "/v1/chat/attachments" || pathname.startsWith("/v1/chat/attachments/")
}

export async function tryHandleChatImageAttachmentRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/v1/chat/attachments") {
    return handleUploadChatImageAttachment(request, env, ctx)
  }
  const match = /^\/v1\/chat\/attachments\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  // IDs are ASCII UUIDv4 values. Keeping the raw segment makes malformed
  // percent-encoding an ordinary hidden 404 instead of a decode exception.
  const id = match[1]!
  if (request.method === "GET") return handleGetChatImageAttachment(request, env, ctx, id)
  if (request.method === "DELETE") return handleDeleteChatImageAttachment(request, env, ctx, id)
  return null
}

export async function handleUploadChatImageAttachment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.SIGILIX_CHAT_ATTACHMENTS) return json({ error: "attachment_service_unavailable" }, 503)
  const auth = await requireRuntimePrincipal(request, env, ctx)
  if ("response" in auth) return auth.response

  const scope = await resolveUploadScope(request, env, auth.principal)
  if (scope instanceof Response) return scope

  const declaredMimeType = normalizeDeclaredMimeType(request.headers.get("content-type"))
  if (!declaredMimeType) return json({ error: "unsupported_image_type" }, 415)
  const bytes = await readBytesCapped(request, MAX_IMAGE_BYTES)
  if (bytes === null) return json({ error: "attachment_too_large" }, 413)
  if (bytes.byteLength === 0) return json({ error: "empty_attachment" }, 400)
  const verifiedMimeType = detectImageMimeType(bytes)
  if (!verifiedMimeType || verifiedMimeType !== declaredMimeType) {
    return json({ error: "image_signature_mismatch" }, 415)
  }

  const nowMs = Date.now()
  const id = crypto.randomUUID()
  const filename = safeFilename(new URL(request.url).searchParams.get("filename"), verifiedMimeType)
  const sha256 = await sha256Hex(bytes)
  const metadata: StoredMetadata = {
    creator: auth.principal.scope,
    ...(scope.installationId !== undefined ? { installationId: scope.installationId } : {}),
    filename,
    mimeType: verifiedMimeType,
    size: bytes.byteLength,
    sha256,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + LOGICAL_RETENTION_MS,
  }

  try {
    await env.SIGILIX_CHAT_ATTACHMENTS.put(objectKey(id), bytes, {
      httpMetadata: { contentType: verifiedMimeType },
      customMetadata: encodeMetadata(metadata),
    })
  } catch (error) {
    emitFailure("chat-image-attachment-upload-failed", error)
    return json({ error: "attachment_service_unavailable" }, 503)
  }
  return json(publicDescriptor(id, metadata), 201)
}

export async function handleGetChatImageAttachment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  if (!env.SIGILIX_CHAT_ATTACHMENTS) return json({ error: "attachment_service_unavailable" }, 503)
  if (!SAFE_ATTACHMENT_ID.test(id)) return unavailable()
  const auth = await requireRuntimePrincipal(request, env, ctx)
  if ("response" in auth) return auth.response

  let image: VerifiedChatImage
  try {
    image = await loadOneVerifiedImage(env.SIGILIX_CHAT_ATTACHMENTS, id, auth.principal.scope, Date.now())
    if (!(await principalMayUseInstallation(auth.principal, env, image.installationId))) return unavailable()
  } catch {
    return unavailable()
  }
  return new Response(Uint8Array.from(image.bytes).buffer, {
    status: 200,
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.size),
      "content-disposition": `inline; filename="${asciiDownloadFilename(image.filename)}"`,
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    },
  })
}

export async function handleDeleteChatImageAttachment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  if (!env.SIGILIX_CHAT_ATTACHMENTS) return json({ error: "attachment_service_unavailable" }, 503)
  if (!SAFE_ATTACHMENT_ID.test(id)) return unavailable()
  const auth = await requireRuntimePrincipal(request, env, ctx)
  if ("response" in auth) return auth.response

  let image: VerifiedChatImage
  try {
    image = await loadOneVerifiedImage(env.SIGILIX_CHAT_ATTACHMENTS, id, auth.principal.scope, Date.now())
    if (!(await principalMayUseInstallation(auth.principal, env, image.installationId))) return unavailable()
  } catch {
    return unavailable()
  }
  try {
    await env.SIGILIX_CHAT_ATTACHMENTS.delete(objectKey(id))
  } catch (error) {
    emitFailure("chat-image-attachment-delete-failed", error)
    return json({ error: "attachment_service_unavailable" }, 503)
  }
  return json({ ok: true, deleted: true })
}

/**
 * Load a research run's complete image set. Every object is creator-bound,
 * digest-verified, unexpired, and (when organization-scoped) pinned to the
 * run's exact installation. Any bad object fails the whole set closed.
 */
export async function loadVerifiedChatImages(
  env: Pick<Env, "SIGILIX_CHAT_ATTACHMENTS">,
  args: { ids: string[]; creator: string; installationId?: number; nowMs: number },
): Promise<VerifiedChatImage[]> {
  if (!env.SIGILIX_CHAT_ATTACHMENTS || !validAttachmentIds(args.ids)) throw new ChatImageAttachmentError()
  const images: VerifiedChatImage[] = []
  let totalBytes = 0
  for (const id of args.ids) {
    const image = await loadOneVerifiedImage(env.SIGILIX_CHAT_ATTACHMENTS, id, args.creator, args.nowMs)
    if (image.installationId !== undefined && image.installationId !== args.installationId) {
      throw new ChatImageAttachmentError()
    }
    totalBytes += image.size
    if (totalBytes > MAX_IMAGE_BYTES) throw new ChatImageAttachmentError()
    images.push(image)
  }
  return images
}

export function validAttachmentIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ATTACHMENTS_PER_RUN &&
    value.every((id) => typeof id === "string" && SAFE_ATTACHMENT_ID.test(id)) &&
    new Set(value).size === value.length
  )
}

async function loadOneVerifiedImage(
  bucket: R2Bucket,
  id: string,
  creator: string,
  nowMs: number,
): Promise<VerifiedChatImage> {
  if (!SAFE_ATTACHMENT_ID.test(id)) throw new ChatImageAttachmentError()
  let object: R2ObjectBody | null
  try {
    object = await bucket.get(objectKey(id))
  } catch {
    throw new ChatImageAttachmentError()
  }
  if (!object) throw new ChatImageAttachmentError()
  const metadata = decodeMetadata(object.customMetadata)
  if (!metadata || metadata.creator !== creator || metadata.expiresAtMs <= nowMs || object.size !== metadata.size) {
    throw new ChatImageAttachmentError()
  }
  if (metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) throw new ChatImageAttachmentError()
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await object.arrayBuffer())
  } catch {
    throw new ChatImageAttachmentError()
  }
  if (
    bytes.byteLength !== metadata.size ||
    detectImageMimeType(bytes) !== metadata.mimeType ||
    (await sha256Hex(bytes)) !== metadata.sha256
  ) {
    throw new ChatImageAttachmentError()
  }
  return { ...publicDescriptor(id, metadata), bytes }
}

async function resolveUploadScope(
  request: Request,
  env: Env,
  principal: RuntimePrincipal,
): Promise<{ installationId?: number } | Response> {
  const raw = new URL(request.url).searchParams.get("installationId")
  const requested = raw === null || raw === "" ? undefined : Number(raw)
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
    return json({ error: "invalid_installation" }, 400)
  }
  if (principal.kind === "tenant") {
    if (requested !== undefined && requested !== principal.installationId) return json({ error: "forbidden" }, 403)
    return { installationId: principal.installationId }
  }
  if (requested === undefined) return {}
  return (await principalMayUseInstallation(principal, env, requested))
    ? { installationId: requested }
    : json({ error: "forbidden" }, 403)
}

async function principalMayUseInstallation(
  principal: RuntimePrincipal,
  env: Env,
  installationId: number | undefined,
): Promise<boolean> {
  if (installationId === undefined) return principal.kind === "session"
  if (principal.kind === "tenant") return principal.installationId === installationId
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) return false
  try {
    const token = await getValidGithubToken({
      env,
      sessionId: principal.session.sessionId,
      record: principal.session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
    return (await userCanAccessInstallation(token, installationId)).ok
  } catch {
    return false
  }
}

async function readBytesCapped(request: Request, maximum: number): Promise<Uint8Array | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(contentLength) && contentLength > maximum) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function normalizeDeclaredMimeType(raw: string | null): VerifiedMimeType | null {
  const value = raw?.split(";", 1)[0]?.trim().toLowerCase()
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp"
    ? value
    : null
}

function detectImageMimeType(bytes: Uint8Array): VerifiedMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6))
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp"
  }
  return null
}

function safeFilename(raw: string | null, mimeType: VerifiedMimeType): string {
  const fallback = `image.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length)}`
  const normalized = (raw ?? "")
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, MAX_FILENAME_CHARS)
  return normalized || fallback
}

function asciiDownloadFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "image"
}

function encodeMetadata(metadata: StoredMetadata): Record<string, string> {
  return {
    version: "1",
    creator: metadata.creator,
    installationId: metadata.installationId === undefined ? "" : String(metadata.installationId),
    filename: encodeURIComponent(metadata.filename),
    mimeType: metadata.mimeType,
    size: String(metadata.size),
    sha256: metadata.sha256,
    createdAtMs: String(metadata.createdAtMs),
    expiresAtMs: String(metadata.expiresAtMs),
  }
}

function decodeMetadata(raw: Record<string, string> | undefined): StoredMetadata | null {
  if (!raw || raw.version !== "1") return null
  const installationId = raw.installationId === "" ? undefined : Number(raw.installationId)
  const size = Number(raw.size)
  const createdAtMs = Number(raw.createdAtMs)
  const expiresAtMs = Number(raw.expiresAtMs)
  const mimeType = normalizeDeclaredMimeType(raw.mimeType ?? null)
  const sha256 = raw.sha256
  let filename: string
  try {
    filename = decodeURIComponent(raw.filename ?? "")
  } catch {
    return null
  }
  if (
    typeof raw.creator !== "string" ||
    raw.creator.length === 0 ||
    raw.creator.length > 160 ||
    (installationId !== undefined && (!Number.isSafeInteger(installationId) || installationId <= 0)) ||
    !mimeType ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_IMAGE_BYTES ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(createdAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs !== createdAtMs + LOGICAL_RETENTION_MS ||
    filename.length === 0 ||
    filename.length > MAX_FILENAME_CHARS
  ) {
    return null
  }
  return {
    creator: raw.creator,
    ...(installationId !== undefined ? { installationId } : {}),
    filename,
    mimeType,
    size,
    sha256,
    createdAtMs,
    expiresAtMs,
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function publicDescriptor(id: string, metadata: StoredMetadata): ChatImageAttachmentDescriptor {
  return {
    id,
    filename: metadata.filename,
    mimeType: metadata.mimeType,
    size: metadata.size,
    createdAt: new Date(metadata.createdAtMs).toISOString(),
    expiresAt: new Date(metadata.expiresAtMs).toISOString(),
    ...(metadata.installationId !== undefined ? { installationId: metadata.installationId } : {}),
  }
}

function objectKey(id: string): string {
  return `${OBJECT_PREFIX}${id}`
}

function unavailable(): Response {
  return json({ error: "attachment_unavailable" }, 404)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitFailure(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, err: error instanceof Error ? error.name : "unknown" }))
}
