// Phase 4 ensemble router — decides WHICH specialists fire on a given PR.
//
// Default behavior (gated by OPENCLAW_ENSEMBLE_ROUTER_ENABLED=off):
//   When the flag is OFF, decideSpecialists() returns ALL FOUR specialists.
//   That's the Phase 4a "always-fire" mode reviewers wanted for baseline
//   data collection — no skipping, no premature routing decisions.
//
// When the flag is ON (Phase 4b activation):
//   The router applies STATIC signals from the diff to skip obviously
//   irrelevant specialists. The structural rules below are conservative —
//   they err toward including specialists, not excluding them. The
//   reviewers' specific guardrails (round-3 + refinement consensus) are
//   baked in:
//
//   - NEVER gate the tests specialist on "test files changed."
//     Tests' highest-value output is catching PRs that *should* have
//     added tests but didn't. Gating on test-file presence defeats it.
//   - Docs-only PRs are NOT safe to skip wholesale — markdown can carry
//     executable GH Actions YAML, IaC, deploy/auth code fences, etc.
//     Treat docs-only as overview-only ONLY when no sensitive paths
//     and no code fences are present (Phase 4b enhancement).
//   - Lockfile / package changes FORCE security/supply-chain.
//   - Auth-sensitive paths FORCE security.
//   - Migration / schema changes FORCE security + logic.
//   - Diff size is NOT a routing signal.
//   - CI status is context, NOT a routing signal.
//
// Why this lives in 4a despite reviewers saying "defer to 4b":
//   The reviewer concern was about routing RULES being tuned without
//   data, not about the router CODE existing. Shipping the router
//   default-OFF in 4a satisfies "collect baseline data first" while
//   eliminating a future PR cycle. Phase 4b becomes a flag-flip, not
//   a code change.

import type { Env } from "../shared/types/env"
import { ALL_SPECIALISTS } from "../shared/domain/specialist-role"
import type { SpecialistRole } from "../shared/domain/specialist-role"

// SIG-382: `SpecialistRole` + `ALL_SPECIALISTS` moved to a shared/domain leaf so
// pure shared code (config-domain) can use the role type without importing this
// lib module (which would invert the dependency rule). Re-exported here so the
// existing importers of this module are unchanged.
export { ALL_SPECIALISTS }
export type { SpecialistRole }

export interface RouterDecision {
  /** Specialists the orchestrator should fan out to. */
  specialists: SpecialistRole[]
  /** Why this decision was made (telemetry + debugging). */
  reason: string
  /** Whether the router was active or off (always-fire). */
  routerEnabled: boolean
}

export interface DiffSignals {
  /** Touched file paths (from PR meta or diff parsing). */
  paths: string[]
  /** Total lines changed across all files (informational only — NOT a routing signal). */
  totalLinesChanged: number
  /** Raw unified diff text. Used for content-aware checks: e.g. detecting
   *  fenced code blocks in markdown-only PRs (CR PR #35 catch). When
   *  unavailable (callers that don't pass it), content-aware checks fail
   *  closed — the docs-only shortcut is NOT taken. */
  diffText?: string
}

/**
 * Decide which specialists fire on this PR.
 *
 * Phase 4a default: returns all four specialists (router off).
 * Phase 4b activation: applies static signals to skip irrelevant ones.
 *
 * Pure function — no I/O, no side effects. Telemetry-friendly.
 */
export function decideSpecialists(
  signals: DiffSignals,
  env: Pick<Env, "OPENCLAW_ENSEMBLE_ROUTER_ENABLED">,
): RouterDecision {
  const routerEnabled = env.OPENCLAW_ENSEMBLE_ROUTER_ENABLED === "on"

  if (!routerEnabled) {
    return {
      specialists: [...ALL_SPECIALISTS],
      reason: "router_off_always_fire",
      routerEnabled: false,
    }
  }

  // Router IS enabled — apply static signal rules.
  // The strategy is "include specialists by default, exclude only when
  // we have strong negative evidence." Errs on the side of safety.

  const fileTypes = classifyFileTypes(signals.paths)

  // Hard FORCES — these always include certain specialists regardless
  // of other signals. Listed first so they win against any later skip.
  const forced = new Set<SpecialistRole>()
  if (touchesAuthOrPermissions(signals.paths)) forced.add("security")
  if (touchesPackagesOrLockfile(signals.paths)) forced.add("security")
  if (touchesMigrationsOrSchema(signals.paths)) {
    forced.add("security")
    forced.add("logic")
  }

  // Pure docs-only PRs (no code, no GH Actions YAML, no IaC, no
  // sensitive paths) → just overview, no specialists. Maximally
  // conservative: any non-doc file present means we don't take this
  // shortcut.
  //
  // CR PR #35 catch: extension-only check is unsafe — markdown can
  // carry executable fenced code blocks (sh/bash, yaml, dockerfile,
  // hcl/tf, json IaC config). Reviewers explicitly flagged this as
  // a docs-only blind spot. Skip the shortcut if added markdown
  // contains suspicious fenced content. Fail closed: when diffText
  // isn't passed, treat as "might contain fences" → don't shortcut.
  if (fileTypes.allDocsOnly && forced.size === 0) {
    const hasSuspiciousFences = signals.diffText === undefined
      || diffContainsExecutableMarkdownFences(signals.diffText)
    if (!hasSuspiciousFences) {
      return {
        specialists: [],
        reason: "docs_only_no_specialists",
        routerEnabled: true,
      }
    }
    // Fall through — docs-only-with-fences gets the default ensemble
    // so security/logic can review what the fenced code actually does.
  }

  // Pure CSS-only PRs → skip logic/security/tests; perf still relevant
  // for layout/repaint regressions.
  if (fileTypes.allCssOnly && forced.size === 0) {
    return {
      specialists: ["performance"],
      reason: "css_only_perf_only",
      routerEnabled: true,
    }
  }

  // Default: run all four, then add forces (forces are already in the
  // set so they're a no-op here — but the explicit assignment makes
  // the intent obvious to a future reader).
  const result: SpecialistRole[] = [...ALL_SPECIALISTS]
  for (const role of forced) {
    if (!result.includes(role)) result.push(role)
  }

  return {
    specialists: result,
    reason: forced.size > 0 ? `default_plus_forced_${[...forced].join("_")}` : "default_all_four",
    routerEnabled: true,
  }
}

// ─── path classification helpers ──────────────────────────────────────

const DOCS_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"])
const CSS_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"])

interface FileTypeBuckets {
  allDocsOnly: boolean
  allCssOnly: boolean
}

function classifyFileTypes(paths: string[]): FileTypeBuckets {
  if (paths.length === 0) return { allDocsOnly: false, allCssOnly: false }
  let docsCount = 0
  let cssCount = 0
  for (const p of paths) {
    const ext = extOf(p)
    if (DOCS_EXTENSIONS.has(ext)) docsCount++
    else if (CSS_EXTENSIONS.has(ext)) cssCount++
  }
  return {
    allDocsOnly: docsCount === paths.length,
    allCssOnly: cssCount === paths.length,
  }
}

function extOf(path: string): string {
  const slash = path.lastIndexOf("/")
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

/**
 * Auth/permission-sensitive path detection. Configurable via env later;
 * Phase 4a uses a defensible default list. The list errs broad: false
 * positives just mean "run security too" which is cheap; false negatives
 * mean missing real auth bugs.
 */
function touchesAuthOrPermissions(paths: string[]): boolean {
  return paths.some((p) => {
    const lower = p.toLowerCase()
    return (
      lower.includes("/auth/") ||
      lower.includes("/authn/") ||
      lower.includes("/authz/") ||
      lower.includes("/middleware/") ||
      lower.includes("/iam/") ||
      lower.includes("/permissions/") ||
      lower.includes("/security/") ||
      // Common file-name patterns
      /\b(auth|jwt|oauth|session|password|token)\b/.test(lower)
    )
  })
}

/**
 * Package / lockfile touches. Forces security specialist for
 * supply-chain review (added/upgraded deps may pull in vulnerabilities).
 */
function touchesPackagesOrLockfile(paths: string[]): boolean {
  return paths.some((p) => {
    const lower = p.toLowerCase()
    const name = lower.split("/").pop() ?? lower
    return (
      name === "package.json" ||
      name === "package-lock.json" ||
      name === "yarn.lock" ||
      name === "pnpm-lock.yaml" ||
      name === "cargo.toml" ||
      name === "cargo.lock" ||
      name === "go.mod" ||
      name === "go.sum" ||
      name === "requirements.txt" ||
      name === "pyproject.toml" ||
      name === "poetry.lock" ||
      name === "gemfile.lock"
    )
  })
}

/**
 * Detect whether the added lines in a unified diff contain markdown
 * fenced code blocks with executable / sensitive languages. CR PR #35
 * catch: docs-only PRs aren't safe to skip when they include shell
 * commands, GitHub Actions YAML, Dockerfile fragments, IaC, etc.
 *
 * Looks at lines starting with `+` (added content) for the opening of
 * a fenced block: ```<lang>. Languages flagged as suspicious include
 * shell variants, infra/config DSLs, and anything that could carry
 * deploy/auth/security implications.
 */
const SUSPICIOUS_FENCE_LANGUAGES = new Set([
  "sh", "bash", "shell", "zsh", "fish", "powershell", "ps", "ps1",
  "yaml", "yml", "json",
  "dockerfile", "docker",
  "hcl", "tf", "terraform",
  "groovy",  // Jenkins
  "ts", "typescript", "js", "javascript",
  "py", "python",
  "rb", "ruby",
  "go",
  "rs", "rust",
  "sql",
  "nginx", "apache",
])

function diffContainsExecutableMarkdownFences(diff: string): boolean {
  if (!diff || typeof diff !== "string") return false
  const lines = diff.split("\n")
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    // Strip the leading "+", trim, look for fenced opener.
    const content = line.slice(1).trimStart()
    const match = content.match(/^```(\w+)/)
    if (!match) continue
    const lang = match[1]?.toLowerCase()
    if (lang && SUSPICIOUS_FENCE_LANGUAGES.has(lang)) {
      return true
    }
  }
  return false
}

/**
 * Migration / schema changes. Forces security + logic — schema bugs
 * are correctness bugs (logic) and can also be data-exposure bugs
 * (security).
 */
function touchesMigrationsOrSchema(paths: string[]): boolean {
  return paths.some((p) => {
    const lower = p.toLowerCase()
    return (
      lower.includes("/migrations/") ||
      lower.includes("/migrate/") ||
      lower.endsWith(".sql") ||
      lower.endsWith("schema.prisma") ||
      lower.endsWith("schema.rb") ||
      // Conventional Knex / TypeORM / Diesel / Flyway / Liquibase paths
      /\bschema\b\.[a-z0-9]+$/.test(lower) ||
      /\bmigration\b/.test(lower)
    )
  })
}
