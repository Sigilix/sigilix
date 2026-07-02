// SIG-298 follow-on — SDK guidance packs rollout gate. Mirrors
// `resolveLearningsMode`'s off/shadow/on shape (@/src/features/learnings) so
// the two features roll out on the same ladder: `off` (default) is fully
// inert (no detection, no telemetry); `shadow` detects + logs
// `sdk-pack-matched` but never touches the prompt (byte-identical output);
// `on` injects the guidance section and enables attribution.

import type { Env } from "@/src/shared/types/env"
import type { SdkPacksMode } from "./types"

export function resolveSdkPacksMode(raw: Env["OPENCLAW_SDK_PACKS_MODE"]): SdkPacksMode {
  const v = raw?.trim().toLowerCase()
  if (v === "on") return "on"
  if (v === "shadow") return "shadow"
  return "off"
}
