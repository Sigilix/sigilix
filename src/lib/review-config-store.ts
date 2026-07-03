// sig-dashboard-review-config: server-side persistence for the portal's review
// configuration, keyed by installation (org scope) and optionally by repo.
//
// STORE CHOICE — KV (`OPENCLAW_STATE`), not D1:
//   The dashboard config is a single opaque `SigilixConfig` blob addressed by a
//   stable key. It is read at most once per review and written rarely (only when
//   an admin saves the dashboard). There is no relational query, no aggregation,
//   no cross-row scan — exactly the key→blob shape KV is for. D1 would demand a
//   forward-only migration and a table for zero benefit. The existing config-
//   parse-error dedupe already persists to OPENCLAW_STATE, so this stays on the
//   same binding.
//
// KEYS (tenant-isolated by construction — the installation id is IN the key, so
// one tenant can never read another's blob):
//   org  : `review-config:<installationId>`
//   repo : `review-config:<installationId>:<repoId>`   (repoId = lowercased `owner/repo`)
//
// VALIDATION: writes go through `parseSigilixConfigDetailed` — the SAME validator
// the committed `sigilix.json` path uses — so a malformed blob is rejected with a
// specific reason and never stored. What we persist is the CANONICAL re-serialized
// parsed config (known fields only), so reads are clean and forward-compatible.
//
// FAIL-SOFT reads: any KV / parse failure resolves to `null` (treated as "no
// dashboard config") so a transient store fault degrades to built-in defaults
// rather than breaking a review.

import type { Env } from "@/src/shared/types/env"
import { parseSigilixConfigDetailed } from "@/src/shared/domain/config/parse"
import type { SigilixConfig } from "@/src/shared/domain/config/types"

const KEY_PREFIX = "review-config:"

/** repoId scope token: lowercased `owner/repo`. Always available in the pipeline
 *  (which addresses the committed file the same way) and human-readable in KV. */
export function repoScopeId(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase()
}

/** KV key for the org-scoped config. */
export function orgConfigKey(installationId: number): string {
  return `${KEY_PREFIX}${installationId}`
}

/** KV key for a repo-scoped config. */
export function repoConfigKey(installationId: number, repoId: string): string {
  return `${KEY_PREFIX}${installationId}:${repoId}`
}

/** Discriminated write result. `reason` is a human-readable parse-error message. */
export type WriteResult = { ok: true; config: SigilixConfig } | { ok: false; reason: string }

/**
 * Validate a raw JSON body against the `SigilixConfig` schema and, on success,
 * persist the canonical serialization to KV. Never throws — a KV write failure
 * surfaces as `{ ok: false }` so the caller returns a real error to the admin
 * instead of a false success.
 */
export async function writeDashboardReviewConfig(
  env: Pick<Env, "OPENCLAW_STATE">,
  installationId: number,
  rawJson: string,
  repoId?: string,
): Promise<WriteResult> {
  const parsed = parseSigilixConfigDetailed(rawJson)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  // Persist the canonical, known-fields-only serialization (not the caller's raw
  // bytes) so reads are clean and unknown keys never round-trip.
  const canonical = JSON.stringify(parsed.config)
  const key = repoId ? repoConfigKey(installationId, repoId) : orgConfigKey(installationId)
  try {
    await env.OPENCLAW_STATE.put(key, canonical)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "review-config-write-failed",
        installationId,
        ...(repoId ? { repoId } : {}),
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, reason: "storage write failed" }
  }
  return { ok: true, config: parsed.config }
}

/**
 * Read a stored dashboard config for the given scope. Returns `null` when absent
 * or on any KV/parse fault (fail-soft → the pipeline falls back to defaults).
 */
export async function readDashboardReviewConfig(
  env: Pick<Env, "OPENCLAW_STATE">,
  installationId: number,
  repoId?: string,
): Promise<SigilixConfig | null> {
  const key = repoId ? repoConfigKey(installationId, repoId) : orgConfigKey(installationId)
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "review-config-read-failed",
        installationId,
        ...(repoId ? { repoId } : {}),
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
  if (raw === null || raw.trim().length === 0) return null
  const parsed = parseSigilixConfigDetailed(raw)
  // A stored blob was written canonically, so a parse failure here means it was
  // corrupted out-of-band — treat as absent rather than surfacing broken config.
  return parsed.ok ? parsed.config : null
}

/** The org + repo dashboard layers for one PR, resolved together for the pipeline. */
export interface DashboardConfigLayers {
  org: SigilixConfig | null
  repo: SigilixConfig | null
}

/**
 * Resolve both dashboard layers (org + repo) for a review. Best-effort: a
 * missing installation id or any read fault yields empty layers so review runs
 * on built-in defaults. The pipeline merges these UNDER the committed file (see
 * `mergeSigilixConfigLayers`).
 */
export async function resolveDashboardConfigLayers(
  env: Pick<Env, "OPENCLAW_STATE">,
  installationId: number | undefined,
  owner: string,
  repo: string,
): Promise<DashboardConfigLayers> {
  if (typeof installationId !== "number" || installationId <= 0) {
    return { org: null, repo: null }
  }
  const repoId = repoScopeId(owner, repo)
  const [org, repoScoped] = await Promise.all([
    readDashboardReviewConfig(env, installationId),
    readDashboardReviewConfig(env, installationId, repoId),
  ])
  return { org, repo: repoScoped }
}
