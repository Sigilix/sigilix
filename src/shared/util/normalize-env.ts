// sig-worker-debrand-openclaw: env back-compat shim for the OPENCLAW_ → SIGILIX_
// rebrand of the Worker's config vars, secrets, and resource bindings.
//
// The Worker historically read `env.OPENCLAW_*` everywhere. The rebrand introduces
// the new canonical `SIGILIX_*` name for each, but the ~1,600 `env.OPENCLAW_<X>` call
// sites are NOT rewritten in one PR (enormous and risky). Instead we normalize `env`
// ONCE at each entry point (the fetch/queue/scheduled handlers + each config-reading
// Durable Object constructor) so BOTH the legacy `OPENCLAW_<X>` name and the new
// `SIGILIX_<X>` name resolve to a single value — whichever the deploy actually holds.
//
// The mirror is BIDIRECTIONAL and SIGILIX_-preferred. For every prefixed key present on
// `env` — reached from EITHER side of a pair — the value is resolved
// `SIGILIX_<X> ?? OPENCLAW_<X>` and written back under BOTH names. So:
//   - Legacy holds only OPENCLAW_<X> (a secret / resource binding still under its old
//     name): behavior is byte-identical — the resolved value is the OPENCLAW_ one, and
//     the new `env.SIGILIX_<X>` alias is filled from it.
//   - Config now holds only SIGILIX_<X> (a [vars] key already renamed to SIGILIX_): the
//     value is mirrored BACK to `env.OPENCLAW_<X>`, so the legacy `env.OPENCLAW_<X>`
//     call sites transparently pick it up — no call-site edits.
//   - Both set (the transition, e.g. mid secret cutover): SIGILIX_ WINS.
//
// The OPENCLAW_→SIGILIX_ direction lets code MIGRATE readers to SIGILIX_ ahead of the
// config/secret rename; the SIGILIX_→OPENCLAW_ direction lets the config/secret rename
// land AHEAD of the reader migration (the case that renamed the [vars] to SIGILIX_ while
// call sites still read `env.OPENCLAW_<X>`). Either migration order is safe.
//
// The mirror only ever fills a sibling when a value EXISTS (`??`, and it skips
// `resolved === undefined`), so an ABSENT pair invents nothing. A SIGILIX-native key
// whose OPENCLAW_ form was never deployed DOES get its (unread) OPENCLAW_ sibling filled
// from the live SIGILIX_ value — harmless, since nothing reads that legacy name and no
// code branches on env-key presence. It is purely additive: it never deletes a key and
// never lowers a value.
//
// NOTE (transition contract): the SECRETS and RESOURCE bindings are still deployed under
// their OPENCLAW_ names; re-setting each secret as SIGILIX_ and re-indexing each
// Vectorize/KV/Queue/R2 resource as sigilix-* are deliberately deferred to their own
// coordinated steps. This shim keeps BOTH names resolving throughout, so a value can move
// from the OPENCLAW_ name to the SIGILIX_ name one at a time without breaking any reader.

import type { Env, NormalizedEnv } from "@/src/shared/types/env"

const SIGILIX_PREFIX = "SIGILIX_"
const OPENCLAW_PREFIX = "OPENCLAW_"

/**
 * Resolve every legacy/new pair on a shallow clone of `env` to a single value
 * (`SIGILIX_<X> ?? OPENCLAW_<X>`), written back under BOTH names. The pair is reached
 * from whichever side is present on `env`, so a value set under EITHER name is mirrored
 * to the other. Bindings (KV/Vectorize/Queue/DO) are mirrored the same way — the clone
 * copies the live binding reference, so the fallback is a no-op object copy.
 *
 * Pure over its input: returns a new object, never mutates `env`. Runs once per
 * entry-point invocation (O(number of env keys), ~200) — negligible.
 */
export function normalizeEnv(env: Env): NormalizedEnv {
  const out = { ...(env as unknown as Record<string, unknown>) }

  // Snapshot the keys first (Object.keys): the loop writes sibling keys onto `out`, and
  // each pair is fully resolved the first time it is reached, so re-processing the newly
  // written sibling would be redundant.
  for (const key of Object.keys(out)) {
    let sigilixKey: string
    let openclawKey: string
    if (key.startsWith(SIGILIX_PREFIX)) {
      sigilixKey = key
      openclawKey = OPENCLAW_PREFIX + key.slice(SIGILIX_PREFIX.length)
    } else if (key.startsWith(OPENCLAW_PREFIX)) {
      openclawKey = key
      sigilixKey = SIGILIX_PREFIX + key.slice(OPENCLAW_PREFIX.length)
    } else {
      continue
    }
    // SIGILIX_-preferred, OPENCLAW_ fallback. `??` (not `||`) so an intentional
    // empty-string override is honored, matching the documented reader contract.
    const resolved = out[sigilixKey] ?? out[openclawKey]
    if (resolved === undefined) continue
    out[openclawKey] = resolved // legacy readers (env.OPENCLAW_X) see the SIGILIX_-first value
    out[sigilixKey] = resolved // new readers (env.SIGILIX_X) + the NormalizedEnv type
  }

  return out as unknown as NormalizedEnv
}
