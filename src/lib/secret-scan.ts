// ARC-187: secret scanning before LLM specialist fanout.
//
// LLM-based secret detection has high miss rates vs. dedicated
// scanners. AikidoSec's Gitleaks fork (`AikidoSec/gitleaks`) defines
// a TOML schema for entropy-aware regex rules; CodeRabbit ships a
// similar baseline. Cloudflare Workers can't shell out to the
// Gitleaks binary, but Worker-native regex against added diff lines
// catches the high-confidence patterns deterministically.
//
// v1 ships with a built-in baseline rule set covering the patterns
// that actually leak in real PRs: AWS keys, GitHub tokens, Slack
// webhooks, Stripe keys, OpenAI/Anthropic/Ollama keys, generic
// private-key PEM headers, and a high-entropy safety net for "long
// random-looking string in source." Hits become structured findings
// injected into the specialist prompts as authoritative facts — the
// security specialist isn't asked to re-discover secrets by reading
// raw diff.
//
// Privacy contract: matched substrings are NEVER returned in raw
// form. The renderer emits only a redacted preview (first 4 + last 4
// chars) plus a stable fingerprint (sha-like hash of path + line +
// redacted form) so multiple runs on the same PR don't duplicate-
// flag the same secret. Logs / telemetry never include the raw
// secret either.
//
// Out of scope (filed under ARC-187):
//   - User-configurable rules in sigilix.json (defer until baseline
//     proves itself)
//   - True Gitleaks .toml ingestion
//   - Baseline / `.gitleaksignore` fingerprint suppression
//   - Entropy-only rules (require Shannon entropy calc per match)

interface SecretRule {
  id: string
  /** Human-readable category surfaced to the model + reviewer. */
  category:
    | "aws"
    | "github"
    | "slack"
    | "stripe"
    | "openai"
    | "anthropic"
    | "ollama"
    | "private-key"
    | "generic-token"
  /** Pre-compiled-friendly source. */
  pattern: RegExp
  /** When omitted, severity defaults to `error` — secrets in code
   *  are blockers by default. */
  severity?: "warn" | "error"
}

/**
 * Built-in baseline rule set. All anchored against added diff line
 * content (not raw source). Reviewed against the canonical Gitleaks
 * default config and CodeRabbit's published patterns; rules below
 * are the intersection that matters for repos shipping web services.
 *
 * Each rule's regex captures the secret value in match[0] (the full
 * match) so the renderer can build a redacted preview without
 * needing per-rule capture-group conventions.
 */
const RULES: readonly SecretRule[] = [
  {
    id: "aws-access-key",
    category: "aws",
    // AWS access key IDs: AKIA (long-lived) / ASIA (session token).
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "github-token",
    category: "github",
    // GitHub PATs, OAuth tokens, app tokens, refresh tokens, and
    // user-to-server tokens all share a common `gh{type}_` prefix.
    pattern: /\bgh[posru]_[A-Za-z0-9]{36,255}\b/,
  },
  {
    id: "slack-webhook",
    category: "slack",
    pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24,}\b/,
  },
  {
    id: "stripe-secret-key",
    category: "stripe",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/,
  },
  // Order matters: anthropic must come BEFORE openai because both
  // start with `sk-` and we want the more specific rule to claim the
  // match first. The openai pattern uses a negative lookahead to
  // double-defend against accidentally matching anthropic keys even
  // if rule order changes in the future.
  {
    id: "anthropic-api-key",
    category: "anthropic",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: "openai-api-key",
    category: "openai",
    // `sk-` followed by 32+ chars, EXCLUDING `sk-ant-` (anthropic).
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: "ollama-api-key",
    category: "ollama",
    // Ollama cloud API keys are documented/shown with an `ollama_` prefix.
    pattern: /\bollama_[A-Za-z0-9_-]{24,}\b/,
  },
  {
    id: "private-key-pem-header",
    category: "private-key",
    // The header alone is enough to flag — actual key body sits on
    // the next line. Don't try to span multi-line in v1; we'd need
    // hunk-aware parsing. v2 could.
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: "generic-high-entropy-token",
    category: "generic-token",
    // Conservative: 40+ chars of base64-ish content. Anchors to
    // ensure we don't match a long natural-language string. Mostly
    // catches API keys with no recognizable provider prefix.
    pattern: /\b[A-Za-z0-9+/=_-]{40,}\b/,
    // Lower severity — generic regex has false positives. Specialist
    // can dismiss based on context (a long URL fragment, a base64-
    // encoded test fixture, etc.).
    severity: "warn",
  },
] as const

/**
 * The generic-token rule catches lots of things that aren't secrets
 * (uuids in URLs, base64 of public data, hashes). To reduce false-
 * positive noise, suppress generic matches that look like one of:
 *   - Hex-only strings ≥40 chars (looks like a hash, not a secret)
 *   - URLs the natural way (already-prefixed http / https)
 *   - File paths (have `/` and end with a known code/text extension)
 * The PROVIDER-specific rules above are not subject to this filter.
 */
function genericFalsePositive(match: string, contextLine: string, matchOffset: number): boolean {
  // Hex-only ≥ 32 chars → almost certainly a hash, not a secret
  if (/^[a-f0-9]{32,}$/i.test(match)) return true
  // Heuristic: if the line contains a URL/path-like pattern around
  // the match, it's probably not a secret. Cheap proxy: any "/" in
  // the match itself (URL component) or `://` in the surrounding line.
  if (/:\/\//.test(contextLine)) return true
  // SIG-93: long kebab-case file paths repeatedly tripped the generic
  // catch-all on PR #98 + PR #105 (handoff doc filenames + test fixture
  // path arrays). The generic regex char class includes `/` but not
  // `.`, so a 50-char path like `claude/handoff/arc-292-model-foo`
  // matches and the `.md` suffix sits just outside the match boundary.
  // Gate: match contains `/` AND is immediately followed by a known
  // code/text extension in the surrounding line. AWS secret access
  // keys (which can contain `/`) won't have a file extension after
  // them, so this doesn't suppress legit credentials.
  if (looksLikeFilePath(match, contextLine, matchOffset)) return true
  // SIG-126: separator-segmented single-case identifier / path / prose shapes
  // tripped the 40+-char generic rule as P0 "secrets". All PURELY ALPHABETIC
  // (no digits) — real provider-less secret bodies contain digits, so these
  // never suppress a real secret.
  if (/^[a-z]+([-/][a-z]+)+$/.test(match)) return true   // kebab / lower path / slash-prose
  if (/^[A-Z]+(_[A-Z]+)+$/.test(match)) return true       // SCREAMING_SNAKE
  if (/^[a-z]+(_[a-z]+)+$/.test(match)) return true       // lower snake_case
  // SIG-251: extend the same single-case-identifier philosophy to the two
  // separator-less / `=`-bearing shapes that slipped through — camelCase &
  // PascalCase identifiers, and SCREAMING_SNAKE=lowercase env refs.
  //
  // FALSE-NEGATIVE GUARD (Codex cross-check): these are deliberately NARROW
  // PURE-ALPHA identifier shapes, NOT a blanket "no-digit → suppress". A blanket
  // no-digit rule would suppress real all-letter secrets — base32/TOTP seeds
  // (`MFRGG…`, alphabet `A-Z2-7`, all-caps) and the ~0.1% of base64 tokens that
  // happen to be digit-free. Those do NOT match these shapes: base32 is all-caps
  // (fails camelCase/Pascal which need lowercase runs), and random base64 carries
  // `/` + irregular casing (fails the clean identifier shapes) — so they still
  // FIRE. The shapes only catch tokens with genuine identifier structure.
  if (/^[a-z]+([A-Z][a-z]*)+$/.test(match)) return true   // camelCase identifier
  if (/^([A-Z][a-z]+)+$/.test(match)) return true          // PascalCase identifier
  if (/^[A-Z]+(_[A-Z]+)*=[a-z]+$/.test(match)) return true // SCREAMING_SNAKE=lowercase env ref
  return false
}

// Extensions covered by the path-shape gate. Conservative — only
// shapes that show up as literal file paths in source / tests / docs.
// The optional `(test|spec|d|stories|module|config)\.` prefix covers
// compound extensions like `.test.ts`, `.spec.ts`, `.d.ts`,
// `.stories.tsx`, `.module.css`, `.config.js`. Adding more is safe
// (it only widens false-positive suppression); the risk is a real
// secret happening to be followed by `.<one-of-these>`, which is
// vanishingly unlikely for 40+-char tokens.
//
// Code-reviewer NIT on PR review: `.env` and `.lock` deliberately
// EXCLUDED — `.env` is the most common credential file extension
// (raw `KEY=VAL` lines pasted into source would have an `.env` tail
// in the path), and `.lock` is similar for credential dumps.
const PATH_TAIL_RE = /^\.(?:test\.|spec\.|d\.|stories\.|module\.|config\.)?(?:ts|tsx|js|jsx|mjs|cjs|md|mdx|json|jsonc|yml|yaml|toml|sh|bash|zsh|py|go|rs|java|kt|swift|c|cc|cpp|h|hh|hpp|cs|rb|php|css|scss|sass|less|html|htm|xml|svg|sql|txt|csv|tsv|ini|cfg|conf|log|map)\b/i

/**
 * SIG-93: returns true when `match` looks like a file path inside
 * `contextLine`. The 40+-char generic-token regex matches the path
 * body (`/`-separated segments) but stops at the `.` before the
 * extension — so the `.<ext>` suffix sits in the trailing context.
 *
 * Conservative on purpose: requires BOTH `/` in match AND a code
 * extension in the trailing context. A 40+-char base64 secret that
 * happens to land before `.json` in unrelated text is suppressed, but
 * that collision is acceptable (ARC-187 treats generic-token as a
 * noisy warn-only signal).
 *
 * Code-reviewer MAJOR on PR review: takes `matchOffset` (`match.index`
 * from the caller) instead of `contextLine.indexOf(match)`. If the
 * same token appears twice on one line (e.g., a fixture array with
 * duplicate paths), `indexOf` would always read trailing context from
 * the first occurrence — false suppression / leak risk on the second.
 */
function looksLikeFilePath(match: string, contextLine: string, matchOffset: number): boolean {
  if (!match.includes("/")) return false
  if (matchOffset < 0) return false
  const trailing = contextLine.slice(matchOffset + match.length, matchOffset + match.length + 20)
  return PATH_TAIL_RE.test(trailing)
}

/**
 * SIG-217: explicit allowlist of known-safe substrings that the generic
 * high-entropy catch-all repeatedly mis-flags as P0 secrets. Distinct from
 * `genericFalsePositive` (heuristic shape rejection) — this is a curated,
 * segment-aware list for the three classes that keep re-firing in real PRs.
 * Returns the suppression reason (for structured telemetry) or `null`.
 *
 * Why a separate function: the `genericFalsePositive` shapes each assume ONE
 * separator. The trigger FP — `opened/synchronize/reopened/ready_for_review`
 * (a JSDoc list of GitHub webhook actions) — mixes `/` (between events) and
 * `_` (inside `ready_for_review`), so no single-shape regex there catches it.
 * Splitting on the list separators and checking each segment against a known
 * vocabulary handles the mixed-separator case the shape rules can't.
 *
 * Pure — exported for tests.
 */
export type SecretAllowlistReason =
  | "github-webhook-event"
  | "screaming-env-var"
  | "kebab-json-key"

/**
 * GitHub webhook ACTION names. They show up as `/`-joined literal lists in
 * dispatcher code + JSDoc (e.g. `decidePullRequestJobs`) and, concatenated,
 * exceed the 40-char generic threshold. Includes pull_request, issues, review,
 * and review-thread actions — the sets that actually appear in handler prose.
 */
const GITHUB_WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  "opened", "edited", "closed", "reopened", "assigned", "unassigned",
  "review_requested", "review_request_removed", "ready_for_review",
  "converted_to_draft", "labeled", "unlabeled", "synchronize", "synchronized",
  "locked", "unlocked", "auto_merge_enabled", "auto_merge_disabled",
  "milestoned", "demilestoned", "enqueued", "dequeued", "pinned", "unpinned",
  "transferred", "submitted", "dismissed", "created", "deleted", "resolved",
  "unresolved",
])

// SCREAMING_SNAKE env-var identifiers. Digits allowed mid-token (S3_BUCKET,
// OAUTH2_SECRET) — but a real secret BODY carries digits in irregular,
// non-identifier positions, so this narrow shape never eats a credential.
// (base32/TOTP seeds are all-caps but carry NO underscore → still fire.)
const SCREAMING_ENV_VAR_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
// A "word-like" kebab segment: letters with an optional SHORT trailing digit
// run (oauth2, s3, sha256). Deliberately NOT `[a-z0-9]+` — that would admit
// high-entropy token segments like `2401440store` / `abcd1234efgh5678ijkl`,
// letting a real Slack/random token (`xoxb-…-abcd1234…`) be allowlisted. A
// genuine config key's segments are dictionary words; a token's are not.
const KEBAB_WORD_SEGMENT_RE = /^[a-z]+[0-9]*$/

export function secretAllowlistReason(match: string): SecretAllowlistReason | null {
  // 1. `/`- `,`- or `|`-joined lists where EVERY segment is a known webhook
  //    action. Requires ≥2 segments so a lone token can't sneak through on a
  //    single coincidental match.
  const eventSegments = match.split(/[/,|]/).filter((s) => s.length > 0)
  if (eventSegments.length >= 2 && eventSegments.every((s) => GITHUB_WEBHOOK_EVENTS.has(s))) {
    return "github-webhook-event"
  }
  // 2. SCREAMING_SNAKE env-var names.
  if (SCREAMING_ENV_VAR_RE.test(match)) return "screaming-env-var"
  // 3. kebab-case JSON keys: ≥2 hyphen-joined word-like segments.
  const kebabSegments = match.split("-")
  if (kebabSegments.length >= 2 && kebabSegments.every((s) => KEBAB_WORD_SEGMENT_RE.test(s))) {
    return "kebab-json-key"
  }
  return null
}

export interface SecretHit {
  ruleId: string
  category: SecretRule["category"]
  severity: "warn" | "error"
  path: string
  line: number
  /** Length of the matched secret. Useful as a sanity-check signal
   *  without leaking the value. */
  matchLength: number
  /** Redacted preview: first 4 + ... + last 4 chars. NEVER the full
   *  secret. */
  redactedPreview: string
  /**
   * Stable fingerprint = `${ruleId}:${path}:${line}:${redactedPreview}`.
   * Lets downstream dedupe across runs without storing the raw value.
   */
  fingerprint: string
}

const REDACTED_KEEP = 4

/**
 * Build the redacted preview. For values shorter than `2 * keep + 3`
 * the preview itself becomes meaningless — fall back to a length-only
 * placeholder so we don't leak short secrets in full.
 */
function redact(secret: string): string {
  if (secret.length <= REDACTED_KEEP * 2 + 3) {
    return `[redacted ${secret.length} chars]`
  }
  return `${secret.slice(0, REDACTED_KEEP)}…${secret.slice(-REDACTED_KEEP)}`
}

/**
 * Run all rules against added diff lines. Mirrors the diff-walking
 * approach of `deterministic-checks.ts` (header-detection guarded by
 * `inFileHeader`, line counting from `@@` hunk headers).
 *
 * Returns `[]` for empty diff. Never throws.
 */
export function runSecretScan(diff: string): SecretHit[] {
  if (!diff) return []
  const hits: SecretHit[] = []

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
      currentPath = p === "/dev/null" ? null : (p.startsWith("b/") ? p.slice(2) : p)
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
      const content = line.slice(1)
      // Track character spans claimed by earlier (more-specific)
      // rules on this line so the generic high-entropy catch-all
      // doesn't double-fire on the same substring. Provider-specific
      // rules listed earlier in RULES win.
      const claimedSpans: Array<{ start: number; end: number }> = []
      for (const rule of RULES) {
        const match = content.match(rule.pattern)
        if (!match) continue
        const matched = match[0] ?? ""
        if (matched.length === 0) continue
        const start = match.index ?? 0
        const end = start + matched.length
        // Skip if any previously-claimed span overlaps this match
        // (interval intersection: !(a.end <= b.start || b.end <= a.start)).
        const overlaps = claimedSpans.some((s) => !(end <= s.start || s.end <= start))
        if (overlaps) continue
        if (rule.id === "generic-high-entropy-token" && genericFalsePositive(matched, content, start)) continue
        // SIG-217: explicit allowlist gate for the generic catch-all. Each
        // suppression emits structured telemetry (Workers Observability
        // ingests these JSON lines) so we can track which safe class fired
        // and confirm the allowlist isn't masking real leaks. Redacted
        // preview only — never the raw substring.
        if (rule.id === "generic-high-entropy-token") {
          const allowReason = secretAllowlistReason(matched)
          if (allowReason) {
            console.log(JSON.stringify({
              event: "secret-scan-allowlist-suppressed",
              reason: allowReason,
              path: currentPath,
              line: newLine,
              match_length: matched.length,
              preview: redact(matched),
            }))
            continue
          }
        }
        const redacted = redact(matched)
        const fingerprint = `${rule.id}:${currentPath}:${newLine}:${redacted}`
        // Defense-in-depth: also dedupe identical fingerprints (same
        // path:line:redacted from the same rule on the same scan).
        if (hits.some((h) => h.fingerprint === fingerprint)) continue
        hits.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity ?? "error",
          path: currentPath,
          line: newLine,
          matchLength: matched.length,
          redactedPreview: redacted,
          fingerprint,
        })
        claimedSpans.push({ start, end })
      }
      newLine++
    } else if (line.startsWith(" ")) {
      newLine++
    } else if (line.startsWith("-")) {
      // deletion: doesn't advance new-file counter
    }
  }

  return hits
}

/**
 * The provider-specific (high-confidence, non-generic) rules. These are
 * the unambiguous credential shapes — AWS/GitHub/Slack/Stripe/OpenAI/
 * Anthropic/Ollama keys + PEM private-key headers. The generic
 * high-entropy catch-all (`generic-token`, `warn` severity) is excluded:
 * on its own it's noisy, so the credential predicate below requires it to
 * sit in a credential-named assignment before it counts.
 */
const PROVIDER_RULES: readonly SecretRule[] = RULES.filter(
  (r) => r.category !== "generic-token",
)

/**
 * Identifiers that, when ASSIGNED a long high-entropy value, make that
 * value credential-like even without a recognizable provider prefix
 * (e.g. `const apiKey = "<40 base64 chars>"`). Conservative on purpose —
 * only fires when the value is genuinely high-entropy (see below).
 */
const CREDENTIAL_IDENTIFIER_RE =
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|credential|client[_-]?secret|access[_-]?key|private[_-]?key|auth[_-]?token|bearer)\b/i

/**
 * A quoted (or `=`-assigned) high-entropy value: 32+ chars of base64/hex
 * alphabet that ISN'T a pure hash and ISN'T a pure single-case
 * identifier. Reuses the same false-positive philosophy as the generic
 * scan rule (`genericFalsePositive`) so a length/identifier/hash assigned
 * to a `key`-named field doesn't count as a credential.
 */
const HIGH_ENTROPY_VALUE_RE = /['"`]?([A-Za-z0-9+/=_-]{32,})['"`]?/

/**
 * SIG (secret-remediation gate): does a single line of cited code contain
 * a credential-like token?
 *
 * Used ONLY to gate the alarmist `secrets-exposure` remediation — the
 * deterministic fix text that says "treat the value as compromised,
 * revoke/rotate, rewrite history". That guidance must not fire on a
 * hallucinated secret finding (e.g. one that misread `console.log(x.length)`
 * as a leak), so the renderer first confirms the cited line actually holds
 * a credential.
 *
 * Detection is deliberately BIASED TOWARD FALSE (returning `false` keeps the
 * de-alarmed conditional remediation; a wrong `true` keeps the scary text):
 *   - A provider-specific rule matches (AKIA…, gh*_…, sk-…, sk_live_…,
 *     xox…-style Slack webhook, ollama_…, PEM header) → credential. These
 *     are the vetted, unambiguous shapes from the secret scanner.
 *   - OR a credential-named identifier (`apiKey`, `secret`, `token`,
 *     `password`, …) is assigned a 32+-char high-entropy value that is NOT
 *     a pure hex hash and NOT a pure single-case identifier (so a
 *     `const tokenName = "verylongLowerCamelIdentifier"` style false hit
 *     does not count).
 * Anything else (a `.length` count, a numeric literal, a placeholder, a
 * short value, a bare identifier) → `false`.
 *
 * Reuses the scanner's provider `RULES` rather than re-deriving them so the
 * vetted regexes stay the single source of truth.
 */
export function containsCredentialToken(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  // `collectCitedLineText` joins the cited range with "\n", so the input may
  // be multi-line. Check each line INDEPENDENTLY: the credential-named
  // identifier and the high-entropy value (path 2) must co-occur on ONE line
  // (a real assignment), never across unrelated lines — otherwise an
  // identifier on one line + an unrelated hash on another would false-match
  // and wrongly KEEP the alarmist remediation (Sigilix bot catch, #248).
  for (const line of text.split("\n")) {
    if (lineHasCredentialToken(line)) return true
  }
  return false
}

function lineHasCredentialToken(line: string): boolean {
  if (line.length === 0) return false

  // 1. Vetted provider-specific shapes — unambiguous credentials.
  for (const rule of PROVIDER_RULES) {
    if (rule.pattern.test(line)) return true
  }

  // 2. Credential-named assignment of a high-entropy value. Require BOTH a
  //    credential-named identifier AND a high-entropy literal on the line,
  //    then re-apply the generic-scan false-positive filter to the value so
  //    hashes / single-case identifiers assigned to a `key`-named field do
  //    not trip the gate.
  if (!CREDENTIAL_IDENTIFIER_RE.test(line)) return false
  const valueMatch = line.match(HIGH_ENTROPY_VALUE_RE)
  const value = valueMatch?.[1]
  if (!value) return false
  const offset = line.indexOf(value)
  if (genericFalsePositive(value, line, offset < 0 ? 0 : offset)) return false
  // A genuinely high-entropy credential body contains at least one digit
  // (mirrors the secret-scan single-case-identifier guard): pure-alpha
  // long values are far more likely identifiers/prose than secrets.
  if (!/[0-9]/.test(value)) return false
  return true
}

/**
 * Render hits as a labeled prompt block. Empty hits → empty string
 * so the orchestrator can skip the block entirely.
 *
 * SIG-282: hits are CANDIDATES from a regex pre-filter with a known
 * false-positive rate — NOT authoritative facts. The security
 * specialist triages each against the surrounding code (analyst
 * model), so the framing invites verification rather than demanding
 * escalation. Remediation text for a CONFIRMED secret is templated
 * downstream (deterministic), not asserted here.
 */
export function renderSecretHitsForPrompt(hits: SecretHit[]): string {
  if (hits.length === 0) return ""
  const lines = ["[SECRET SCAN — regex pre-filter run before the LLM. These are CANDIDATES with a known false-positive rate, NOT confirmed secrets. Verify each against the surrounding code before reporting it. Raw values redacted.]"]
  for (const h of hits) {
    lines.push(
      `- [${h.severity.toUpperCase()}] ${h.path}:${h.line} (${h.category}/${h.ruleId}) length=${h.matchLength} preview=${h.redactedPreview}`,
    )
  }
  lines.push("")
  lines.push("Confirm a candidate only if the surrounding code shows it is a real credential (used as an auth token, passed to a client/SDK, sent in an Authorization header, or matching a known provider key format). If the code shows it is public-by-design — a Subresource-Integrity hash next to a CDN/asset URL, a lockfile integrity field, a git SHA, a documented example, or a test fixture — it is a false positive; do not report it.")
  return lines.join("\n")
}
