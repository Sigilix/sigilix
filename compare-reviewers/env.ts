import { DEFAULT_GREPTILE_BOTS } from "./normalize"

export function greptileLoginsFromEnv(
  env: { COMPARE_REVIEWERS_GREPTILE_LOGINS?: string } = process.env,
  warn: (message: string) => void = console.warn,
): readonly string[] {
  const raw = env.COMPARE_REVIEWERS_GREPTILE_LOGINS
  if (raw === undefined || raw === "") return DEFAULT_GREPTILE_BOTS
  const values = raw.split(",").map((s) => s.trim()).filter(Boolean)
  if (values.length === 0) {
    warn("COMPARE_REVIEWERS_GREPTILE_LOGINS is set but contains no valid logins; using default Greptile bot logins")
    return DEFAULT_GREPTILE_BOTS
  }
  return values
}
