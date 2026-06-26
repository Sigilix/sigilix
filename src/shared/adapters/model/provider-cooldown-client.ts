import type { Env } from "@/src/shared/types/env"

function cooldownStub(env: Env): DurableObjectStub {
  return env.PROVIDER_COOLDOWN.get(env.PROVIDER_COOLDOWN.idFromName("provider-cooldown-openrouter"))
}

/**
 * Set a provider backpressure cooldown. Best-effort / fire-and-forget — any error is
 * swallowed so callers can safely fire this via `ctx.waitUntil(setProviderCooldown(...))`.
 * Never throws.
 */
export async function setProviderCooldown(env: Env, cooldownMs: number): Promise<void> {
  try {
    await cooldownStub(env).fetch(
      new Request("https://do.internal/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cooldownMs }),
      }),
    )
  } catch {
    // swallow — best-effort; the DO is not on the critical path
  }
}

/**
 * Get the remaining cooldown ms for the provider. Fail-open: any throw, non-200, or
 * malformed body returns 0 (no cooldown). Never throws — callers AWAIT this to gate a
 * request decision.
 */
export async function getProviderCooldownRemainingMs(env: Env): Promise<number> {
  try {
    const res = await cooldownStub(env).fetch(
      new Request("https://do.internal/get", {
        method: "GET",
      }),
    )
    if (!res.ok) return 0
    const body = (await res.json()) as { remainingMs?: unknown }
    return typeof body.remainingMs === "number" ? body.remainingMs : 0
  } catch {
    return 0
  }
}
