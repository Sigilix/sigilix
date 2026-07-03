// sig-worker-debrand-openclaw: env back-compat shim for the OPENCLAW_ → SIGILIX_
// rebrand of the Worker's config vars, secrets, and resource bindings.
//
// The Worker historically read `env.OPENCLAW_*` everywhere. The rebrand introduces
// the new canonical `SIGILIX_*` name for each, but the LIVE Cloudflare deployment
// still holds the values under the OPENCLAW_ names (committed [vars], `wrangler
// secret put` secrets, and KV/Vectorize/Queue bindings). Rewriting the ~5,000 call
// sites in one PR would be enormous and risky, so instead we normalize `env` ONCE at
// each entry point (the fetch/queue/scheduled handlers + each config-reading Durable
// Object constructor).
//
// For every LEGACY `OPENCLAW_<X>` key present on `env`, the value is resolved
// SIGILIX_-PREFERRED with OPENCLAW_ FALLBACK (`env.SIGILIX_<X> ?? env.OPENCLAW_<X>`)
// and written back under BOTH names. So:
//   - Today (only the OPENCLAW_ name set): behavior is byte-identical — the resolved
//     value is just the OPENCLAW_ value, and existing `env.OPENCLAW_<X>` reads are
//     unchanged.
//   - Once the founder ALSO sets the new `SIGILIX_<X>` secret/var (keeping the
//     OPENCLAW_ one during the transition), it WINS, and existing `env.OPENCLAW_<X>`
//     call sites transparently pick it up — no call-site edits.
//
// The mirror deliberately iterates only OPENCLAW_ keys, so SIGILIX_-NATIVE vars (ones
// that never had an OPENCLAW_ form — SIGILIX_FAIRNESS_MODE, SIGILIX_USAGE_*, …) are
// left exactly as-is: no spurious OPENCLAW_ sibling is invented for them. It is purely
// additive over legacy names — it never deletes a key and never lowers a value.
//
// NOTE (transition contract): the OPENCLAW_ names must be RETAINED alongside any new
// SIGILIX_ ones until the coordinated full migration (which also renames the Cloudflare
// RESOURCES). Removing an OPENCLAW_ secret/var before then would leave its legacy
// reader unresolved — that is the end-state this first pass intentionally defers.

import type { Env, NormalizedEnv } from "@/src/shared/types/env"

const SIGILIX_PREFIX = "SIGILIX_"
const OPENCLAW_PREFIX = "OPENCLAW_"

/**
 * Resolve every legacy `OPENCLAW_<X>` on a shallow clone of `env` to a single value
 * (`SIGILIX_<X> ?? OPENCLAW_<X>`), written back under BOTH names. Bindings
 * (KV/Vectorize/Queue/DO) are mirrored the same way — the clone copies the live binding
 * reference, so the fallback is a no-op object copy.
 *
 * Pure over its input: returns a new object, never mutates `env`. Runs once per
 * entry-point invocation (O(number of env keys), ~200) — negligible.
 */
export function normalizeEnv(env: Env): NormalizedEnv {
  const out = { ...(env as unknown as Record<string, unknown>) }

  for (const key of Object.keys(out)) {
    if (!key.startsWith(OPENCLAW_PREFIX)) continue
    const sigilixKey = SIGILIX_PREFIX + key.slice(OPENCLAW_PREFIX.length)
    // SIGILIX_-preferred, OPENCLAW_ fallback. `??` (not `||`) so an intentional
    // empty-string override is honored, matching the documented reader contract.
    const resolved = out[sigilixKey] ?? out[key]
    if (resolved === undefined) continue
    out[key] = resolved // legacy readers (env.OPENCLAW_X) see the SIGILIX_-first value
    out[sigilixKey] = resolved // new readers (env.SIGILIX_X) + the NormalizedEnv type
  }

  return out as unknown as NormalizedEnv
}
