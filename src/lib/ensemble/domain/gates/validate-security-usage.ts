// SIG-311 Layers A+B: security USAGE-vs-MENTION validator.
//
// The companion to Layer C (the no-exec-shell-interpolation import-binding fix)
// and the SIG-293 grounding gate. Layer C stopped the DETERMINISTIC exec rule
// from minting a `re.exec` fact; this gate catches the MODEL-side version of the
// same family — a security specialist firing a confident sev>=4 injection/xss
// finding on code that merely MENTIONS a dangerous construct (the keyword in a
// detector's regex literal, a test name, a comment, a markdown fence, or our own
// validator source) rather than a real exploitable USAGE. The dogfood smoking
// gun (PR #296: a P0 "command injection" on `re.exec` inside the XSS detector)
// and its family (PR #308 regex-literal edit, PR #293 runner.ts) are exactly
// this "reviews its own security-mentioning repo badly" shape.
//
// SOUNDNESS — DEMOTE (never hard-drop, content preserved in the body) a sev>=4
// injection/xss finding ONLY when ALL THREE hold:
//   (A) PATH-CONTEXT: the cited path is a mention surface — an ast-rules/
//       detector, a validate-*.ts gate, a *.test.ts / *.spec.ts, a tests/ or
//       __tests__/ file, or a *.md doc. MDX can contain executable JSX and is
//       intentionally not treated as prose-only.
//   (B) NON-EXECUTABLE POSITION: the bucket's dangerous token on the cited code
//       is provably not a live call — present only inside a blanked string /
//       comment, OR a `.exec(` on a RegExp-conventional receiver (RegExp.exec,
//       never a shell).
//   (C) HARNESS GUARD: the cited file's added text does NOT itself add a real
//       sink (a child_process import or executable shell call for injection, an
//       executable HTML-write for xss) — so a genuine harness that also shells
//       out is protected.
//
// THE RECALL RULE (DeepSeek-validated): (A) NEVER demotes alone — it must
// co-fire with (B). Every parse ambiguity, missing diff, or token-not-in-hand
// returns KEEP. Hiding a real P0 is far worse than the FP, so this gate fails
// closed to KEEP on any uncertainty — the SIG-290 / SIG-293 posture.
//
// SHADOW-FIRST: the demotion is gated behind
// `OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE` (off | shadow | enforce, default off)
// at the call site. This module is pure and mode-agnostic.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { deriveSecurityBucket, type SecurityBucket } from "./validate-security-finding"
import { blank } from "@/src/features/ast-rules"

export type SecurityUsageValidatorMode = "off" | "shadow" | "enforce"

/** Parse `OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE`. Unknown/missing → `off` (a
 *  security-critical gate must never auto-enable on a typo). */
export function parseSecurityUsageValidatorMode(raw: string | undefined): SecurityUsageValidatorMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

export type SecurityUsageDropReason = "security-mention-not-usage"
export type SecurityUsageDecision = { keep: true } | { keep: false; reason: SecurityUsageDropReason }

export interface SecurityUsageContext {
  /** Per-file new-side added-line text (same `buildAddedLineTextByLine` map the
   *  ensemble threads to the other gates). Undefined when the diff isn't wired
   *  → the gate keeps every finding. */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
}

/** Only the two keyword-bearing buckets where mention-vs-usage is decidable at
 *  the line level. secrets-exposure is handled by SIG-293; the absence-class
 *  buckets have no line signature and are never gated here. */
const GATED_BUCKETS: ReadonlySet<SecurityBucket> = new Set<SecurityBucket>(["injection", "xss"])

/** (A) Mention-surface paths: detector / validator / test / doc. */
const MENTION_PATH_RE =
  /(?:\/ast-rules\/)|(?:(?:^|\/)validate-[^/]*\.ts$)|(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:tests|__tests__)\/)|(?:\.md$)/i
// MDX intentionally NOT included — it can execute JSX; see the header comment.
const DOC_PATH_RE = /\.md$/i

/** Bucket-specific dangerous token in an EXECUTABLE shape. */
const INJECTION_CALL_RE =
  /\b(?:exec|execSync|execFile|execFileSync|eval|spawn|spawnSync|system|popen|shell_exec|execa)\s*\(|\bRuntime\s*\.\s*exec\s*\(|\bshell\s*\.\s*exec\s*\(/
const XSS_TOKEN_RE =
  /\b(?:dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|srcdoc|setHTMLUnsafe)\b|\bdocument\s*\.\s*(?:write|writeln)\s*\(/
const SHELL_MODULE_RE = /[`"'](?:node:)?child_process[`"']|[`"'](?:execa|shelljs|cross-spawn|@actions\/exec)[`"']/
const TRIVIAL_ASSESSMENT_RE = /^(?:none|n\/a|not applicable|unknown)$/i
const ASSESSMENT_SINK_RE =
  /(?:\bchild_process(?:\s*\.\s*(?:exec(?:Sync|File|FileSync)?|spawn(?:Sync)?))?\b|\b(?:exec(?:Sync|File|FileSync)?|spawn(?:Sync)?|eval|system|popen|shell_exec)\s*(?:\(|\b(?:sink|call|function|command|execution)\b)|\bRuntime\s*\.\s*exec\b|\bshell\s*\.\s*exec\b|\b(?:execa|shelljs|cross-spawn)\b|@actions\/exec\b|\bshell\s+(?:sink|command|executor|execution)\b)/i
const ASSESSMENT_FLOW_RE =
  /\b(?:req|request)\s*\.\s*(?:query|body|params|headers)\b|\b(?:user[ -]?(?:input|supplied|controlled|provided)|attacker(?:[ -]?controlled)?|tainted?|untrusted|interpolat(?:ed|ion)|source|flow(?:s|ed)?|fed by|reaches|passes to|supplied to)\b/i
const ASSESSMENT_CODE_REF_RE = /\b[\w./-]+\.[cm]?[jt]sx?:\d+\b|\bline\s+\d+\b/i
/** `.exec(` on a RegExp-conventional receiver — `RegExp.prototype.exec`, never a
 *  shell (the PR #296 model-FP shape). */
const REGEX_EXEC_RE =
  /(?<![\w$])(?:re|reg|regex|regexp|rx|pattern|[A-Za-z_$][\w$]*(?:Re|Regex|Regexp|Pattern|Rx))\.exec\s*\(/

function bucketTokenRe(bucket: SecurityBucket): RegExp | null {
  if (bucket === "injection") return INJECTION_CALL_RE
  if (bucket === "xss") return XSS_TOKEN_RE
  return null
}

function hasBucketToken(cited: string, bucket: SecurityBucket): boolean {
  const re = bucketTokenRe(bucket)
  return re !== null && re.test(cited)
}

/**
 * Cited code for a finding from the per-line added-text map — the [startLine,
 * line] range joined with "\n". Returns null (→ keep, FP-safe) unless EVERY
 * cited line resolves to a visible added line (a partial range that spans an
 * unchanged context line = "not fully in hand" → keep). Mirrors SIG-293's
 * `collectCitedCode`.
 */
function collectCitedCode(
  finding: PrReviewFinding,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string | null {
  const lineMap = addedLineTextByLine.get(finding.path)
  if (!lineMap || lineMap.size === 0) return null
  const lo = Math.min(finding.startLine ?? finding.line, finding.line)
  const hi = Math.max(finding.startLine ?? finding.line, finding.line)
  const lines: string[] = []
  for (let ln = lo; ln <= hi; ln++) {
    const text = lineMap.get(ln)
    if (text === undefined) return null
    lines.push(text)
  }
  return lines.length > 0 ? lines.join("\n") : null
}

function collectNearbyAddedCode(
  finding: PrReviewFinding,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>>,
  radius = 5,
): string | null {
  const lineMap = addedLineTextByLine.get(finding.path)
  if (!lineMap || lineMap.size === 0) return null
  const lo = Math.max(1, finding.line - radius)
  const hi = finding.line + radius
  const lines: string[] = []
  for (let ln = lo; ln <= hi; ln++) {
    const text = lineMap.get(ln)
    if (text !== undefined) lines.push(text)
  }
  return lines.length > 0 ? lines.join("\n") : null
}

/** (B) Is the bucket's dangerous token a MENTION (non-executable) in `cited`? */
function isMentionNotUsage(cited: string, bucket: SecurityBucket, path: string): boolean {
  const re = bucketTokenRe(bucket)
  if (re === null || !re.test(cited)) return false // token not present → can't prove a mention → keep
  if (DOC_PATH_RE.test(path)) return true // markdown docs are prose/examples, not executable code.
  const code = blank(cited, true) // blank comments + string bodies
  if (!re.test(code)) return true // token survived only in a string/comment → mention
  // Executable but benign: EVERY surviving injection-shaped token is a `.exec(`
  // on a RegExp-conventional receiver. Strip those and re-test, so a span that
  // ALSO holds a real `execSync(...)` is NOT read as a mention (CodeRabbit #317).
  if (bucket === "injection") {
    const withoutRegexExec = code.replace(new RegExp(REGEX_EXEC_RE.source, "gi"), " ")
    if (!INJECTION_CALL_RE.test(withoutRegexExec)) return true
  }
  return false
}

/** (C) Does the file's added text itself add a REAL sink (don't demote over it)? */
function fileAddsRealSink(addedFileText: string, bucket: SecurityBucket, path: string): boolean {
  if (DOC_PATH_RE.test(path)) return false // markdown examples are not runtime sinks.
  if (bucket === "injection") {
    // A real shell-runner import gives the file shell capability — keep. The
    // module specifier is a string literal, so check the UN-blanked text. Also
    // keep if the added code itself contains any executable shell-shaped call
    // after strings/comments and benign RegExp `.exec(` uses are removed; this
    // protects files whose import/binding lives outside the diff.
    if (SHELL_MODULE_RE.test(addedFileText)) return true
    const executableAddedCode = blank(addedFileText, true).replace(new RegExp(REGEX_EXEC_RE.source, "gi"), " ")
    return INJECTION_CALL_RE.test(executableAddedCode)
  }
  // xss: a real executable HTML-write (not a mention) anywhere in the added code.
  // Sink set aligned with XSS_TOKEN_RE so a real srcdoc/setHTMLUnsafe also guards
  // (CodeRabbit #317).
  return XSS_TOKEN_RE.test(blank(addedFileText, true))
}

function hasPositiveSinkAssessment(finding: PrReviewFinding, bucket: SecurityBucket): boolean {
  // Keep this escape hatch injection-only. The reviewer counterexample is a
  // pre-existing shell sink with a model anchor on a newly-added mention line;
  // XSS mentions in test names are much easier for the model to over-justify,
  // while newly-added executable XSS sinks are already protected by
  // fileAddsRealSink's deterministic full-added-file scan.
  if (bucket !== "injection") return false
  const text = finding.independentAssessment?.trim()
  if (!text) return false
  if (TRIVIAL_ASSESSMENT_RE.test(text)) return false
  // The escape hatch is recall-only: accept it only when the model cites a
  // concrete shell sink plus either data-flow evidence or a code location. Vague
  // risk language must not bypass the deterministic mention proof.
  return ASSESSMENT_SINK_RE.test(text) && (ASSESSMENT_FLOW_RE.test(text) || ASSESSMENT_CODE_REF_RE.test(text))
}

/**
 * Pure decision for ONE finding. Mode-agnostic. Order (each short-circuits to
 * KEEP, narrowest first): not-a-gated-bucket → score<4 → not-a-mention-path →
 * no-diff → cited-code-not-in-hand → not-a-mention (B) → file-adds-real-sink (C).
 * Only a sev>=4 injection/xss finding that survives all keep-paths — on a
 * mention surface, with a provably non-executable token, in a file that adds no
 * real sink — is demoted. Never throws, no I/O.
 */
export function evaluateSecurityUsage(finding: PrReviewFinding, context: SecurityUsageContext): SecurityUsageDecision {
  const bucket = deriveSecurityBucket(finding)
  if (bucket === null || !GATED_BUCKETS.has(bucket)) return { keep: true }
  if ((finding.score ?? 0) < 4) return { keep: true } // P2/P3 advisories aren't the partner-facing harm
  // (A) path-context — never the sole reason (the recall rule), but the cheapest gate.
  if (!MENTION_PATH_RE.test(finding.path)) return { keep: true }
  if (context.addedLineTextByLine === undefined) return { keep: true } // no diff → keep
  const cited = collectCitedCode(finding, context.addedLineTextByLine)
  if (cited === null || cited.trim().length === 0) return { keep: true } // not in hand → keep
  // (B) non-executable position — the mandatory conjunction partner.
  let mention = isMentionNotUsage(cited, bucket, finding.path)
  // Models sometimes anchor a multiline rule message / test name to the
  // neighboring added line. Only use a tiny local window when the exact cited
  // line does NOT itself contain the dangerous token; if it does, the exact
  // line's executable-vs-mention decision wins.
  if (!mention && !hasBucketToken(cited, bucket)) {
    const nearby = collectNearbyAddedCode(finding, context.addedLineTextByLine)
    mention =
      nearby !== null &&
      !fileAddsRealSink(nearby, bucket, finding.path) &&
      isMentionNotUsage(nearby, bucket, finding.path)
  }
  if (!mention) return { keep: true }
  // (C) harness guard — the file itself doesn't add a real sink.
  const addedFileText = [...(context.addedLineTextByLine.get(finding.path)?.values() ?? [])].join("\n")
  if (fileAddsRealSink(addedFileText, bucket, finding.path)) return { keep: true }
  // The SIG-311 prompt requires concrete sink-resolution proof in
  // independentAssessment for sev>=4 security-tooling/test/doc findings. If the
  // specialist provided that positive evidence, keep inline; the real sink may
  // be in unchanged context not present in addedLineTextByLine.
  if (hasPositiveSinkAssessment(finding, bucket)) return { keep: true }
  return { keep: false, reason: "security-mention-not-usage" }
}
