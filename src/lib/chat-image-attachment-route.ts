import { getValidGithubToken } from "@/src/lib/github-user-token"
import { requireRuntimePrincipal, type RuntimePrincipal } from "@/src/lib/runtime-principal"
import { userCanAccessInstallation } from "@/src/shared/adapters/github/user-installation-access"
import type { Env } from "@/src/shared/types/env"

const OBJECT_PREFIX = "chat/v1/"
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_BYTES = 6 * 1024 * 1024
const LOGICAL_RETENTION_MS = 23 * 60 * 60 * 1000
const MAX_FILENAME_CHARS = 128
const MAX_ATTACHMENTS_PER_RUN = 4
const SAFE_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type VerifiedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"
type VerifiedVideoMimeType = "video/mp4" | "video/webm"
type VerifiedMimeType = VerifiedImageMimeType | VerifiedVideoMimeType

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
  mimeType: VerifiedImageMimeType
  size: number
  createdAt: string
  expiresAt: string
  installationId?: number
}

export interface VerifiedChatImage extends ChatImageAttachmentDescriptor {
  bytes: Uint8Array
}

export interface ChatVideoAttachmentDescriptor {
  id: string
  filename: string
  mimeType: VerifiedVideoMimeType
  size: number
  createdAt: string
  expiresAt: string
  installationId?: number
}

export interface VerifiedChatVideo extends ChatVideoAttachmentDescriptor {
  bytes: Uint8Array
}

type ChatAttachmentDescriptor = ChatImageAttachmentDescriptor | ChatVideoAttachmentDescriptor
type VerifiedChatAttachment = VerifiedChatImage | VerifiedChatVideo

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
  if (!declaredMimeType) return json({ error: "unsupported_attachment_type" }, 415)
  const bytes = await readBytesCapped(request, maximumBytesForMimeType(declaredMimeType))
  if (bytes === null) return json({ error: "attachment_too_large" }, 413)
  if (bytes.byteLength === 0) return json({ error: "empty_attachment" }, 400)
  const verifiedMimeType = detectAttachmentMimeType(bytes)
  if (!verifiedMimeType || verifiedMimeType !== declaredMimeType) {
    return json({ error: "attachment_signature_mismatch" }, 415)
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
    emitFailure("chat-attachment-upload-failed", error)
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

  let attachment: VerifiedChatAttachment
  try {
    attachment = await loadOneVerifiedAttachment(env.SIGILIX_CHAT_ATTACHMENTS, id, auth.principal.scope, Date.now())
    if (!(await principalMayUseInstallation(auth.principal, env, attachment.installationId))) return unavailable()
  } catch {
    return unavailable()
  }
  return new Response(Uint8Array.from(attachment.bytes).buffer, {
    status: 200,
    headers: {
      "content-type": attachment.mimeType,
      "content-length": String(attachment.size),
      "content-disposition": `inline; filename="${asciiDownloadFilename(attachment.filename)}"`,
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

  let attachment: VerifiedChatAttachment
  try {
    attachment = await loadOneVerifiedAttachment(env.SIGILIX_CHAT_ATTACHMENTS, id, auth.principal.scope, Date.now())
    if (!(await principalMayUseInstallation(auth.principal, env, attachment.installationId))) return unavailable()
  } catch {
    return unavailable()
  }
  try {
    await env.SIGILIX_CHAT_ATTACHMENTS.delete(objectKey(id))
  } catch (error) {
    emitFailure("chat-attachment-delete-failed", error)
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
    const image = await loadOneVerifiedAttachment(env.SIGILIX_CHAT_ATTACHMENTS, id, args.creator, args.nowMs)
    if (!isVerifiedChatImage(image)) throw new ChatImageAttachmentError()
    if (image.installationId !== undefined && image.installationId !== args.installationId) {
      throw new ChatImageAttachmentError()
    }
    totalBytes += image.size
    if (totalBytes > MAX_IMAGE_BYTES) throw new ChatImageAttachmentError()
    images.push(image)
  }
  return images
}

/** Load one creator-bound, installation-pinned video for a research run. */
export async function loadVerifiedChatVideo(
  env: Pick<Env, "SIGILIX_CHAT_ATTACHMENTS">,
  args: { id: string; creator: string; installationId?: number; nowMs: number },
): Promise<VerifiedChatVideo> {
  if (!env.SIGILIX_CHAT_ATTACHMENTS || !SAFE_ATTACHMENT_ID.test(args.id)) throw new ChatImageAttachmentError()
  const video = await loadOneVerifiedAttachment(env.SIGILIX_CHAT_ATTACHMENTS, args.id, args.creator, args.nowMs)
  if (!isVerifiedChatVideo(video)) throw new ChatImageAttachmentError()
  if (video.installationId !== undefined && video.installationId !== args.installationId) {
    throw new ChatImageAttachmentError()
  }
  return video
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

export function validVideoAttachmentId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ATTACHMENT_ID.test(value)
}

async function loadOneVerifiedAttachment(
  bucket: R2Bucket,
  id: string,
  creator: string,
  nowMs: number,
): Promise<VerifiedChatAttachment> {
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
  if (metadata.size <= 0 || metadata.size > maximumBytesForMimeType(metadata.mimeType)) {
    throw new ChatImageAttachmentError()
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await object.arrayBuffer())
  } catch {
    throw new ChatImageAttachmentError()
  }
  if (
    bytes.byteLength !== metadata.size ||
    detectAttachmentMimeType(bytes) !== metadata.mimeType ||
    (await sha256Hex(bytes)) !== metadata.sha256
  ) {
    throw new ChatImageAttachmentError()
  }
  const descriptor = publicDescriptor(id, metadata)
  return isVideoMimeType(descriptor.mimeType) ? { ...descriptor, bytes } : { ...descriptor, bytes }
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
  return value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp" ||
    value === "video/mp4" ||
    value === "video/webm"
    ? value
    : null
}

function detectAttachmentMimeType(bytes: Uint8Array): VerifiedMimeType | null {
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
  if (isIsoBmffMp4(bytes)) return "video/mp4"
  if (isWebm(bytes)) return "video/webm"
  return null
}

function safeFilename(raw: string | null, mimeType: VerifiedMimeType): string {
  const fallback =
    mimeType === "image/jpeg"
      ? "image.jpg"
      : `${mimeType.startsWith("video/") ? "video" : "image"}.${mimeType.split("/")[1]}`
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
    size > maximumBytesForMimeType(mimeType) ||
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

function publicDescriptor(id: string, metadata: StoredMetadata): ChatAttachmentDescriptor {
  const common = {
    id,
    filename: metadata.filename,
    size: metadata.size,
    createdAt: new Date(metadata.createdAtMs).toISOString(),
    expiresAt: new Date(metadata.expiresAtMs).toISOString(),
    ...(metadata.installationId !== undefined ? { installationId: metadata.installationId } : {}),
  }
  return isVideoMimeType(metadata.mimeType)
    ? { ...common, mimeType: metadata.mimeType }
    : { ...common, mimeType: metadata.mimeType }
}

function maximumBytesForMimeType(mimeType: VerifiedMimeType): number {
  return mimeType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
}

function isVerifiedChatImage(attachment: VerifiedChatAttachment): attachment is VerifiedChatImage {
  return attachment.mimeType.startsWith("image/")
}

function isVerifiedChatVideo(attachment: VerifiedChatAttachment): attachment is VerifiedChatVideo {
  return isVideoMimeType(attachment.mimeType)
}

function isVideoMimeType(mimeType: VerifiedMimeType): mimeType is VerifiedVideoMimeType {
  return mimeType === "video/mp4" || mimeType === "video/webm"
}

function isIsoBmffMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || ascii(bytes, 4, 8) !== "ftyp") return false
  const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  if (boxSize < 20 || boxSize > bytes.length || boxSize % 4 !== 0) return false
  const mp4Brands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V "])
  if (mp4Brands.has(ascii(bytes, 8, 12))) return true
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (mp4Brands.has(ascii(bytes, offset, offset + 4))) return true
  }
  return false
}

function isWebm(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    return false
  }
  const limit = Math.min(bytes.length - 6, 4 * 1024)
  for (let offset = 4; offset <= limit; offset += 1) {
    if (
      bytes[offset] === 0x42 &&
      bytes[offset + 1] === 0x82 &&
      bytes[offset + 2] === 0x84 &&
      ascii(bytes, offset + 3, offset + 7).toLowerCase() === "webm"
    ) {
      return true
    }
  }
  return false
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end))
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
