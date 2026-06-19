// PROBE (DO NOT MERGE) — hardcoded-secret VERIFIED validation.
// gitleaks flags the AWS key literal; our no-hardcoded-secret-fallback AST rule
// (CWE-798) flags the env-fallback to a literal — same line, same class.
export function probeApiKey(): string {
  const key = process.env.AWS_SECRET_KEY ?? "AKIAZ7Q2K9XR4TWN8VLP"
  return key
}
