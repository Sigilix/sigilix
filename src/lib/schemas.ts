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
          category: {
            type: "string",
            enum: [
              "logic",
              "security",
              "performance",
              "error-handling",
              "testing",
              "complexity",
              "style",
              "syntax",
              "docs",
            ],
          },
          headline: { type: "string" },
          body: { type: "string" },
        },
        required: ["path", "line", "score", "category", "headline", "body"],
      },
    },
  },
  required: ["summary", "confidence", "confidenceReason", "findings"],
} as const

/**
 * Issue-triage verdict (Linear issue post + field updates).
 * Mirrors Verdict in src/lib/triage.ts.
 */
export const ISSUE_TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    // Programmatic fields — applied to the Linear issue (priority,
    // estimate, labels) and used to render the [tag] header. The
    // model controls these as data, not prose.
    headline: { type: "string" },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    estimate: { type: "string", enum: ["trivial", "S", "M", "L", "XL"] },
    labels: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
    // Free-form Markdown body. The model writes whatever shape it
    // wants here — its own headers, bullet lists, file refs, prior
    // art, optional Mermaid diagrams. The renderer adds the
    // [severity · estimate] headline tag above and posts as-is.
    body: { type: "string" },
    // Issue-description rewrite — separate codepath that PATCHes
    // the Linear issue body. Has its own structural rules in the
    // prompt because it replaces author content in place.
    improvedDescription: { type: "string" },
  },
  required: ["headline", "severity", "estimate", "labels", "body"],
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

/**
 * GitHub @-mention reply verdict (greptile-style verification).
 * Mirrors GithubMentionVerdict in src/lib/github-mention.ts.
 *
 * Same shape as MENTION_REPLY_SCHEMA — the surface is different
 * (PR thread vs Linear comment), but the JSON contract is the same:
 * a single Markdown body + confidence + abstain. The body itself is
 * freeform Markdown — the prompt only constrains voice and the JSON
 * envelope, not the prose shape.
 */
export const GITHUB_MENTION_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
    abstain: { type: "boolean" },
  },
  required: ["answer", "confidence", "abstain"],
} as const

