// ARC-181: AST scan runner. Stitches the parser, rule registry,
// diff-line filter, and finding-id helpers into a single
// `runAstRules` entry point that the ensemble orchestrator calls
// before specialist fanout.
//
// Pipeline per file:
//   1. Skip if extension is not JS/TS
//   2. Skip if file > 500 KB (large-file telemetry)
//   3. Parse via acorn(+TS plugin); on failure, telemetry + skip
//   4. For each enabled rule: walk AST, collect rule hits at
//      matching node types
//   5. Filter hits by `nodeOverlapsChanged` (changed-lines on the
//      new side)
//   6. Resolve each kept hit to a review position via
//      `findReviewPosition` (null when not reviewable)
//   7. Construct AstFinding with stable astFindingId
//
// Returns `{ findings, perFinding, telemetry }`. The runner does
// NOT post inline comments — that's Task 9's `postAstInlineFindings`
// gated by `astRules.autoInline`.

import { parseSource, type SourceExt } from "./parser"
import { walkAst, type AstNode } from "./walker"
import {
  buildChangedLines,
  nodeOverlapsChanged,
  findReviewPosition,
  type ChangedLines,
} from "./diff-filter"
import { astFindingId } from "./finding-id"
import {
  getEnabledRules,
  ruleEnabledByConfig,
  type ResolvedAstRulesConfig,
} from "./rule-registry"
import type { AstFinding, AstRule, AstRuleHit, RuleContext } from "./types"
import type { ReviewableMap } from "../diff-positions"
import { scanDynamicHtmlSinks, DYNAMIC_HTML_SINK_RULE_ID } from "./scan-dynamic-html-sink"

// SIG-312: the dynamic-HTML-sink XSS detector is a LINE-SCAN (the walker can't
// reach `dangerouslySetInnerHTML` — it's a JSX attribute, and JSX isn't
// traversed). We splice its hits into the same finding pipeline as the AST
// rules via this synthetic rule descriptor: `warning`/`security`, and
// `emitWhenUnmatched` so a dynamic HTML sink is deterministically SURFACED.
//
// Severity is `warning` (P2), not `error` (P0/P1), by design: a line-scan can't
// prove whether the value is attacker-influenced vs a trusted constant/i18n
// table (code-review CRITICAL: `TEMPLATES.welcomeHtml` would otherwise flag
// P0/P1). So this is an FP-safe ADVISORY that surfaces the sink; the model's
// security specialist still raises its OWN P0/P1 when it judges the value
// untrusted (and supersedes this), so no recall is lost on a real XSS. The
// `warning`→P2 ceiling is enforced by the synth emit instruction; the score
// clamp deliberately does NOT cap security findings (it would demote a real
// model-caught XSS). `nodeTypes: []` + the no-op `visit` ensure the walker
// never invokes it as an AST rule.
const DYNAMIC_HTML_SINK_PSEUDO_RULE: AstRule = {
  id: DYNAMIC_HTML_SINK_RULE_ID,
  severity: "warning",
  roleHint: "security",
  shortDescription: "Dynamic value rendered as raw HTML via an HTML-injection sink — verify sanitization",
  language: "both",
  nodeTypes: [],
  emitWhenUnmatched: true,
  visit: () => null,
}

const LARGE_FILE_BYTES = 500_000
const EVIDENCE_MAX_CHARS = 200

const SUPPORTED_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/

export interface RunAstRulesArgs {
  /** Unified diff for the PR. */
  diff: string
  /** Map of new-file path → source code at the PR head. Files
   *  excluded by `pathFilters` MUST already be filtered out by the
   *  caller (Task 11 contract). */
  filesByPath: Map<string, string>
  /** Output of `parseDiffToReviewablePositions(diff)` — used to
   *  resolve auto-inline review positions for `error`-severity
   *  findings. */
  reviewable: ReviewableMap
  /** Resolved astRules config (defaults already filled in). */
  config: ResolvedAstRulesConfig
  /** Telemetry context. */
  ctx: { owner: string; repo: string; prNumber: number }
}

export interface RunnerTelemetry {
  scanned: boolean
  skipReason?: "disabled-config" | "no-js-ts-files"
  filesScanned: number
  filesSkippedLarge: number
  filesParseFailed: number
  durationMs: number
}

export interface RunAstRulesResult {
  findings: AstFinding[]
  /** Resolved review position per astFindingId, or null when none.
   *  Task 9 (auto-inline poster) consumes this map. */
  perFinding: Map<string, { line: number; side: "RIGHT" } | null>
  telemetry: RunnerTelemetry
}

function getExt(path: string): SourceExt | null {
  const m = SUPPORTED_EXT_RE.exec(path.toLowerCase())
  return m ? (`.${m[1]}` as SourceExt) : null
}

function redactEvidence(raw: string): string {
  // Naive redaction: collapse any single/double/backtick-delimited
  // string literal whose body exceeds the threshold to a placeholder.
  // The runner only reaches here on rule-emitted evidence which is
  // already a syntactic slice; full lexical analysis isn't needed.
  // CR catch on PR #67: `.` doesn't match newlines, so a long
  // multi-line template literal would slip past the redaction. Use
  // `[\s\S]` to match any character including `\n`.
  const stringRe = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S]){40,})\1/g
  const collapsed = raw.replace(stringRe, (_full, q) => `${q}<redacted-literal>${q}`)
  return collapsed.length > EVIDENCE_MAX_CHARS
    ? collapsed.slice(0, EVIDENCE_MAX_CHARS) + "…"
    : collapsed
}

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function normalizeHits(hit: AstRuleHit | AstRuleHit[] | null): AstRuleHit[] {
  if (!hit) return []
  return Array.isArray(hit) ? hit : [hit]
}

export async function runAstRules(args: RunAstRulesArgs): Promise<RunAstRulesResult> {
  const { diff, filesByPath, reviewable, config, ctx } = args
  const t0 = Date.now()

  if (!config.enabled) {
    emitTelemetry("ast-rules-scan-skipped", {
      reason: "disabled-config",
      ...ctx,
    })
    return {
      findings: [],
      perFinding: new Map(),
      telemetry: {
        scanned: false,
        skipReason: "disabled-config",
        filesScanned: 0,
        filesSkippedLarge: 0,
        filesParseFailed: 0,
        durationMs: Date.now() - t0,
      },
    }
  }

  const enabledRules = getEnabledRules(config)
  const changedLines: ChangedLines = buildChangedLines(diff)

  const findings: AstFinding[] = []
  const perFinding: Map<string, { line: number; side: "RIGHT" } | null> = new Map()
  // CR catch on PR #67: dedupe by `astFindingId`. Two rule hits at
  // the same `(ruleId, path, line)` collapse to a single finding —
  // otherwise downstream gets duplicate IDs while `perFinding` keeps
  // only one entry, producing inconsistent state.
  const emittedFindingIds = new Set<string>()

  let filesScanned = 0
  let filesSkippedLarge = 0
  let filesParseFailed = 0
  let anyJsTs = false

  for (const [path, source] of filesByPath.entries()) {
    const ext = getExt(path)
    if (!ext) continue
    anyJsTs = true

    // CR catch on PR #67: compare BYTE length, not UTF-16 code-unit
    // length. Non-ASCII source files would otherwise sneak past the
    // 500 KB guard and slow down acorn parsing.
    const sourceBytes = new TextEncoder().encode(source).length
    if (sourceBytes > LARGE_FILE_BYTES) {
      filesSkippedLarge++
      emitTelemetry("ast-rules-scan-skipped-large-file", {
        path,
        sizeBytes: sourceBytes,
        ...ctx,
      })
      continue
    }

    const parsed = parseSource(source, ext)
    if (!parsed.ok) {
      filesParseFailed++
      emitTelemetry("ast-rules-parse-failed", {
        path,
        errMessage: parsed.reason,
        ...ctx,
      })
      continue
    }

    filesScanned++
    const ruleCtx: RuleContext = {
      path,
      source,
      ast: parsed.ast,
    }

    // Group rules by node type so a single walk dispatches all
    // matching visitors.
    const rulesByType: Map<string, AstRule[]> = new Map()
    for (const rule of enabledRules) {
      if (rule.language === "js" && (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts")) continue
      if (rule.language === "ts" && (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs")) continue
      for (const t of rule.nodeTypes) {
        if (!rulesByType.has(t)) rulesByType.set(t, [])
        rulesByType.get(t)!.push(rule)
      }
    }

    const visitors: Record<string, (node: AstNode) => void> = {}
    const fileHits: Array<{ rule: AstRule; hit: AstRuleHit }> = []
    for (const [type, ruleList] of rulesByType.entries()) {
      visitors[type] = (node: AstNode) => {
        for (const rule of ruleList) {
          try {
            const hit = rule.visit(node, ruleCtx)
            for (const candidate of normalizeHits(hit)) {
              fileHits.push({ rule, hit: candidate })
            }
          } catch (err) {
            emitTelemetry("ast-rules-rule-threw", {
              path,
              ruleId: rule.id,
              errMessage: err instanceof Error ? err.message : String(err),
              ...ctx,
            })
          }
        }
      }
    }

    walkAst(parsed.ast, visitors)

    // SIG-312: line-scan the source for an untrusted dynamic value flowing into
    // an HTML-injection sink (dangerouslySetInnerHTML / innerHTML / …) — the
    // walker can't reach JSX attributes, so this complements the AST pass. The
    // hits join `fileHits` under a synthetic security rule and flow through the
    // SAME changed-line filter, finding-id, dedupe, and emit path below.
    //
    // Scoped to parse-OK files (we're past the `parsed.ok` gate): every real
    // React/TS file parses, so the recurring miss is covered. A file that fails
    // to parse is a rare malformed edge — it's skipped here exactly as the AST
    // rules skip it, and the model specialist still reviews it.
    //
    // Honor the full config predicate (CodeRabbit #296): the pseudo rule
    // bypasses `getEnabledRules`, so gate the scan on the SAME enablement check
    // (disabledRules AND severityThreshold) to keep it suppressible / threshold-
    // gated exactly like a registry rule.
    if (ruleEnabledByConfig(config, DYNAMIC_HTML_SINK_RULE_ID, DYNAMIC_HTML_SINK_PSEUDO_RULE.severity)) {
      for (const hit of scanDynamicHtmlSinks(source)) {
        fileHits.push({ rule: DYNAMIC_HTML_SINK_PSEUDO_RULE, hit })
      }
    }

    // Filter hits by changed-lines + emit findings.
    for (const { rule, hit } of fileHits) {
      // Hit's line span. CR catch on PR #67: when `endLine` is set,
      // the diff-line filter walks the full inclusive range so edits
      // later in a multi-line body trigger the finding even when
      // `hit.line` (the node's start) is in untouched code.
      const endLine = hit.endLine ?? hit.line
      if (!nodeOverlapsChanged(changedLines, path, hit.line, endLine)) continue

      const id = await astFindingId(rule.id, path, hit.line)
      // Dedupe: same (rule, path, line) → one finding only.
      if (emittedFindingIds.has(id)) continue
      emittedFindingIds.add(id)
      const reviewPos = findReviewPosition(reviewable, path, hit.line)
      if (reviewPos === null) {
        emitTelemetry("ast-rules-finding-no-review-position", {
          ruleId: rule.id,
          path,
          line: hit.line,
          ...ctx,
        })
      }

      const finding: AstFinding = {
        ruleId: rule.id,
        severity: rule.severity,
        roleHint: rule.roleHint,
        path,
        line: hit.line,
        // Codex review (MEDIUM): carry endLine through to the finding —
        // it was dropped here, collapsing multi-line AST findings to a
        // single line in the diff-filter (the PR-67 fix) AND the SIG-109
        // validator's co-location window.
        ...(typeof hit.endLine === "number" ? { endLine: hit.endLine } : {}),
        column: hit.column,
        message: hit.message,
        evidence: redactEvidence(hit.evidence),
        astFindingId: id,
        // SIG-309 PR2: carry the rule's emit-when-unmatched flag onto the
        // finding so the synth renderer can mark it `deterministic_emit`.
        ...(rule.emitWhenUnmatched ? { emitWhenUnmatched: true } : {}),
      }
      findings.push(finding)
      perFinding.set(id, reviewPos)

      emitTelemetry("ast-rules-finding", {
        ruleId: rule.id,
        severity: rule.severity,
        roleHint: rule.roleHint,
        path,
        line: hit.line,
        ...ctx,
      })
    }
  }

  if (!anyJsTs) {
    emitTelemetry("ast-rules-scan-skipped", {
      reason: "no-js-ts-files",
      ...ctx,
    })
    return {
      findings: [],
      perFinding,
      telemetry: {
        scanned: false,
        skipReason: "no-js-ts-files",
        filesScanned: 0,
        filesSkippedLarge,
        filesParseFailed,
        durationMs: Date.now() - t0,
      },
    }
  }

  emitTelemetry("ast-rules-scan-ran", {
    filesScanned,
    findingsCount: findings.length,
    durationMs: Date.now() - t0,
    ...ctx,
  })

  return {
    findings,
    perFinding,
    telemetry: {
      scanned: true,
      filesScanned,
      filesSkippedLarge,
      filesParseFailed,
      durationMs: Date.now() - t0,
    },
  }
}
