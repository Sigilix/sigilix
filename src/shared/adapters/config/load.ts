// SIG-382: the only IO in the config surface — fetch repo config
// from GitHub + parse it. Carved out of the `src/lib/sigilix-config.ts`
// god-file. The shim at `src/lib/sigilix-config.ts` re-exports both
// functions for the existing importers.
// See docs/superpowers/plans/2026-06-09-sig-382-config-split.md.

import type { GitHubClient } from "@/src/shared/adapters/github"
import { parseSigilixConfigSource } from "@/src/shared/domain/config/parse"
import {
  EMPTY_CONFIG,
  SIGILIX_CONFIG_PATHS,
  SIGILIX_CONFIG_PATH_YAML,
  SIGILIX_CONFIG_PATH_YML,
  type SigilixConfig,
  type SigilixConfigFormat,
  type SigilixConfigPath,
  type SigilixConfigSource,
} from "@/src/shared/domain/config/types"

function formatForPath(path: SigilixConfigPath): SigilixConfigFormat {
  return path === SIGILIX_CONFIG_PATH_YAML || path === SIGILIX_CONFIG_PATH_YML ? "yaml" : "json"
}

/**
 * Fetch the first supported per-repo Sigilix config at the given ref.
 * Precedence is intentionally JSON first for backwards compatibility:
 * `sigilix.json` → `sigilix.yaml` → `sigilix.yml`.
 *
 * Never throws — returns null on missing file, empty file, or fetch
 * failure. The caller owns parsing so command handlers can preserve
 * the raw source for parse-error comments.
 */
export async function loadSigilixConfigSource(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<SigilixConfigSource | null> {
  for (const path of SIGILIX_CONFIG_PATHS) {
    let raw: string | null
    try {
      raw = await client.getFileContent(owner, repo, path, ref)
    } catch {
      // `getFileContent` returns null for 404. A throw means the higher-priority
      // config may exist but failed to read, so do not silently fall through to
      // a lower-priority path with different review behavior.
      return null
    }
    if (typeof raw !== "string" || raw.trim().length === 0) continue
    return { path, format: formatForPath(path), raw }
  }
  return null
}

/**
 * Fetch and parse the per-repo Sigilix config at the given ref.
 * Always resolves — never throws — so the caller can rely on the
 * return value. Returns `EMPTY_CONFIG` on any of:
 *   - file missing (GitHub 404 → getFileContent returns null)
 *   - file empty / not text
 *   - JSON/YAML malformed
 *   - structurally wrong (top-level array, etc.)
 *
 * Callers that want to know whether the config was actually present
 * should compare the result identity with `EMPTY_CONFIG` (it returns
 * the singleton on the missing/error paths and a fresh object only
 * when at least one valid field was extracted).
 */
export async function loadSigilixConfig(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<SigilixConfig> {
  const source = await loadSigilixConfigSource(client, owner, repo, ref)
  if (source === null) return EMPTY_CONFIG
  const parsed = parseSigilixConfigSource(source)
  return parsed.ok ? parsed.config : EMPTY_CONFIG
}

/**
 * ARC-185: fetch the raw Sigilix config text without parsing. Used
 * by the slash-command dispatch path to feed `parseSigilixConfigDetailed`
 * (which preserves the raw text alongside parse errors so the
 * resulting PR comment can show a snippet). Never throws — returns
 * null on missing file or fetch failure.
 */
export async function loadSigilixConfigRaw(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const source = await loadSigilixConfigSource(client, owner, repo, ref)
  return source?.raw ?? null
}
