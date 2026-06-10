// SIG-172: KV serdes for the per-repo scoped-rules manifest. Mirrors
// the shape of `repo-index-manifest.ts` (separate key, same KV
// namespace) so the indexer can write/read both without juggling
// distinct stores.
//
// Key shape: `repo-index-rules:<owner>/<repo>` (lowercased), tracking
// the same multi-tenant convention SIG-132 established for the index
// manifest. TTL aligned with the manifest's 60-day TTL so a stale-
// indexer-but-fresh-rules combination can't exist beyond the manifest's
// own validity window.

import type { Env } from "@/src/shared/types/env"
import {
  buildScopedRulesManifest,
  type ScopedRulesManifest,
  type CompiledScopedRulesManifest,
  compileScopedRulesManifest,
} from "./scoped-rules"

const KV_KEY_PREFIX = "repo-index-rules:"
const TTL_SECONDS = 60 * 24 * 60 * 60 // 60 days — aligned with repo-index-manifest TTL.

export function scopedRulesKey(owner: string, repo: string): string {
  return `${KV_KEY_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}`
}

export type ReadResult =
  | { kind: "ok"; manifest: ScopedRulesManifest }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "json-parse" | "shape" }
  | { kind: "kv-error"; err: string }

function isScopedRulesManifest(value: unknown): value is ScopedRulesManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (!Array.isArray(o.perDirectoryRules)) return false
  if (!Array.isArray(o.globRules)) return false
  for (const entry of o.perDirectoryRules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
    const e = entry as Record<string, unknown>
    if (typeof e.dirPath !== "string") return false
    if (typeof e.body !== "string") return false
  }
  for (const entry of o.globRules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
    const e = entry as Record<string, unknown>
    if (typeof e.rulePath !== "string" || e.rulePath.length === 0) return false
    if (e.glob !== null && typeof e.glob !== "string") return false
    if (typeof e.body !== "string") return false
  }
  return true
}

/**
 * Read + validate the scoped-rules manifest from KV. Tagged result so
 * the caller (the ensemble) can decide to log + fall through to an
 * empty manifest without breaking the review on a malformed record.
 *
 * SIG-172 H3 (fix-up): the KV `get` itself can throw (transient
 * Cloudflare KV outage, auth rotation, etc.). Catch + tag as
 * `kv-error` so the loader can fall through to an empty manifest
 * without erroring the whole review — scoped rules are additive
 * context, so a missing/invalid/unreadable record must NEVER fail
 * the review.
 */
export async function readScopedRulesManifest(
  env: Env,
  owner: string,
  repo: string,
): Promise<ReadResult> {
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(scopedRulesKey(owner, repo))
  } catch (err) {
    return { kind: "kv-error", err: err instanceof Error ? err.message : String(err) }
  }
  if (raw === null) return { kind: "missing" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "invalid", reason: "json-parse" }
  }
  if (!isScopedRulesManifest(parsed)) {
    return { kind: "invalid", reason: "shape" }
  }
  return { kind: "ok", manifest: parsed }
}

/**
 * Convenience: read + compile to matcher-ready form. Returns an empty
 * compiled manifest when the record is missing, invalid, or
 * unreadable (KV throw) so the orchestrator can treat the "no scoped
 * rules" path uniformly. KV-error AND invalid-record cases emit
 * telemetry so dashboards can surface persistent KV trouble (kv-error)
 * OR a poisoned/malformed record (invalid) even though the review
 * didn't fail. Without the invalid-branch warning, a corrupted record
 * silently degrades to "no scoped rules" with no audit trail.
 */
export async function loadCompiledScopedRulesManifest(
  env: Env,
  owner: string,
  repo: string,
): Promise<CompiledScopedRulesManifest> {
  const result = await readScopedRulesManifest(env, owner, repo)
  if (result.kind === "ok") {
    return compileScopedRulesManifest(result.manifest)
  }
  if (result.kind === "kv-error") {
    console.warn(JSON.stringify({
      event: "scoped-rules-manifest-read-failed",
      owner, repo,
      err: result.err,
    }))
  } else if (result.kind === "invalid") {
    console.warn(JSON.stringify({
      event: "scoped-rules-manifest-invalid",
      owner, repo,
      reason: result.reason,
    }))
  }
  return { perDirectoryRules: [], globRules: [] }
}

/**
 * Write the scoped-rules manifest. Builds + serializes from a flat
 * list of `(path, content)` tuples so the indexer caller doesn't have
 * to know the on-disk shape.
 *
 * Throws on KV failure, matching `writeRepoIndexManifest` semantics:
 * the indexer wraps the call in a best-effort try/catch (scoped rules
 * are additive context — a write failure shouldn't fail the index job
 * because vectors are the load-bearing artifact).
 */
export async function writeScopedRulesManifest(
  env: Env,
  owner: string,
  repo: string,
  entries: ReadonlyArray<{ path: string; content: string }>,
): Promise<ScopedRulesManifest> {
  const manifest = buildScopedRulesManifest(entries)
  await env.OPENCLAW_STATE.put(
    scopedRulesKey(owner, repo),
    JSON.stringify(manifest),
    { expirationTtl: TTL_SECONDS },
  )
  return manifest
}

/**
 * Delete the scoped-rules manifest. Called from the uninstall path
 * (GDPR delete) alongside the index manifest + vectors deletion.
 */
export async function deleteScopedRulesManifest(
  env: Env,
  owner: string,
  repo: string,
): Promise<void> {
  await env.OPENCLAW_STATE.delete(scopedRulesKey(owner, repo))
}
