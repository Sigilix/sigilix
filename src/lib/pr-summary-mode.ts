// SIG-437: feature flag for `@sigilix summary`. A webhook/product flag — kept
// OUT of the ensemble-review config (it gates a webhook trigger, not the review
// pipeline; routing it through `parseEnsembleConfig` would couple the webhook
// path to the review config for no benefit — Codex NIT #6). A tiny direct
// parser, used at the webhook trigger gate.
//
//   OPENCLAW_PR_SUMMARY_MODE = "off" (default) | "on"
//
// Default-off → the trigger never enqueues → pure no-op. Mirrors the
// `parse*Mode` idiom (trim + lowercase, explicit allowed values, default-off).
//
// Pure — no I/O. Exported for tests + the webhook.

export type PrSummaryMode = "off" | "on"

export function parsePrSummaryMode(raw: string | undefined): PrSummaryMode {
  return (raw ?? "").trim().toLowerCase() === "on" ? "on" : "off"
}
