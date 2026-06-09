// ARC-181: rule contract + finding shapes for the AST rule pack.
//
// Each rule is a TS module that exports an `AstRule`. The runner
// invokes `visit(node, ctx)` for each AST node whose `node.type`
// matches the rule's declared `nodeTypes` list, and the rule returns
// zero or more hits.
//
// The runner — not the rule — knows about diff filtering, finding
// IDs, and the GitHub review-position resolution. Rules are pure
// AST-shape predicates so they're trivially testable in isolation.

import type { AstNode } from "./walker"

export type Severity = "info" | "warning" | "error"
export type RoleHint = "security" | "logic" | "performance" | "tests"
export type AstRuleVisitResult = AstRuleHit | AstRuleHit[] | null

/**
 * Rule definition shipped under `src/features/ast-rules/domain/rules/<id>.ts`.
 */
export interface AstRule {
  /** kebab-case stable identifier; appears in user config + telemetry. */
  id: string
  severity: Severity
  roleHint: RoleHint
  /** 1-line headline shown in the prompt block + inline comment. */
  shortDescription: string
  /** v1 supports both — language filter happens at the runner. */
  language: "js" | "ts" | "both"
  /**
   * AST node type names the runner should call `visit` on. Empty
   * array means visit every node type (rare; most rules want a
   * specific node).
   */
  nodeTypes: string[]
  /**
   * SIG-309 PR2: when true, the synth EMITS this rule's finding even when NO
   * specialist raised the same issue (a deterministic high-confidence
   * detection). Set ONLY on rules that are FP-safe by construction — they do
   * NOT fire on benign constant code: the shell/command-injection sinks
   * (`spawn-shell-true` requires `{shell:true}`, `no-exec-shell-interpolation`
   * skips constant commands) and disabled-TLS (`rejectUnauthorized:false` is
   * unambiguous). Deliberately NOT on `no-eval-call` / `no-new-function-
   * constructor` / `no-document-write-call` — those fire on constant args too,
   * so an unmatched one could be benign (the constant-eval FP that keeps
   * autoInline off by default). Default false.
   */
  emitWhenUnmatched?: boolean
  visit(node: AstNode, ctx: RuleContext): AstRuleVisitResult
}

export interface RuleContext {
  /** Path of the file being scanned. Provided so a rule can do
   *  per-file pre-passes (see `no-floating-promise-call-known-async`). */
  path: string
  /** Source text of the file. Rules can slice it for the `evidence`
   *  field; the runner truncates to ≤200 chars and redacts string
   *  literals > 40 chars before emitting. */
  source: string
  /** AST root for the file. Lets a rule walk siblings if needed for
   *  a same-file pre-pass. */
  ast: AstNode
}

export interface AstRuleHit {
  message: string
  /** Raw source slice; the runner sanitizes before emitting. */
  evidence: string
  /** 1-based line number from acorn `loc.start.line`. */
  line: number
  /**
   * 1-based end line from acorn `loc.end.line`. Optional — when
   * absent the runner treats the span as a single line. CR catch on
   * PR #67: rules that match multi-line nodes (function bodies, loop
   * bodies) MUST set this so the diff-line filter sees edits later
   * in the body, not just at the node's start line.
   */
  endLine?: number
  /** 0-based column from acorn `loc.start.column`. */
  column: number
}

export interface AstFinding extends AstRuleHit {
  ruleId: string
  severity: Severity
  roleHint: RoleHint
  path: string
  /** Stable ID of shape `ast/<ruleId>/<pathHash7>/<line>`. Carried
   *  through synth supersession + audit-marker rendering. */
  astFindingId: string
  /** SIG-309 PR2: copied from the rule's `emitWhenUnmatched`; surfaced to the
   *  synth as `deterministic_emit` so an unmatched high-confidence security
   *  sink is emitted (through the normal grounding pipeline), not dropped. */
  emitWhenUnmatched?: boolean
}
