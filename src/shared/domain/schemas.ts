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
 *
 * ARC-263: `files` cap raised from 5 → 20 so the model can emit a
 * row for EVERY changed file in the prompt (not just the top-5).
 * Walkthrough caching keys each row by `(file-path, patch-sha256)`,
 * so an unchanged file on a subsequent push reuses its prior row
 * instead of being silently dropped because it fell out of the
 * top-5 ranking. Display-side truncation happens upstream of the
 * renderer in `mergeCachedAndFreshRows` (triage-pr-overview.ts —
 * `merged.slice(0, 5)`); `formatOverviewComment` itself just
 * renders whatever `verdict.files` it receives. The cap here is
 * only about the model's emission surface.
 */
export const PR_OVERVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
    confidenceReason: { type: "string" },
    files: {
      type: "array",
      maxItems: 20,
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
    // SIG-99: optional polish fields, all gated server-side by the
    // parser (out-of-range / empty values drop silently). Models that
    // don't know about them leave them out → renderer skips the
    // section. Required-list intentionally NOT extended so the
    // schema-constrained decoder doesn't reject responses from
    // legacy prompt versions during a staged rollout.
    reviewEffort: { type: "integer", minimum: 1, maximum: 5 },
    suggestedLabels: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    suggestedReviewers: {
      type: "array",
      maxItems: 2,
      items: { type: "string" },
    },
    relatedPrUrls: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    mermaidDiagram: { type: "string" },
  },
  required: ["summary", "confidence", "confidenceReason", "files", "bullets"],
} as const

const FINDING_MORE_INFO_SCHEMA = {
  type: "object",
  properties: {
    threatModel: { type: "string" },
    codeCitations: { type: "string" },
    existingProtections: { type: "string" },
    mitigation: { type: "string" },
    alternatives: { type: "string" },
    severityCalibration: { type: "string" },
  },
  // `moreInfo` is optional reviewer-supporting text, never a recall gate. Keep
  // constrained decode permissive so a typo in this optional object can only
  // lose optional detail, not invalidate an otherwise valid high-severity
  // finding. The safety filter is `normalizeFindingMoreInfo`: runtime consumers
  // must go through it, and it drops unknown keys before rendering. Typoed
  // section keys such as `threat_model` are therefore intentionally silent
  // optional-detail loss, not finding loss.
  additionalProperties: true,
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
          scope: {
            type: "string",
            enum: ["line", "file", "pr", "comment"],
          },
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
          body: {
            type: "string",
            description:
              "Write the COMPLETE issue first: a self-contained explanation of the problem that a reader understands on its own — what is wrong, where, and why it matters — WITHOUT expanding anything. Keep it tight (typically 1-4 sentences). Then, ONLY if there is genuinely deeper analysis for HOW you reached this conclusion (evidence walk-through, edge cases, alternatives considered), add a SINGLE BLANK LINE and put that deeper reasoning after it. The text before the blank line must stand alone as the full issue; everything after is an optional deep-dive shown in a collapsed dropdown. Do not split a single thought across the blank line.",
          },
          // SIG-249: optional structured high-severity deep dive. Kept out
          // of `required` so older prompt paths and constrained decoding can
          // still emit valid findings while rollout data proves fill-rate.
          moreInfo: FINDING_MORE_INFO_SCHEMA,
          // Structured details: proof/fix/test-gap fields for richer
          // review comments. Optional so older prompt paths and clean
          // findings can omit them; the renderer decides where each
          // section belongs.
          failureExample: { type: "string" },
          fixExample: { type: "string" },
          testGap: { type: "string" },
          // ARC-182: optional stack-origin tag for findings on PRs
          // that are part of a Graphite-style stack. Not in `required`
          // — emitted only when [STACK CONTEXT] is present in the
          // prompt input. Backwards compatible: existing reviews and
          // no-stack PRs simply omit the field.
          stackOrigin: {
            type: "string",
            enum: ["current-pr", "downstack-context", "upstack-followup"],
          },
          // SIG-113: per-finding evidence-citation fields. The
          // specialist cites which files it inspected + which
          // evidence-block records back the finding. Both fields are
          // OPTIONAL in the schema so the staged rollout (specialists
          // not yet trained on the new prompt) doesn't fail schema-
          // constrained decode. The orchestrator's
          // `evaluateTestingFindingCitation` gate gates on
          // these fields downstream and drops findings that fail to
          // cite.
          //   inspectedTestFiles — file paths the specialist actually
          //                        read while forming the finding
          //   evidenceRefs       — references into the [TESTING EVIDENCE]
          //                        block (e.g. "siblingMapping:src/lib/foo.ts->NONE"
          //                        or a path in inspectedTestFiles)
          inspectedTestFiles: {
            type: "array",
            items: { type: "string" },
          },
          evidenceRefs: {
            type: "array",
            items: { type: "string" },
          },
          // SIG-108: per-finding security-evidence fields, gated by
          // `validateSecurityFinding` downstream. OPTIONAL (same staged-
          // rollout reasoning as the SIG-113 fields above) so specialists
          // not yet on the new prompt still decode.
          //   cweId      — a CWE identifier (e.g. "CWE-89") backing a
          //                security finding; required at score>=4 for
          //                scanner-covered buckets (see the validator).
          //   evidenceId — verbatim copy of a deterministic security
          //                fact's id ("tool:rule-id:hash:line"), or the
          //                literal "NONE" for access-control findings
          //                that no scanner can detect (with body
          //                justification).
          cweId: { type: "string" },
          evidenceId: { type: "string" },
          // SIG-282: optional one-line rationale the security specialist
          // records when it adjudicates a scanner-backed finding (analyst
          // verification note). OPTIONAL; audit/telemetry only, no gate.
          independentAssessment: { type: "string" },
          // SIG-110: per-finding performance-evidence fields, gated by
          // `evaluatePerfFinding` downstream. OPTIONAL (same staged-
          // rollout reasoning as the fields above) so specialists not yet
          // on the new prompt still decode. Listed here so schema-
          // constrained generation can EMIT them — the parser reads them
          // (triage-pr-review.ts) but the constrained decode surface
          // needs the keys or the model may omit/reject them.
          //   complexityEstimate — complexity claim naming the changed
          //                        loop/call + input-growth source.
          //   hotPathIdentifier  — a concrete changed route/handler/export
          //                        token the perf finding sits on.
          complexityEstimate: { type: "string" },
          hotPathIdentifier: { type: "string" },
          // SIG-125: optional contiguous-replacement code for the
          // finding's anchored range. Listed so constrained decode can
          // emit it; the parser + renderer validate/anchor it.
          suggestedReplacement: { type: "string" },
          kind: {
            type: "string",
            enum: ["delete", "replace", "insert", "describe"],
          },
        },
        required: ["path", "line", "scope", "score", "category", "headline", "body"],
      },
    },
    // SIG-282: the security specialist records each scanner candidate it
    // REFUTES here (instead of silently not emitting a finding) so the
    // dismissal is auditable: { evidenceId (verbatim manifest id), reason }.
    // OPTIONAL + security-only; other specialists leave it empty.
    dismissedScanFacts: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          evidenceId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["evidenceId", "reason"],
      },
    },
    // SIG-308: the logic specialist records each correctness concern it
    // REFUTES against a concrete in-code mitigation here (instead of emitting
    // a finding) so the clear is auditable: { path, line, hypothesis,
    // mitigation }. OPTIONAL + logic-only; other specialists leave it empty.
    clearedLogicCandidates: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          hypothesis: { type: "string" },
          mitigation: { type: "string" },
        },
        required: ["path", "line", "hypothesis", "mitigation"],
      },
    },
  },
  required: ["summary", "confidence", "confidenceReason", "findings"],
} as const

/**
 * pr-improve verdict (ARC-179: `/sigilix improve` suggested changes).
 * Mirrors PrImproveVerdict in src/lib/triage-pr-improve.ts. Tighter
 * scope than the regular review — no score, narrower category list,
 * cap at 5.
 */
export const PR_IMPROVE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    suggestions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          startLine: { type: "integer", minimum: 1 },
          category: {
            type: "string",
            enum: ["naming", "clarity", "dead-code", "error-handling", "style", "docs"],
          },
          headline: { type: "string", maxLength: 120 },
          body: {
            type: "string",
            description:
              "Write the complete issue as a self-contained explanation the reader understands on its own (usually 1-2 sentences for a nit). If there is genuinely deeper reasoning, add a SINGLE BLANK LINE and put it after — the part before the blank line must stand alone; the part after is an optional deep-dive shown in a dropdown. Never split a single thought across the blank line.",
          },
        },
        required: ["path", "line", "category", "headline", "body"],
      },
    },
  },
  required: ["summary", "suggestions"],
} as const

/**
 * CI-triage verdict. Mirrors CiTriageDiagnosis in src/lib/triage-ci.ts.
 *
 * `patches` is intentionally optional: SIG-332 only makes patch data
 * available to the handler; SIG-333 validates anchors and decides how to post
 * applyable suggestions. The sticky comment renderer ignores patches for now.
 */
export const CI_TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    rootCause: { type: "string", minLength: 1 },
    suggestedFix: { type: "string" },
    affectedFiles: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1 },
    },
    failureExcerpt: { type: "string", minLength: 1 },
    // TODO(SIG-333): Validate patch anchors against the PR diff before
    // rendering these as applyable suggestion blocks.
    patches: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 512 },
          line: { type: "integer", minimum: 1 },
          replacement: { type: "string", minLength: 1, maxLength: 5000 },
        },
        required: ["path", "line", "replacement"],
      },
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
  },
  required: ["rootCause", "affectedFiles", "failureExcerpt", "confidence"],
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
    // art, optional Mermaid diagrams. The renderer adds the priority
    // badge + headline above and posts as-is; estimate is applied as
    // Linear story points rather than duplicated in the comment body.
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
    // SIG-160 PR3: structured verdict so the mention-reply handler can
    // persist a WithdrawalRecord when conceding pushback. "answer" is
    // the default ("I'm just answering"); "concede" signals the human
    // was right and we're withdrawing the original finding — only
    // meaningful on review-comment surfaces with an inline anchor.
    verdict: { type: "string", enum: ["answer", "concede"] },
  },
  required: ["answer", "confidence", "abstain"],
} as const

/**
 * pr-labels verdict (ARC-265: auto-applied PR labels).
 *
 * The model picks 0–5 label NAMES from the candidate pool supplied
 * in the prompt. Anything outside that pool is dropped post-decode
 * (the LLM occasionally invents — the parser is the source of truth).
 */
export const PR_LABEL_SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
  },
  required: ["labels"],
} as const

/**
 * pr-describe verdict (ARC-191: `/sigilix describe`).
 * Mirrors PrDescribeVerdict in src/lib/triage-pr-describe.ts.
 *
 * Single-shot text generation. `summary` is a one-sentence
 * orientation line shown above the marker block; `body` is the
 * actual draft (PR description / internal changelog / external
 * changelog) wrapped in marker comments downstream.
 *
 * Length constraints are belt-and-suspenders: the runtime hint
 * (`minLength`/`maxLength`) helps the model self-cap, and the
 * post-decode validator in triage-pr-describe.ts enforces them
 * for real (Ollama JSON-mode honors `required` + `type` reliably
 * but length constraints are advisory in current builds).
 */
export const PR_DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 10, maxLength: 500 },
    body: { type: "string", minLength: 50, maxLength: 32000 },
  },
  required: ["summary", "body"],
} as const

/**
 * pr-summary verdict (SIG-437: `@sigilix summary`).
 * Mirrors PrSummaryVerdict in src/lib/triage-pr-summary.ts.
 *
 * Same shape + length discipline as PR_DESCRIBE_SCHEMA — a one-shot
 * generation where `summary` is a one-line orientation (kept for
 * parity + a possible future comment fallback) and `body` is the
 * detailed PR description (What / How it works / How verified /
 * Notable risks) written into the PR body's managed block. The
 * deterministic "Related" block (PRs + Linear) is appended by the
 * handler, NOT emitted by the model.
 */
export const PR_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 10, maxLength: 500 },
    body: { type: "string", minLength: 50, maxLength: 32000 },
  },
  required: ["summary", "body"],
} as const
