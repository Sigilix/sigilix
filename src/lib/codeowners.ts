// SIG-150 — GitHub CODEOWNERS parsing + changed-path owner resolution.
//
// GitHub CODEOWNERS mostly follows gitignore syntax, but explicitly does NOT
// support negation (`!`) or character classes (`[]`). Invalid lines are skipped
// by GitHub, so we skip them here too instead of treating them as exclusions.

import picomatch from "picomatch/posix"
import type { Matcher } from "picomatch/posix"

export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const
const MAX_CODEOWNERS_MATCH_PATH_CHARS = 4096
const MAX_CODEOWNERS_MATCH_PATH_SEGMENTS = 256

export interface CodeownersRule {
  line: number
  pattern: string
  owners: string[]
  matcher: Matcher
}

export interface CodeownersParseResult {
  rules: CodeownersRule[]
  skipped: Array<{ line: number; pattern: string; reason: "negation" | "character-class" | "compile-failed" }>
}

export function parseCodeowners(text: string): CodeownersParseResult {
  const rules: CodeownersRule[] = []
  const skipped: CodeownersParseResult["skipped"] = []
  const lines = text.replace(/\r\n?/g, "\n").split("\n")

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i]!.trim()
    if (!line || line.startsWith("#")) continue

    const tokens = line.split(/\s+/u)
    const pattern = tokens.shift() ?? ""
    if (!pattern) continue
    if (pattern.startsWith("!")) {
      skipped.push({ line: lineNo, pattern, reason: "negation" })
      continue
    }
    if (pattern.includes("[") || pattern.includes("]")) {
      skipped.push({ line: lineNo, pattern, reason: "character-class" })
      continue
    }

    const owners: string[] = []
    for (const token of tokens) {
      if (token.startsWith("#")) break
      if (token.trim()) owners.push(token.trim())
    }

    try {
      const matcher = compileCodeownersPattern(pattern)
      rules.push({ line: lineNo, pattern, owners, matcher })
    } catch {
      skipped.push({ line: lineNo, pattern, reason: "compile-failed" })
    }
  }

  return { rules, skipped }
}

export function ownersForPath(rules: readonly CodeownersRule[], path: string): string[] {
  const normalized = normalizePath(path)
  if (normalized === null) return []
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!
    if (rule.matcher(normalized)) return rule.owners
  }
  return []
}

export function suggestedReviewersFromCodeowners(
  text: string,
  changedPaths: readonly string[],
  options: number | { limit?: number; exclude?: readonly string[]; includeTeams?: boolean } = {},
): string[] {
  return suggestedReviewersFromRules(parseCodeowners(text).rules, changedPaths, options)
}

export function suggestedReviewersFromRules(
  rules: readonly CodeownersRule[],
  changedPaths: readonly string[],
  options: number | { limit?: number; exclude?: readonly string[]; includeTeams?: boolean } = {},
): string[] {
  const limit = typeof options === "number" ? options : (options.limit ?? 2)
  if (limit <= 0) return []
  const exclude = new Set(
    (typeof options === "number" ? [] : (options.exclude ?? []))
      .map((s) => normalizeOwnerForMention(s, { includeTeams: true }))
      .filter((s): s is string => s !== null)
      .map((s) => s.toLowerCase()),
  )
  const includeTeams = typeof options === "number" ? false : options.includeTeams === true
  const out: string[] = []
  const seen = new Set<string>()

  for (const path of changedPaths) {
    for (const owner of ownersForPath(rules, path)) {
      const reviewer = normalizeOwnerForMention(owner, { includeTeams })
      const key = reviewer?.toLowerCase()
      if (!reviewer || !key || seen.has(key) || exclude.has(key)) continue
      seen.add(key)
      out.push(reviewer)
      if (out.length >= limit) return out
    }
  }

  return out
}

export function mergeSuggestedReviewers(
  codeownersReviewers: readonly string[],
  modelReviewers: readonly string[] | undefined,
  limit = 2,
): string[] | undefined {
  if (limit <= 0) return undefined
  const out: string[] = []
  const seen = new Set<string>()

  const codeowners = normalizedUniqueReviewers(codeownersReviewers)
  const model = normalizedUniqueReviewers(modelReviewers ?? [])

  // Reserve one slot for the model when it has signal. CODEOWNERS is
  // deterministic context, but the existing SIG-99 model suggestion can
  // still carry useful authorship/history signal outside ownership rules.
  const codeownersBudget = model.length > 0 ? Math.max(1, limit - 1) : limit
  for (const reviewer of codeowners.slice(0, codeownersBudget)) {
    const key = reviewer.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reviewer)
    if (out.length >= limit) break
  }
  for (const reviewer of model) {
    const key = reviewer.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reviewer)
    if (out.length >= limit) break
  }
  if (out.length >= limit) return out
  for (const reviewer of codeowners.slice(codeownersBudget)) {
    const key = reviewer.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reviewer)
    if (out.length >= limit) break
  }

  return out.length > 0 ? out : undefined
}

function compileCodeownersPattern(pattern: string): Matcher {
  const raw = pattern.trim()
  const anchored = raw.startsWith("/")
  const withoutLeading = anchored ? raw.slice(1) : raw
  const directoryPattern = withoutLeading.endsWith("/")
  const body = directoryPattern ? withoutLeading.replace(/\/+$/u, "") : withoutLeading
  if (!body) throw new Error("empty CODEOWNERS pattern")

  const globs: string[] = []
  if (directoryPattern) {
    if (!anchored) globs.push(`${body}/**`)
    globs.push(anchored ? `${body}/**` : `**/${body}/**`)
  } else if (anchored) {
    globs.push(body)
  } else if (body.includes("/")) {
    globs.push(body)
  } else {
    globs.push(`**/${body}`)
  }

  if (!directoryPattern && shouldAlsoMatchDirectoryChildren(body)) {
    const baseGlobs = [...globs]
    for (const glob of baseGlobs) globs.push(`${glob}/**`)
  }

  const matchers = [...new Set(globs)].map((glob) => picomatch(glob, { dot: true }))
  return ((path: string) => matchers.some((matcher) => matcher(path))) as Matcher
}

function normalizePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/u, "")
  const segments = normalized.split("/")
  if (
    normalized.length > MAX_CODEOWNERS_MATCH_PATH_CHARS ||
    segments.length > MAX_CODEOWNERS_MATCH_PATH_SEGMENTS ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return null
  }
  return normalized
}

function normalizeOwnerForMention(owner: string, options: { includeTeams?: boolean } = {}): string | null {
  const value = owner.trim().replace(/^@/u, "")
  if (!value || value.includes("@")) return null
  const ghName = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
  const user = new RegExp(`^${ghName}$`, "u")
  const team = new RegExp(`^${ghName}\\/${ghName}$`, "u")
  if (user.test(value)) return value
  if (options.includeTeams === true && team.test(value)) return value
  return null
}

function normalizedUniqueReviewers(reviewers: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const reviewer of reviewers) {
    const normalized = normalizeOwnerForMention(reviewer)
    const key = normalized?.toLowerCase()
    if (!normalized || !key || seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function shouldAlsoMatchDirectoryChildren(body: string): boolean {
  const segments = body.split("/").filter((segment) => segment.length > 0)
  const lastSegment = segments.at(-1) ?? body
  return !/[*?]/u.test(lastSegment)
}
