// SIG-382: the only IO in the config surface — fetch `sigilix.json`
// from GitHub + parse it. Carved out of the `src/lib/sigilix-config.ts`
// god-file. The shim at `src/lib/sigilix-config.ts` re-exports both
// functions for the existing importers.
// See docs/superpowers/plans/2026-06-09-sig-382-config-split.md.

import type { GitHubClient } from "@/shared/adapters/github"
import { parseSigilixConfig } from "@/shared/domain/config/parse"
import {
  EMPTY_CONFIG,
  SIGILIX_CONFIG_PATH,
  type SigilixConfig,
} from "@/shared/domain/config/types"

/**
 * Fetch and parse the per-repo `sigilix.json` config at the given ref.
 * Always resolves — never throws — so the caller can rely on the
 * return value. Returns `EMPTY_CONFIG` on any of:
 *   - file missing (GitHub 404 → getFileContent returns null)
 *   - file empty / not text
 *   - JSON malformed
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
  let raw: string | null
  try {
    raw = await client.getFileContent(owner, repo, SIGILIX_CONFIG_PATH, ref)
  } catch {
    return EMPTY_CONFIG
  }
  if (raw === null || raw.trim().length === 0) return EMPTY_CONFIG
  const parsed = parseSigilixConfig(raw)
  return parsed ?? EMPTY_CONFIG
}

/**
 * ARC-185: fetch the raw `sigilix.json` text without parsing. Used
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
  try {
    const raw = await client.getFileContent(owner, repo, SIGILIX_CONFIG_PATH, ref)
    if (raw === null || raw.trim().length === 0) return null
    return raw
  } catch {
    return null
  }
}
