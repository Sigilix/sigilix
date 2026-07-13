// SIG-369(b) — second-pass reasoner model override: pure decision logic.
//
// The two SECOND-PASS recall phases (SIG-395 invariant-lens, SIG-393 resweep)
// re-run the LOGIC specialist. The lens fires one call per invariant family (up
// to 6) and the re-sweep one per region; on a dense PR these second-pass re-runs
// are the dominant logic input-token spend (PR #574, when logic was openai/o3:
// ~30.8K primary vs ~172.8K billed — the ~142K gap is these passes), NOT the
// primary specialist. (SIG-450 swapped the primary logic model o3 → Kimi K2.7;
// the same multiplier applies to whatever the primary is.)
//
// This leaf decides, behind a default-off flag, whether to route those
// second-pass calls to a cheaper strong reasoner (`deepseek/deepseek-v4-pro`,
// $0.435/$0.87 — cheaper than both legacy o3 and Kimi K2.7, already the `tests`
// specialist model) INSTEAD of the primary logic model. It is pure (no env /
// network / provider knowledge): the flag string is
// parsed at the edge, the override is computed against a base `ModelConfig`
// passed in, and the app-layer phases apply it. When off it returns
// `undefined`, so the call uses `SPECIALIST_CONFIGS[role]` exactly as today
// (byte-identical). The PRIMARY logic pass never consults this — only the
// second-pass phases do.
//
// Recall-safety: this changes only the MODEL the second passes run on when the
// flag is on; it never reduces the number of families/regions, never touches
// the primary pass, and the unchanged gate stack still backstops precision. A
// live recall gauge gates the actual flip (the founder runs it); the flag stays
// off until the cheaper model is proven to hold the lift.

import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"

export type SecondPassReasonerMode = "off" | "on"

/** The cheaper strong reasoner the second passes route to when the flag is on.
 *  An OpenRouter id (contains `/`), so `selectConfigApiKey` picks the OpenRouter
 *  key by id-shape exactly as it does for the o3 default — no key-routing change. */
export const SECONDPASS_REASONER_MODEL = "deepseek/deepseek-v4-pro"

/** Normalize `OPENCLAW_SECONDPASS_REASONER_MODE` (default "off"). Only the
 *  literal "on" (trimmed, lowercased) enables it — every other value, including
 *  unset, stays "off" so the default path is unchanged. */
export function parseSecondPassReasonerMode(raw: string | undefined): SecondPassReasonerMode {
  return (raw ?? "").trim().toLowerCase() === "on" ? "on" : "off"
}

/**
 * The model-selection decision for a single second-pass `runSpecialist` call.
 *
 * - `mode === "off"` → `undefined`: the caller passes NO override, so
 *   `runSpecialist` falls through to `SPECIALIST_CONFIGS[role]` (byte-identical
 *   to today).
 * - `mode === "on"` → a copy of `baseConfig` with only `primary` swapped to the
 *   cheaper reasoner. Every other knob (`retries`, `fallback`,
 *   `perAttemptTimeoutMs`) is preserved from the base role config, so the retry
 *   shape and timeout budget are unchanged — only the model differs.
 *
 * If `baseConfig.primary` is already the cheaper reasoner, the override is a
 * no-op copy with the same `primary` (still returned, so the call path is
 * uniform; the resulting `config` is value-equal to the base).
 */
export function secondPassReasonerOverride(args: {
  mode: SecondPassReasonerMode
  baseConfig: ModelConfig
}): ModelConfig | undefined {
  if (args.mode === "off") return undefined
  return { ...args.baseConfig, primary: SECONDPASS_REASONER_MODEL }
}
