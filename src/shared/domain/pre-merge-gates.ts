// SIG-100 — Deterministic pre-merge quality gates.
//
// Three checks that run BEFORE specialist fanout (no model required):
//
//   1. PR title format — validates against `sigilix.json::preMergeGates
//      .titleFormat.regex` (default Conventional Commits)
//   2. Description completeness — body has at least `minLength` chars
//      OR contains every section from `template`
//   3. Linked-issue presence — PR body + commit messages contain a
//      GitHub auto-close keyword (`Closes|Fixes|Resolves #N` or
//      `Closes|Fixes|Resolves SIG-N`)
//
// Results render in the overview sticky's "Quality gates" section as
// a checklist — NOT as inline review comments. The gates' job is to
// nudge the author with deterministic facts, not to invoke the
// ensemble's blocking-finding machinery.
//
// All three gate functions are pure + synchronous; the runner is the
// only side-effect call site (it logs telemetry for each result).

export type GateSeverity = "info" | "warning" | "error"

export type GateId = "titleFormat" | "descriptionCompleteness" | "linkedIssue"

export interface GateResult {
  id: GateId
  label: string
  passed: boolean
  severity: GateSeverity
  /** Human-readable detail rendered when `passed === false`. */
  message?: string
}

/**
 * Resolved per-gate config — the parser's job is to materialize this
 * from `sigilix.json::preMergeGates`. Defaults applied here are the
 * source of truth: an absent `preMergeGates` config or absent
 * per-gate sub-config should resolve to these values via
 * `resolvePreMergeGatesConfig`.
 */
export interface ResolvedPreMergeGatesConfig {
  titleFormat: {
    enabled: boolean
    severity: GateSeverity
    /** JavaScript regex source (no flags) — the runner constructs the
     *  RegExp with the `u` flag for Unicode safety. */
    regex: string
  }
  descriptionCompleteness: {
    enabled: boolean
    severity: GateSeverity
    /** Minimum non-whitespace character count below which the body is
     *  considered "incomplete" even when no template sections are
     *  declared. Default 30. */
    minLength: number
    /** Required section headings (compared case-insensitively). All
     *  must appear somewhere in the body for the gate to pass. */
    template: string[]
  }
  linkedIssue: {
    enabled: boolean
    severity: GateSeverity
  }
}

/**
 * Default Conventional Commits regex. The ticket's example string had
 * an unbalanced group — corrected here. Mirrors angular-style:
 *   `feat(scope): subject`  / `fix: subject`  / `chore(scope): subject`
 */
export const DEFAULT_TITLE_REGEX =
  "^(?:feat|fix|chore|docs|refactor|test|perf|style|build|ci|revert)(?:\\([^)]+\\))?!?: .+"

/**
 * Default description template — Sigilix's own PR convention is
 * `## Summary` + `## Test plan`. Both must be present (any depth of
 * heading level matched against the markdown headings extracted from
 * the body).
 */
export const DEFAULT_DESCRIPTION_TEMPLATE: readonly string[] = ["## Summary", "## Test plan"]

/**
 * Default minimum non-whitespace character count for the description
 * completeness gate. 30 chars is enough to capture "this is a one-line
 * description" but rejects placeholder PRs that just say "wip" or "fix".
 */
export const DEFAULT_DESCRIPTION_MIN_LENGTH = 30

export const DEFAULT_PRE_MERGE_GATES_CONFIG: ResolvedPreMergeGatesConfig = {
  titleFormat: {
    enabled: true,
    severity: "warning",
    regex: DEFAULT_TITLE_REGEX,
  },
  descriptionCompleteness: {
    enabled: true,
    severity: "warning",
    minLength: DEFAULT_DESCRIPTION_MIN_LENGTH,
    template: [...DEFAULT_DESCRIPTION_TEMPLATE],
  },
  linkedIssue: {
    enabled: true,
    severity: "info",
  },
}

/**
 * Inputs to the gate runner. `commitMessages` should be the list of
 * commit messages (full, not just subject lines) so the linked-issue
 * scan picks up keywords in commit bodies as well as in the PR
 * description.
 */
export interface GateInput {
  prTitle: string
  prBody: string
  commitMessages: readonly string[]
}

/**
 * Hard cap on the title length fed to the operator regex. GitHub's UI
 * cap is 256 chars; the API cap is multi-KB but no real PR title hits
 * that. 1024 is a defensive ceiling — anything beyond is truncated
 * before `re.test` runs.
 *
 * SIG-100 — CR catch on PR #111: an operator-supplied regex with
 * pathological nested quantifiers could exhibit catastrophic
 * backtracking. ReDoS depends on both the pattern AND the input
 * length; capping the input bounds the worst case to a fixed
 * polynomial of 1024, which is fast enough on V8's regex engine
 * even for adversarial patterns. Operators retain full control of
 * the regex itself — this is operator-trust + length-cap defense
 * in depth, not a safe-regex checker.
 */
const TITLE_LENGTH_CAP_FOR_REGEX = 1024

/**
 * SIG-100 — evaluate PR title against `config.regex`. An empty title
 * always fails (with a distinct message). The regex is compiled fresh
 * per call so a malformed source doesn't poison subsequent calls;
 * compile errors fail-OPEN (gate passes) so a typo in the operator's
 * config can't break Sigilix entirely.
 *
 * Operator-trust assumption: `config.regex` is supplied by the repo
 * owner via `sigilix.json::preMergeGates.titleFormat.regex`. We do
 * NOT validate the pattern for ReDoS safety — that's an opt-in,
 * write-it-yourself surface. The title input IS length-capped (see
 * `TITLE_LENGTH_CAP_FOR_REGEX`) so even a pathological backtracking
 * pattern can't run unbounded on a malicious PR title.
 */
export function evaluateTitleFormatGate(
  title: string,
  config: ResolvedPreMergeGatesConfig["titleFormat"],
): GateResult {
  const base: Pick<GateResult, "id" | "label" | "severity"> = {
    id: "titleFormat",
    label: "PR title follows convention",
    severity: config.severity,
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return {
      ...base,
      passed: false,
      message: "PR title is empty.",
    }
  }
  let re: RegExp
  try {
    re = new RegExp(config.regex, "u")
  } catch {
    // Malformed operator config — fail OPEN. Telemetry happens at the
    // runner so we don't double-log here.
    return { ...base, passed: true }
  }
  // SIG-100 (CR catch on PR #111): cap the input length before
  // running the operator-supplied regex. ReDoS attacks need both a
  // pathological pattern AND a long input; capping the input bounds
  // the worst case to a fixed polynomial in 1024.
  const probedTitle = title.length > TITLE_LENGTH_CAP_FOR_REGEX
    ? title.slice(0, TITLE_LENGTH_CAP_FOR_REGEX)
    : title
  if (re.test(probedTitle)) {
    return { ...base, passed: true }
  }
  return {
    ...base,
    passed: false,
    message: `Title doesn't match repo convention: \`${config.regex}\``,
  }
}

/**
 * SIG-100 — evaluate PR description. Passes when EITHER:
 *   - the body has ≥ `minLength` non-whitespace characters (caters to
 *     small fixes that don't justify a section template), OR
 *   - all template sections appear in the body (case-insensitive match
 *     on the trimmed line).
 *
 * The split lets teams set a strict template OR a soft length floor;
 * both pass independently.
 */
export function evaluateDescriptionCompletenessGate(
  body: string,
  config: ResolvedPreMergeGatesConfig["descriptionCompleteness"],
): GateResult {
  const base: Pick<GateResult, "id" | "label" | "severity"> = {
    id: "descriptionCompleteness",
    label: "PR description is complete",
    severity: config.severity,
  }
  const safeBody = typeof body === "string" ? body : ""
  const nonWhitespaceLen = safeBody.replace(/\s/g, "").length

  if (nonWhitespaceLen >= config.minLength) {
    return { ...base, passed: true }
  }

  // Template-section check: each entry must appear as a line in the
  // body. Case-insensitive compare on the trimmed line, with
  // whitespace runs collapsed so `##  Summary` (double space) still
  // matches a `## Summary` template entry. Heading depth is NOT
  // normalized — `### Summary` will not satisfy a `## Summary`
  // template (operators get exactly the depth they declared).
  const normalize = (s: string): string =>
    s.trim().toLowerCase().replace(/\s+/g, " ")
  if (config.template.length > 0) {
    const bodyLines = safeBody
      .split(/\r?\n/)
      .map(normalize)
    const missing: string[] = []
    for (const section of config.template) {
      const needle = normalize(section)
      if (!bodyLines.includes(needle)) {
        missing.push(section)
      }
    }
    if (missing.length === 0) {
      return { ...base, passed: true }
    }
    return {
      ...base,
      passed: false,
      message: `Missing required sections: ${missing.map((s) => `\`${s}\``).join(", ")}.`,
    }
  }

  return {
    ...base,
    passed: false,
    message: `Description is too short (${nonWhitespaceLen} non-whitespace chars; minimum ${config.minLength}).`,
  }
}

/**
 * GitHub auto-close keywords per
 * https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue.
 * Sigilix-relevant references (`Closes SIG-N`) use the same keyword
 * with a Linear-issue key in place of `#N`.
 */
const LINKED_ISSUE_KEYWORDS = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"] as const

/**
 * Regex matching a single linked-issue reference:
 *   `Closes #42`
 *   `Fixes SIG-101`
 *   `resolved Sigilix/sigilix#7` (full-qualified is acceptable)
 *
 * The leading word boundary `\b` prevents false-positives like
 * `disclose` matching `close`.
 */
const LINKED_ISSUE_RE = new RegExp(
  `\\b(?:${LINKED_ISSUE_KEYWORDS.join("|")})\\b\\s+(?:[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+)?#\\d+|\\b(?:${LINKED_ISSUE_KEYWORDS.join("|")})\\b\\s+[A-Z]+-\\d+`,
  "iu",
)

/**
 * SIG-100 — scan PR body + commit messages for any GitHub
 * auto-close keyword followed by a `#N` GH issue reference OR a
 * `SIG-N` Linear-issue reference. Either is sufficient to pass.
 *
 * The scan is across the concatenated text so a keyword in the body
 * counts the same as a keyword in a commit message — both are
 * GitHub-recognized link sources.
 */
export function evaluateLinkedIssueGate(
  body: string,
  commitMessages: readonly string[],
  config: ResolvedPreMergeGatesConfig["linkedIssue"],
): GateResult {
  const base: Pick<GateResult, "id" | "label" | "severity"> = {
    id: "linkedIssue",
    label: "PR is linked to an issue",
    severity: config.severity,
  }
  const haystack = [body ?? "", ...(commitMessages ?? [])].join("\n\n")
  if (LINKED_ISSUE_RE.test(haystack)) {
    return { ...base, passed: true }
  }
  return {
    ...base,
    passed: false,
    message: "No `Closes #N` / `Closes SIG-N` keyword found in PR body or commit messages.",
  }
}

/**
 * Run every enabled gate and return the results in the documented
 * order (title → description → linked-issue) so the rendered
 * checklist stays stable across pushes. Disabled gates are skipped
 * entirely (not rendered as "passed" — silence).
 */
export function runPreMergeGates(
  input: GateInput,
  config: ResolvedPreMergeGatesConfig,
): GateResult[] {
  const results: GateResult[] = []
  if (config.titleFormat.enabled) {
    results.push(evaluateTitleFormatGate(input.prTitle, config.titleFormat))
  }
  if (config.descriptionCompleteness.enabled) {
    results.push(evaluateDescriptionCompletenessGate(input.prBody, config.descriptionCompleteness))
  }
  if (config.linkedIssue.enabled) {
    results.push(evaluateLinkedIssueGate(input.prBody, input.commitMessages, config.linkedIssue))
  }
  return results
}

/**
 * SIG-100 — render the "Quality gates" section as a markdown
 * checklist. Returns null when `results` is empty (every gate
 * disabled → no section in the body).
 *
 * Glyphs:
 *   ✅ passed
 *   ❌ failed (severity: error)
 *   ⚠️  failed (severity: warning)
 *   ℹ️  failed (severity: info)
 */
export function renderPreMergeGatesSection(results: readonly GateResult[]): string | null {
  if (results.length === 0) return null
  const lines: string[] = ["### Quality gates", ""]
  for (const r of results) {
    const glyph = r.passed
      ? "✅"
      : r.severity === "error"
        ? "❌"
        : r.severity === "warning"
          ? "⚠️"
          : "ℹ️"
    const detail = r.passed || !r.message ? "" : ` — ${r.message}`
    lines.push(`- ${glyph} ${r.label}${detail}`)
  }
  return lines.join("\n")
}
