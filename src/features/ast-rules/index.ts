// SIG-318 P2 / SIG-383: ast-rules feature barrel — the ONLY legal
// cross-feature import surface. External consumers reach this feature via
// `@/features/ast-rules`; its internal layers (domain / app / render) stay
// private behind this re-export. No logic here.

export { runAstRules } from "./app/runner"
export { postAstInlineFindings } from "./app/inline-poster"

export { renderAstFindingsForPrompt, renderAstFindingsAsJsonForSynth } from "./render/render"

export { parseSource } from "./domain/parser"
export type { SourceExt } from "./domain/parser"
export { createAstCache } from "./domain/parse-cache"
export type { AstCache } from "./domain/parse-cache"
export { walkAst } from "./domain/walker"
export type { AstNode } from "./domain/walker"
export type { AstFinding } from "./domain/types"
export {
  buildChangedLines,
  buildAddedLineTextByLine,
  buildDeletedLineTextByLine,
  nodeOverlapsChanged,
} from "./domain/diff-filter"
export type { ChangedLines } from "./domain/diff-filter"
export { blank } from "./domain/scan-utils"
export { DYNAMIC_HTML_SINK_RULE_ID } from "./domain/scan-dynamic-html-sink"
export { analyzeHelperBypass, renderAsymmetryHints } from "./domain/analyze-helper-bypass"
export { analyzeToctouRace, renderToctouHints } from "./domain/analyze-toctou-race"
export { durableObjectClassSpans, lineInDurableObjectClass } from "./domain/durable-object-spans"
export type { LineSpan } from "./domain/durable-object-spans"
