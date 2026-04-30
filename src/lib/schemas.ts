// JSON Schemas passed to Ollama's `format` field for schema-constrained
// decoding. The runtime enforces these during generation — every token
// produced by the model must conform, so we never see malformed JSON
// or missing-field errors.
//
// Reference: https://docs.ollama.com/structured-outputs
//
// Each schema mirrors the parser's expectations in the corresponding
// handler. If a parser changes, update the schema (and vice versa).

/**
 * pr-overview verdict (top-level PR comment).
 * Mirrors PrOverviewVerdict in src/lib/triage-pr-overview.ts.
 */
export const PR_OVERVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
    confidenceReason: { type: "string" },
    files: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          score: { type: "integer", minimum: 1, maximum: 5 },
          overview: { type: "string" },
          nextStep: { type: "string" },
        },
        required: ["path", "score", "overview", "nextStep"],
      },
    },
    bullets: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "confidence", "confidenceReason", "files", "bullets"],
} as const

/**
 * pr-review verdict (proactive primary review with inline findings).
 * Mirrors PrReviewVerdict in src/lib/triage-pr-review.ts.
 */
export const PR_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
    confidenceReason: { type: "string" },
    findings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          startLine: { type: "integer", minimum: 1 },
          score: { type: "integer", minimum: 1, maximum: 5 },
          headline: { type: "string" },
          body: { type: "string" },
        },
        required: ["path", "line", "score", "headline", "body"],
      },
    },
  },
  required: ["summary", "confidence", "confidenceReason", "findings"],
} as const

/**
 * cr-eval verdict array (one verdict per CR comment evaluated).
 * Mirrors CrVerdict[] in src/lib/triage-cr.ts.
 *
 * Note: schema is the array itself — Ollama accepts top-level array
 * schemas. Keys match the parser's discriminated-union expectations.
 */
export const CR_EVAL_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      commentId: { type: "integer" },
      classification: {
        type: "string",
        enum: ["ACCEPT", "SKIP_NITPICK", "SKIP_OUT_OF_SCOPE", "SKIP_FALSE_POSITIVE"],
      },
      headline: { type: "string" },
      body: { type: "string" },
      opener: { type: "string" },
      location: { type: "string" },
    },
    required: ["commentId", "classification", "headline", "body"],
  },
} as const

/**
 * Issue-triage verdict (Linear issue post + field updates).
 * Mirrors Verdict in src/lib/triage.ts.
 */
export const ISSUE_TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    estimate: { type: "string", enum: ["trivial", "S", "M", "L", "XL"] },
    labels: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
    summary: { type: "string" },
    approach: { type: "string" },
    relevantFiles: {
      type: "array",
      items: { type: "string" },
    },
    research: { type: "string" },
    diagram: { type: "string" },
    improvedDescription: { type: "string" },
  },
  required: ["headline", "severity", "estimate", "labels", "summary", "approach"],
} as const

/**
 * Mention-reply verdict (Linear @-mention answer).
 * Mirrors MentionVerdict in src/lib/mention-reply.ts.
 */
export const MENTION_REPLY_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
    abstain: { type: "boolean" },
  },
  required: ["answer", "confidence", "abstain"],
} as const
