// Per-repo Sigilix config (ARC-174). Read from `sigilix.json` at the
// PR head SHA via the existing GitHub Contents API helper. Missing
// file = empty config (current behavior unchanged). Malformed JSON =
// empty config + structured warning logged but no failure (don't
// break the review just because config is bad — fail-open is the
// right policy for an opt-in feature).
//
// v1 schema (intentionally minimal — the goal is to ship the
// integration point, not to design the final schema; iterate as real
// usage informs what fields people want):
//
//   {
//     "guidance": "Free-form text prepended to every specialist +
//                  synthesizer prompt. E.g. 'This repo is a TS
//                  Cloudflare Worker. Reject any new class
//                  declarations.'",
//     "rules": {
//       "logic":       "Appended only to logic specialist's prompt.",
//       "security":    "Appended only to security specialist's prompt.",
//       "performance": "Appended only to performance specialist's prompt.",
//       "tests":       "Appended only to tests specialist's prompt."
//     }
//   }
//
// Out of scope for v1 (deferred to follow-up issues):
//   - `ignore` glob patterns (skip files matching) — needs glob matcher
//   - `requireFindings` — needs review-blocker integration
//   - YAML format support — JSON-only for v1
//   - JSON Schema validation — defer until field set stabilizes

import type { GitHubClient } from "./github"
import type { SpecialistRole } from "./ensemble-router"

export const SIGILIX_CONFIG_PATH = "sigilix.json"

export interface SigilixConfig {
  /** Repo-wide guidance prepended to every specialist + synthesizer prompt. */
  guidance?: string
  /**
   * Per-specialist-role rule appended only to that role's prompt. Lets
   * teams encode "the security specialist on this repo should always
   * check for X" without polluting the other roles' prompts.
   */
  rules?: Partial<Record<SpecialistRole, string>>
}

export const EMPTY_CONFIG: SigilixConfig = {}

/**
 * Defensively parse a candidate `sigilix.json` body. Returns null on
 * any structural problem (not JSON, not an object, fields wrong type)
 * so the caller can fall back to `EMPTY_CONFIG` and log a warning.
 *
 * Unknown fields are ignored (forward-compatible). Known fields with
 * wrong types are dropped silently in v1 — strict mode can come later
 * once the schema stabilizes.
 */
export function parseSigilixConfig(raw: string): SigilixConfig | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const out: SigilixConfig = {}
  if (typeof obj.guidance === "string" && obj.guidance.length > 0) {
    out.guidance = obj.guidance
  }
  if (obj.rules && typeof obj.rules === "object" && !Array.isArray(obj.rules)) {
    const rulesIn = obj.rules as Record<string, unknown>
    const rulesOut: Partial<Record<SpecialistRole, string>> = {}
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      const v = rulesIn[role]
      if (typeof v === "string" && v.length > 0) {
        rulesOut[role] = v
      }
    }
    if (Object.keys(rulesOut).length > 0) out.rules = rulesOut
  }
  return out
}

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
