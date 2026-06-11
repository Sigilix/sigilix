// SIG-376 (SIG-318 Tier-1 3/8): the pure path/content pattern cluster
// lifted out of `dynamic-dispatcher.ts` so that file stays under the
// 1,000-line budget. These helpers + the constant pattern data are pure
// relocations — bodies are byte-identical to their prior in-file
// definitions; only the surrounding `export` keywords (so the core and
// the LLM leaf can import them) differ.
//
// Pure module: no IO, no env reads. Depends only on the shared
// `compileGlob` util + the `SpecialistRole` / `ClassifiedDiffFile` /
// `DispatcherSafetyNetPattern` types — it does NOT import the core
// `dynamic-dispatcher.ts`, so there is no cycle.

import type { ClassifiedDiffFile } from "./diff-file-classify"
import type { SpecialistRole } from "./ensemble-router"
import type { DispatcherSafetyNetPattern } from "./sigilix-config"
import { compileGlob } from "@/src/shared/util/path-glob"

// ─── Path / content pattern helpers ──────────────────────────────────

const DOCS_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"])
const CSS_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"])

export interface FileTypeBuckets {
  allDocsOnly: boolean
  allCssOnly: boolean
  /** SIG-227a: every diffed file is a lockfile (no source / config /
   *  test changes). Lockfile-only PRs are dep bumps — security gets
   *  forced for supply-chain review, but logic/perf/tests have
   *  nothing to grip on. */
  allLockfilesOnly: boolean
  /** SIG-227a: every diffed file is a TypeScript declaration file
   *  (`.d.ts`). Type-only changes describe types; runtime behavior
   *  isn't affected, so security/logic/perf have nothing to find.
   *  Tests stay on the lineup because type-only changes can still
   *  affect assertion shape. */
  allDtsOnly: boolean
  /** SIG-227a: every diffed file is a test file (`*.test.*`,
   *  `*.spec.*`, `__tests__/**`, etc. — see
   *  `diff-file-classify::isTestPath`). Test-only PRs add coverage
   *  for code that ISN'T changing — security/perf have no surface
   *  to evaluate. Logic stays on (test correctness IS logic) plus
   *  tests-specialist obviously. */
  allTestFilesOnly: boolean
}

export function classifyFileTypes(
  paths: readonly string[],
  classified: readonly ClassifiedDiffFile[],
): FileTypeBuckets {
  if (paths.length === 0) {
    return {
      allDocsOnly: false,
      allCssOnly: false,
      allLockfilesOnly: false,
      allDtsOnly: false,
      allTestFilesOnly: false,
    }
  }
  let docs = 0
  let css = 0
  let lockfiles = 0
  let dts = 0
  for (const p of paths) {
    const ext = extOf(p)
    if (DOCS_EXTENSIONS.has(ext)) docs++
    else if (CSS_EXTENSIONS.has(ext)) css++
    if (isLockfile(p)) lockfiles++
    if (isDtsFile(p)) dts++
  }
  // Test-only detection comes from the `classified` file kinds since
  // `diff-file-classify` already encodes the canonical "is this a
  // test file" decision (matches `*.test.*`, `*.spec.*`, `tests/**`,
  // `__tests__/**` — see `isTestPath` in that module).
  const testCount = classified.filter((f) => f.kind === "test").length
  return {
    allDocsOnly: docs === paths.length,
    allCssOnly: css === paths.length,
    allLockfilesOnly: lockfiles === paths.length,
    allDtsOnly: dts === paths.length,
    allTestFilesOnly: classified.length > 0 && testCount === classified.length,
  }
}

export function isLockfile(path: string): boolean {
  const name = (path.split("/").pop() ?? path).toLowerCase()
  return (
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "pnpm-lock.yaml" ||
    name === "cargo.lock" ||
    name === "go.sum" ||
    name === "poetry.lock" ||
    name === "gemfile.lock" ||
    name === "composer.lock"
  )
}

export function isDtsFile(path: string): boolean {
  return /\.d\.[cm]?ts$/i.test(path)
}

export function extOf(path: string): string {
  const slash = path.lastIndexOf("/")
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

/**
 * Expanded SECURITY safety-net path patterns. Code-owned, additive
 * via per-repo config (never deletable). Order matters only for
 * telemetry — a hit anywhere short-circuits.
 *
 * Each pattern is matched against the LOWERCASED path.
 *
 * Pattern style: long substrings that commonly appear as prefixes in
 * compound filenames use `\bfoo\w*` to catch camelCase / dash
 * variants (`authorize.ts`, `auth0-helper.ts`, `jwtDecode.ts`,
 * `passwordReset.ts`). Short acronyms (`saml`, `oidc`, `rbac`,
 * `acl`, `iam`) use `\b...\b` because they're rarely a prefix of
 * unrelated words. Safety-net errs on false-positive force-include
 * over false-negative miss (per spec Q5: "safety net wins silently
 * when it disagrees with the LLM"). Code-review M1 fix: the prior
 * `\bauth\b` etc. missed `authorize`, `auth0-*`, `jwtDecode`,
 * `passwordReset` — material recall hole for the protected-role
 * graduation bar.
 */
const GLOBAL_SECURITY_PATH_PATTERNS: readonly RegExp[] = [
  // Auth / authn / authz family — match as prefix to catch
  // `authorize`, `authentication`, `auth0`, etc.
  /\bauth\w*/,
  /\biam\b/,
  /\bpermission\w*/,
  /\bpolic(?:y|ies|ying)\b/,
  /\bsecurity\w*/,
  // Tokens, sessions, secrets — prefix match
  /\bjwt\w*/,
  /\boauth\w*/,
  /\bsession\w*/,
  /\bcookie\w*/,
  /\bpassword\w*/,
  /\btoken\w*/,
  /\bsecret\w*/,
  /\bcrypto\w*/,
  /\bcredential\w*/,
  /\bvault\b/,
  // Short acronyms — kept as full word match (rare as prefixes)
  /\bsaml\b/,
  /\boidc\b/,
  /\brbac\b/,
  /\bacl\b/,
  // Web-security middleware primitives
  /\bmiddleware\w*/,
  /\bguard\w*/,
  /\bcors\b/,
  /\bcsp\b/,
  /\bcsrf\b/,
  /\bxss\b/,
  // Env / credential files
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(pem|key|crt|cer|p12|pfx|jks)$/,
  // CI / deploy / infra-as-code (executable in CI context)
  /(?:^|\/)\.github\/workflows\//,
  /(?:^|\/)dockerfile(?:\.|$|\b)/,
  /\.(tf|hcl|tfvars)$/,
  /(?:^|\/)(k8s|kubernetes|helm)\//,
  /(?:^|\/)nginx\.conf$/,
  // Webhooks + RLS policy files
  /\bwebhook\w*/,
  /\.policy\.[a-z0-9]+$/,
  /(?:^|\/)policies\//,
]

/**
 * Expanded LOGIC safety-net path patterns. Mirrors the spec's Q5
 * list — correctness-sensitive code surfaces where a "logic
 * specialist not invoked" miss would be expensive.
 */
const GLOBAL_LOGIC_PATH_PATTERNS: readonly RegExp[] = [
  // Parsers, serializers, regex / state-machine code
  /\b(parser|parsers|serialize(?:r)?|deserialize(?:r)?|regex|state[-_]?machine)\b/,
  // Retry / cache / queue / concurrency primitives.
  // `lock\w+` (REQUIRES a continuation word-char after `lock`) catches
  // real concurrency code — `LockManager`, `Locking`, `locker`,
  // `locked-state`, `Locks` — without matching BARE `lock` in
  // lockfile basenames (`package-lock.json`, `cargo.lock`). The
  // hyphen/dot in those filenames is a word boundary, so `lock\w+`
  // requires at least one continuation character and won't fire on a
  // bare `lock` token. SIG-227a code-review L1 tightening.
  /\b(retry|backoff|cache(?!\.test)|queue(?!\.test)|lock\w+|mutex|semaphore|concurren\w*)\b/,
  // Billing / payments / public API contracts
  /(?:^|\/)(billing|payment|payments|stripe|invoice|invoices)\//,
  /(?:^|\/)(api|routes?|public)\//,
]

// Known evasion gaps (code-review M3): these regexes catch the common
// dangerous-sink shapes in real-world JS/TS code, but they ARE NOT a
// complete sandbox. Multi-line template literals (`eval` text on a
// non-`+` line), string-construction (`globalThis["ev"+"al"]`),
// `Reflect.construct(Function, ...)`, and indirect calls
// (`(0, eval)(...)`) all slip through. The dispatcher's safety net is
// intentionally coarse + additive — Phase 2 will surface evasion-rate
// telemetry so we can tighten the regexes when shadow data shows real
// false negatives in production.
const CONTENT_SECURITY_PATTERNS: readonly RegExp[] = [
  // JavaScript / TS dangerous sinks. Anchor with `+` so we only see
  // added lines.
  /^\+.*\beval\s*\(/m,
  /^\+.*\.innerHTML\s*=/m,
  /^\+.*\bdangerouslySetInnerHTML\b/m,
  /^\+.*\bnew\s+Function\s*\(/m,
  // Process spawning (often a sign of shell-injection risk)
  /^\+.*\b(child_process|spawn|exec|execSync|execFileSync)\b/m,
  // SQL template literal tag (raw query construction)
  /^\+.*\bsql`/m,
  // Hardcoded high-entropy secrets — caught by `secret-scan.ts` too,
  // but this is a coarse safety-net hint that forces security review
  // even if the secret-scan deduper missed it.
  /^\+.*\b(PRIVATE\s*KEY|PASSWORD|SECRET|API_KEY)\b/m,
]

const BEHAVIOR_CHANGE_RE =
  /\b(fix|fixes|fixed|change|changes|changed|break|breaking|behavior|behaviour|refactor|rewrite|migrate|deprecat\w*)\b/i

export function anyMatchesPath(lowerPaths: readonly string[], patterns: readonly RegExp[]): boolean {
  for (const path of lowerPaths) {
    for (const re of patterns) {
      if (re.test(path)) return true
    }
  }
  return false
}

export function touchesPackagesOrLockfile(lowerPaths: readonly string[]): boolean {
  return lowerPaths.some((p) => {
    const name = p.split("/").pop() ?? p
    return (
      name === "package.json" ||
      name === "cargo.toml" ||
      name === "go.mod" ||
      name === "requirements.txt" ||
      name === "pyproject.toml" ||
      isLockfile(p)
    )
  })
}

export function touchesMigrationsOrSchema(lowerPaths: readonly string[]): boolean {
  return lowerPaths.some((p) => {
    return (
      p.includes("/migrations/") ||
      p.includes("/migrate/") ||
      p.endsWith(".sql") ||
      p.endsWith("schema.prisma") ||
      p.endsWith("schema.rb") ||
      /\bschema\b\.[a-z0-9]+$/.test(p) ||
      /\bmigration\b/.test(p)
    )
  })
}

const SUSPICIOUS_FENCE_LANGUAGES = new Set([
  "sh",
  "bash",
  "shell",
  "zsh",
  "fish",
  "powershell",
  "ps",
  "ps1",
  "yaml",
  "yml",
  "json",
  "dockerfile",
  "docker",
  "hcl",
  "tf",
  "terraform",
  "groovy",
  "ts",
  "typescript",
  "js",
  "javascript",
  "py",
  "python",
  "rb",
  "ruby",
  "go",
  "rs",
  "rust",
  "sql",
  "nginx",
  "apache",
])

export function diffContainsExecutableMarkdownFences(diff: string): boolean {
  if (!diff || typeof diff !== "string") return false
  const lines = diff.split("\n")
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const content = line.slice(1).trimStart()
    const match = content.match(/^```(\w+)/)
    if (!match) continue
    const lang = match[1]?.toLowerCase()
    if (lang && SUSPICIOUS_FENCE_LANGUAGES.has(lang)) return true
  }
  return false
}

export function matchAdditionalPatterns(
  paths: readonly string[],
  patterns: readonly DispatcherSafetyNetPattern[],
): Map<SpecialistRole, string[]> {
  const hitsByRole = new Map<SpecialistRole, string[]>()
  for (const pat of patterns) {
    let re: RegExp
    try {
      re = compileGlob(pat.glob)
    } catch {
      // Malformed glob in user config — skip (fail-open per the
      // sigilix-config contract).
      continue
    }
    if (paths.some((p) => re.test(p))) {
      const existing = hitsByRole.get(pat.role)
      if (existing) existing.push(pat.glob)
      else hitsByRole.set(pat.role, [pat.glob])
    }
  }
  return hitsByRole
}

export function extractDiffSample(diff: string, maxLines: number): string {
  const lines = diff.split("\n").slice(0, maxLines * 4) // pre-trim raw
  const sample: string[] = []
  for (const line of lines) {
    sample.push(line)
    if (sample.length >= maxLines) break
  }
  return sample.join("\n")
}

export function truncate(s: string, maxChars: number): string {
  if (!s) return ""
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`
}

export { GLOBAL_SECURITY_PATH_PATTERNS, GLOBAL_LOGIC_PATH_PATTERNS, CONTENT_SECURITY_PATTERNS, BEHAVIOR_CHANGE_RE }
