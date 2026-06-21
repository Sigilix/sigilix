import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { SigilixConfig } from "@/src/lib/sigilix-config"

/** Append the repo's per-role rule block (from sigilix.json) to a specialist's
 *  initial message, if one is configured. Shared by the fan-out, the invariant
 *  lens, the security K-union, and the multi-batch enforce path. */
export function appendRoleRule(baseMessage: string, role: SpecialistRole, config: SigilixConfig): string {
  const rule = config.rules?.[role]
  if (!rule) return baseMessage
  return `${baseMessage}\n\n[REPO RULES — ${role.toUpperCase()} (from sigilix.json)]\n${rule}`
}
