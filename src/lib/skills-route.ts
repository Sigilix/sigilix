// SIG-561 — catalog plus installation-admin skill policy routes. Skill text is
// compiled server-side; these routes expose provenance and default-off policy,
// never instruction bodies, package code, secrets, or provider credentials.

import { authenticateMcpOrgAdmin } from "@/src/do/mcp/org-routes"
import {
  GOVERNED_SKILL_CATALOG,
  configureSkillPolicy,
  governedSkillById,
  publicSkillManifest,
  readSkillPolicies,
  revokeSkillPolicy,
  validateRequestedSkillPolicy,
  type StoredSkillPolicy,
} from "@/src/features/skills"
import { handlePortalPreflight, hasJsonContentType, withPortalCors } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 16 * 1024
const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

type SkillPath = { installationId: number; skillId?: string } | "invalid" | null

export async function tryHandleSkillRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const path = parseSkillPath(url.pathname)
  const matchesCatalog = url.pathname === "/v1/skills/catalog"
  if (request.method === "OPTIONS" && (matchesCatalog || path !== null)) {
    return handlePortalPreflight(request, env)
  }
  if (matchesCatalog && request.method === "GET") {
    return withPortalCors(request, catalogResponse(), env)
  }
  if (path === "invalid") return withPortalCors(request, json({ error: "invalid installation or skill id" }, 400), env)
  if (!path) return null

  let response: Response | null = null
  if (!path.skillId && request.method === "GET") response = await handleList(request, env, ctx, path.installationId)
  if (path.skillId && request.method === "PUT") {
    response = await handleConfigure(request, env, ctx, path.installationId, path.skillId)
  }
  if (path.skillId && request.method === "DELETE") {
    response = await handleRevoke(request, env, ctx, path.installationId, path.skillId)
  }
  return response ? withPortalCors(request, response, env) : null
}

function catalogResponse(): Response {
  return json({
    schemaVersion: 1,
    skills: GOVERNED_SKILL_CATALOG.map(publicSkillManifest),
  })
}

async function handleList(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
): Promise<Response> {
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  const stored = await readSkillPolicies(env, installationId)
  if (stored.status === "unavailable") return json({ error: "skill_policy_unavailable" }, 503)
  const policies = new Map(stored.policies.map((policy) => [policy.skillId, policy]))
  return json({
    schemaVersion: 1,
    skills: GOVERNED_SKILL_CATALOG.map((skill) => ({
      ...publicSkillManifest(skill),
      policy: policies.has(skill.id) ? publicPolicy(policies.get(skill.id)!) : null,
    })),
    invalidPolicyCount: stored.invalidRowCount,
  })
}

async function handleConfigure(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  skillId: string,
): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  const value = await readJsonObject(request)
  if (value instanceof Response) return value
  const policy = validateRequestedSkillPolicy(skillId, value)
  if (!policy.ok) {
    const status = policy.error === "unknown_skill" ? 404 : 400
    return json({ error: policy.error }, status)
  }
  const result = await configureSkillPolicy(env, {
    installationId,
    skillId,
    expectedVersion: policy.expectedVersion,
    enabled: policy.enabled,
    surfaces: policy.surfaces,
    updatedBy: auth.value.creatorSubject,
    nowMs: Date.now(),
  })
  if (result.status === "unavailable") return json({ error: "skill_policy_unavailable" }, 503)
  if (result.status === "conflict") return json({ error: "stale_version" }, 409)
  return json({ policy: publicPolicy(result.policy) })
}

async function handleRevoke(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  skillId: string,
): Promise<Response> {
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  if (!governedSkillById(skillId)) return json({ error: "not found" }, 404)
  const result = await revokeSkillPolicy(env, {
    installationId,
    skillId,
    updatedBy: auth.value.creatorSubject,
    nowMs: Date.now(),
  })
  if (result.status === "unavailable") return json({ error: "skill_policy_unavailable" }, 503)
  if (result.status === "conflict") return json({ error: "not found" }, 404)
  return json({ policy: publicPolicy(result.policy) })
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return json({ error: "payload_too_large" }, 413)
  try {
    const value = JSON.parse(raw) as unknown
    return isPlainObject(value) ? value : json({ error: "invalid json" }, 400)
  } catch {
    return json({ error: "invalid json" }, 400)
  }
}

function parseSkillPath(pathname: string): SkillPath {
  const match = /^\/v1\/org\/([^/]+)\/skills(?:\/([^/]+))?$/.exec(pathname)
  if (!match?.[1]) return null
  let installationToken: string
  let skillId: string | undefined
  try {
    installationToken = decodeURIComponent(match[1])
    skillId = match[2] === undefined ? undefined : decodeURIComponent(match[2])
  } catch {
    return "invalid"
  }
  if (!/^\d+$/.test(installationToken)) return "invalid"
  const installationId = Number(installationToken)
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return "invalid"
  if (skillId !== undefined && !SAFE_SKILL_ID.test(skillId)) return "invalid"
  return { installationId, ...(skillId ? { skillId } : {}) }
}

function publicPolicy(policy: StoredSkillPolicy): Record<string, unknown> {
  return {
    version: policy.version,
    status: policy.status,
    enabled: policy.enabled,
    surfaces: policy.surfaces,
    updatedBy: policy.updatedBy,
    installedAt: policy.installedAt,
    updatedAt: policy.updatedAt,
    revokedAt: policy.revokedAt,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
