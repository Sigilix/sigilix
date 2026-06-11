// ARC-193: deterministic regex checks via sigilix.json (Worker-native).
//
// Sigilix is pure-LLM. CodeRabbit blends LLM + ast-grep deterministic
// rules. Cloudflare Workers can't run the Rust ast-grep binary, but
// Worker-native regex checks fit and add meaningful deterministic
// signal alongside the LLM. v1 takes user-defined regex patterns from
// `sigilix.json`, runs them against ADDED diff lines (i.e., what the
// PR introduces), and emits structured findings for the specialists
// to consider.
//
// v1 deliberately scoped:
//   - JavaScript regex only (no AST)
//   - Match against added (+) lines in the diff; ignore context/deletions
//     (we want "what did this PR introduce?", not "what was here before")
//   - Glob path filter via simple `*`/`**` translation
//   - Malformed regex → check is skipped + recorded in telemetry; never
//     fails the review
//   - No ReDoS protection — regex evaluation in v8 is reasonably fast,
//     and a malicious config in your own repo isn't a meaningful threat
//     surface (the repo author already controls everything)

export interface DeterministicCheck {
  /** Stable identifier surfaced in findings + telemetry. */
  id: string
  /** JavaScript regex source (no flags — added internally). */
  pattern: string
  /** Severity hint for the specialist; LLM still weighs in context. */
  severity?: "info" | "warn" | "error"
  /** Human-readable explanation rendered alongside each match. */
  message: string
  /** Optional glob patterns scoping where this rule fires.
   *  When omitted, the rule applies to all paths. */
  paths?: string[]
}

export interface DeterministicCheckHit {
  ruleId: string
  severity: "info" | "warn" | "error"
  message: string
  path: string
  /** New-file line number where the match was introduced. */
  line: number
  /** The matched substring (truncated to keep prompts clean). */
  evidence: string
}

const SEVERITY_DEFAULT: "info" | "warn" | "error" = "warn"
const EVIDENCE_MAX_LEN = 200

/**
 * Defensively parse a candidate `deterministicChecks` array. Drops
 * entries with missing/wrong-typed required fields rather than
 * failing the whole config — fail-open is the policy across
 * sigilix.json parsing.
 */
export function parseDeterministicChecks(raw: unknown): DeterministicCheck[] {
  if (!Array.isArray(raw)) return []
  const out: DeterministicCheck[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const obj = entry as Record<string, unknown>
    if (typeof obj.id !== "string" || obj.id.length === 0) continue
    if (typeof obj.pattern !== "string" || obj.pattern.length === 0) continue
    if (typeof obj.message !== "string" || obj.message.length === 0) continue
    const sev = obj.severity
    const severity: "info" | "warn" | "error" =
      sev === "info" || sev === "warn" || sev === "error" ? sev : SEVERITY_DEFAULT
    const check: DeterministicCheck = {
      id: obj.id,
      pattern: obj.pattern,
      severity,
      message: obj.message,
    }
    if (Array.isArray(obj.paths)) {
      const paths = obj.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
      if (paths.length > 0) check.paths = paths
    }
    out.push(check)
  }
  return out
}

// ARC-176: glob compilation moved to `path-glob.ts` so sigilix-config's
// pathFilters and this module's per-rule `paths` share one proven
// implementation (the segment-boundary fix from sigilix-bot's PR #52
// review applies to both).
import { pathMatchesAny } from "@/src/shared/util/path-glob"

/**
 * Run every check against added lines in the diff. Returns one hit
 * per match. v1 scopes matching to ADDED lines only — pure context
 * lines might still contain a pattern but they're not new content
 * the PR introduced.
 *
 * `compiledRegexFailures` returns the rule IDs whose pattern didn't
 * compile so the orchestrator can record them in telemetry without
 * spamming the prompt with broken rules.
 */
export interface RunResult {
  hits: DeterministicCheckHit[]
  compiledRegexFailures: string[]
}

export function runDeterministicChecks(diff: string, checks: DeterministicCheck[]): RunResult {
  const hits: DeterministicCheckHit[] = []
  const compiledRegexFailures: string[] = []
  if (!diff || checks.length === 0) {
    return { hits, compiledRegexFailures }
  }

  // Pre-compile regexes once. A check whose regex fails to compile is
  // dropped from the iteration but recorded in failures so we know it
  // happened.
  const compiled: Array<{ check: DeterministicCheck; re: RegExp }> = []
  for (const check of checks) {
    try {
      compiled.push({ check, re: new RegExp(check.pattern) })
    } catch {
      compiledRegexFailures.push(check.id)
    }
  }
  if (compiled.length === 0) return { hits, compiledRegexFailures }

  // Walk the diff. Track current file path + new-line counter so
  // each hit carries an accurate `(path, line)` anchor.
  //
  // Header-detection guard: `--- ` and `+++ ` lines ONLY appear in
  // file headers, between `diff --git` and the first `@@`. Inside a
  // hunk, a content line like `--- comment` (SQL/Lua/Haskell-style
  // comment) or `+++ extra-args` (CLI flag list) is a real diff
  // line — interpreting it as a header would corrupt parser state
  // and silently skip the rest of the hunk. Track `inFileHeader`
  // explicitly so the header checks only fire in the right zone
  // (sigilix-bot dogfood catch on PR #52).
  const lines = diff.split("\n")
  let currentPath: string | null = null
  let newLine = 0
  let inHunk = false
  let inFileHeader = false

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentPath = null
      inHunk = false
      inFileHeader = true
      continue
    }
    if (inFileHeader && line.startsWith("+++ ")) {
      const p = line.slice(4).trim()
      currentPath = p === "/dev/null" ? null : p.startsWith("b/") ? p.slice(2) : p
      continue
    }
    if (inFileHeader && line.startsWith("--- ")) {
      continue
    }
    if (line.startsWith("@@")) {
      inFileHeader = false
      const m = line.match(/^@@\s+-(?:\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (m && m[1]) {
        newLine = Number(m[1])
        inHunk = currentPath !== null
      } else {
        inHunk = false
      }
      continue
    }
    if (!inHunk || currentPath === null) continue

    if (line.startsWith("+")) {
      // Added line. This is what we match against.
      const content = line.slice(1)
      for (const { check, re } of compiled) {
        if (check.paths && !pathMatchesAny(currentPath, check.paths)) continue
        const match = content.match(re)
        if (!match) continue
        const evidence = (match[0] ?? "").slice(0, EVIDENCE_MAX_LEN)
        hits.push({
          ruleId: check.id,
          severity: check.severity ?? SEVERITY_DEFAULT,
          message: check.message,
          path: currentPath,
          line: newLine,
          evidence,
        })
      }
      newLine++
    } else if (line.startsWith(" ")) {
      newLine++
    } else if (line.startsWith("-")) {
      // Deleted; doesn't advance new-file counter.
    }
    // Other markers (\, blank, etc.) ignored for line counting in v1.
  }

  return { hits, compiledRegexFailures }
}

/**
 * Render hits as a labeled evidence block injected into specialist
 * prompts. Empty input returns an empty string so the caller can
 * skip the block entirely when no rules matched.
 */
export function renderHitsForPrompt(hits: DeterministicCheckHit[]): string {
  if (hits.length === 0) return ""
  const lines = ["[DETERMINISTIC CHECKS — pre-computed before LLM, treat as authoritative facts]"]
  for (const h of hits) {
    lines.push(
      `- [${h.severity.toUpperCase()}] ${h.path}:${h.line} (rule: ${h.ruleId}) — ${h.message}`,
      `  evidence: ${h.evidence}`,
    )
  }
  return lines.join("\n")
}
