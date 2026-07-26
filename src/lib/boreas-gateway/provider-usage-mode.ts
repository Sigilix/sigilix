// sig-gateway-usage — flag reader for provider-reported gateway metering.
//
// Own switch, deliberately NOT reusing an existing metering flag: those are already
// `on` in prod, so sharing one would flip billing behavior the instant this deploys.
// Off (default) → the gateway behaves exactly as before, with cost late-bound by the
// client's /v1/usage/report call.

import type { Env } from "@/src/shared/types/env"

/** `on` enables provider-reported metering. Anything else (incl. unset) is off. */
export function gatewayProviderUsageEnabled(env: Pick<Env, "SIGILIX_GATEWAY_PROVIDER_USAGE">): boolean {
  return env.SIGILIX_GATEWAY_PROVIDER_USAGE === "on"
}
