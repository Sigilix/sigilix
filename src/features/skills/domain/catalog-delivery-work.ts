// Governed skills for the software-delivery workflows Sigilix actually runs:
// Linear issue/project work (the triage pipeline + Slack agent create and
// enrich Linear issues), GitHub PR-comment resolution, and the engineering
// practice set (debugging, testing strategy, code review, documentation).
// Same rules as `catalog.ts`: every source is pinned and hashed, and the
// injected text is Sigilix-authored, bounded guidance.

import type { GovernedSkillManifest, SkillReviewProvenance, SkillSurface } from "./catalog"

const CHAT_RESEARCH_SURFACES = ["chat", "deep-research"] as const satisfies readonly SkillSurface[]
// "agent" — the Slack agent + the Linear issue-triage pipeline. See catalog.ts.
const CHAT_RESEARCH_AGENT_SURFACES = ["chat", "deep-research", "agent"] as const satisfies readonly SkillSurface[]

const REVIEW_2026_07_12: SkillReviewProvenance = {
  status: "approved-guidance-only",
  reviewedBy: "sigilix-engineering",
  reviewedAt: "2026-07-12",
}

export const DELIVERY_WORK_SKILLS = [
  {
    schemaVersion: 1,
    id: "openai-linear-workflows",
    name: "Linear issue and project workflows",
    description: "Reviewed workflow for reading, creating, and updating Linear issues, projects, and cycles safely.",
    category: "operations",
    explanation: {
      purpose:
        "Structures Linear work around read-first context building, confirmed identifiers, and reviewable batched changes across issues, projects, and cycles.",
      useCases: [
        "Triaging or enriching a Linear issue",
        "Planning a sprint, cycle, or release in Linear",
        "Balancing team workload across active issues",
      ],
      guardrails:
        "Reads before writing, confirms identifiers from real reads, and presents bulk changes as explained proposals instead of silent mutations.",
    },
    instructionVersion: 1,
    instructionSha256: "912f9d05d9949fcae14dc8db9df673f319d30e6f6f9849fc3a62de3ed39eb132",
    instructions: `Apply this Linear workflow when the task concerns reading, creating, or updating Linear issues, projects, cycles, or team workloads:
- Clarify the goal and scope first — triage, sprint planning, documentation audit, or workload balance — and confirm the team, project, priority, labels, cycle, and due dates the task actually needs.
- Read before writing: list, get, or search the relevant issues and projects to build context, and confirm required identifiers such as the issue ID, project ID, or team key before any change.
- Present create and update actions as reviewable proposals, and for bulk operations explain the grouping logic before applying changes through an authorized write path.
- Batch related changes and break large updates into smaller batches; reference prior issues instead of duplicating their content.
- Summarize results with remaining gaps or blockers and propose concrete next actions such as follow-up issues, label changes, or assignments.
- On authorization or rate-limit failures, surface the failure and let the user reconnect; never retry blindly or fabricate an identifier a read did not return.
Ground every claim in issues and projects actually read during the task, and cite their identifiers.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/linear/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "ce0f39c95b6c9190f8ea33614393cdb556b2684dd8388ded394e9cb915f42601",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/linear/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW_2026_07_12,
    appIds: ["linear"],
    eligibleSurfaces: CHAT_RESEARCH_AGENT_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "linear issue",
      "linear ticket",
      "linear project",
      "linear cycle",
      "sprint planning",
      "linear backlog",
    ],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "openai-pr-comment-resolution",
    name: "GitHub PR comment resolution",
    description: "Reviewed workflow for enumerating, selecting, and addressing review comments on a pull request.",
    category: "engineering",
    explanation: {
      purpose:
        "Turns a pile of pull-request review comments into a numbered, summarized selection so fixes are applied deliberately and each resolution is traceable.",
      useCases: [
        "Working through review feedback on an open PR",
        "Deciding which review threads actually need a change",
        "Mapping applied fixes back to the comments they resolve",
      ],
      guardrails:
        "Waits for an explicit selection before changing anything, keeps each fix scoped to its comment, and never claims a comment was addressed without a concrete change.",
    },
    instructionVersion: 1,
    instructionSha256: "56d887578999313918396bea1260d97b255efbd4a50a72968b2a7eda5b0366ee",
    instructions: `Apply this workflow when the task is to address review or issue comments on a GitHub pull request:
- Gather every unresolved review thread and comment on the exact pull request first, and say clearly when comments could not be read.
- Number the threads and give each a one-line summary of what a fix would require, so the selection is explicit rather than implied.
- Ask which numbered comments to address and wait for that selection before changing anything; never treat silence as approval for a fix.
- Apply fixes only for the selected comments, keeping each change scoped to what its comment asked for.
- After applying, map each addressed comment to the change that resolves it, and reply or mark threads resolved only through an authorized write path.
- Surface authentication or rate-limit failures explicitly and let the user re-authenticate instead of retrying blindly.
Do not claim a comment was addressed unless a concrete change or reply resolves it.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/gh-address-comments/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "77389eefd3fb6584210668ca8e43f4b8de87e7722ddd953474bc9e24cdfaaedd",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-address-comments/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW_2026_07_12,
    appIds: ["github"],
    eligibleSurfaces: CHAT_RESEARCH_AGENT_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["review comments", "address the comments", "pr feedback", "review threads", "resolve the review"],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "anthropic-debugging-workflow",
    name: "Systematic debugging",
    description: "Reviewed reproduce–isolate–diagnose–fix workflow for errors, regressions, and diverging behavior.",
    category: "engineering",
    explanation: {
      purpose:
        "Keeps a debugging session systematic — reproduction and scope first, isolation against recent changes, tested hypotheses, and a fix paired with prevention.",
      useCases: [
        "Investigating an error message or stack trace",
        "Explaining a regression that appeared after a deploy",
        "Turning a vague bug report into a checkable diagnosis",
      ],
      guardrails:
        "Distinguishes root cause from symptom, labels untested hypotheses as hypotheses, and never presents a guess as a confirmed diagnosis.",
    },
    instructionVersion: 1,
    instructionSha256: "4323ea0309aba7111ee8d1958e186bf7d005c4c3f8b6ea7ef948231963680b59",
    instructions: `Apply this debugging workflow when the task reports an error, stack trace, regression, or behavior that diverges from expectations:
- Establish expected versus actual behavior and the reproduction steps first, and scope when the problem started and who is affected.
- Isolate the component, service, or code path before proposing anything; treat recent deploys, configuration changes, and dependency updates as the top suspects.
- Use exact error text, logs, and the visible code path as evidence; ask for the precise message instead of reasoning from a paraphrase.
- Form explicit hypotheses and test them, and distinguish the root cause from the symptom it produces.
- Propose the fix with its reasoning, note side effects and edge cases it could introduce, and pair it with a regression test or guard.
- Structure the result as reproduction, root cause, fix, and prevention so each claim is separately checkable.
Never present an untested hypothesis as a diagnosis; label it as a hypothesis with the evidence still needed.`,
    source: {
      repositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      path: "engineering/skills/debug/SKILL.md",
      commit: "d4c8cec441011095e48eff077314cf966a69c642",
      upstreamVersion: "commit-d4c8cec441011095e48eff077314cf966a69c642",
      skillFileSha256: "e50bb92cbcb2715139f3a3cb9ff282a8f0f9ae794f8f35d81338654e2601d32a",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/anthropics/knowledge-work-plugins/blob/d4c8cec441011095e48eff077314cf966a69c642/LICENSE",
      publisher: "Anthropic",
    },
    review: REVIEW_2026_07_12,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_AGENT_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "stack trace",
      "root cause",
      "debug this",
      "why is it failing",
      "regression after",
      "reproduce the bug",
    ],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "anthropic-testing-strategy",
    name: "Testing strategy",
    description: "Reviewed guidance for designing test plans that balance coverage, speed, and maintenance.",
    category: "engineering",
    explanation: {
      purpose:
        "Shapes test plans around the testing pyramid and the component under test, concentrating coverage where failures are expensive instead of where tests are easy.",
      useCases: [
        "Designing a test plan for a new feature",
        "Choosing test types for an API, pipeline, or UI",
        "Finding the gaps in an existing test suite",
      ],
      guardrails:
        "Recommends only tests the repository's framework and conventions can express, and never treats untested paths as safe by assumption.",
    },
    instructionVersion: 1,
    instructionSha256: "6ad98f4ac2aa1003011afb53ff5847211ddb76dc8539718964e6310642abf588",
    instructions: `Apply this testing-strategy guidance when the task asks how to test a change, design a test plan, or assess coverage:
- Shape the plan as a pyramid: many fast, focused unit tests, some integration tests, and few high-confidence end-to-end tests.
- Match test type to component: business logic wants unit tests, HTTP layers want integration and contract tests, and pipelines want validation, transformation-correctness, and idempotency tests.
- Concentrate coverage on business-critical paths, error handling, edge cases, security boundaries, and data integrity; skip trivial accessors, framework internals, and one-off scripts.
- Weigh coverage against speed and maintenance cost — a slow or flaky suite loses the protection it was meant to buy.
- Produce a concrete plan naming what to test, the test type for each area, target coverage, and example cases.
- Identify gaps in the existing suite explicitly instead of assuming untested paths are safe.
Recommend tests the repository's existing framework and conventions can actually express.`,
    source: {
      repositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      path: "engineering/skills/testing-strategy/SKILL.md",
      commit: "d4c8cec441011095e48eff077314cf966a69c642",
      upstreamVersion: "commit-d4c8cec441011095e48eff077314cf966a69c642",
      skillFileSha256: "5c5e95830754bbdd838213fa05fc8f07523f591fd558fd3c86031ffd479f7a9e",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/anthropics/knowledge-work-plugins/blob/d4c8cec441011095e48eff077314cf966a69c642/LICENSE",
      publisher: "Anthropic",
    },
    review: REVIEW_2026_07_12,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_AGENT_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["test strategy", "test plan", "how should we test", "what tests do we need", "test coverage"],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "anthropic-code-review-practices",
    name: "Code review practices",
    description:
      "Reviewed guidance for reviewing a diff across security, performance, correctness, and maintainability.",
    category: "engineering",
    explanation: {
      purpose:
        "Structures an ad-hoc review of a shared diff or change across the four lenses that matter — security, performance, correctness, and maintainability — with located, actionable findings.",
      useCases: [
        "Reviewing a pasted diff or proposed change in chat",
        "Sanity-checking a change before it becomes a PR",
        "Focusing a review on a stated concern like a hot path",
      ],
      guardrails:
        "Grounds every finding in the code actually shown, separates critical issues from optional improvements, and never asserts a defect the diff does not support.",
    },
    instructionVersion: 1,
    instructionSha256: "4f7655458a05f6b2e3ba21c3e637f4bb48293430b50ae02408da0a5b044e4e5b",
    instructions: `Apply this review guidance when the task asks to review a diff, a proposed change, or code quality before a merge:
- Review across four lenses — security, performance, correctness, and maintainability — rather than style alone.
- For security, check injection, cross-site scripting, authentication and authorization flaws, secrets in code, and unsafe deserialization against the visible change.
- For performance, look for N+1 queries, unnecessary allocations, unbounded queries or loops, missing indexes, and hot-path complexity.
- For correctness, probe edge cases such as empty input and null, race conditions, error handling and propagation, and off-by-one boundaries.
- Report findings with the file and location, a severity, and an actionable suggestion; separate critical issues from optional improvements, and note what looks good.
- Use stated context such as a hot path or personal-data handling to focus the review, and check test coverage for the changed behavior.
Ground every finding in the code actually shown; never assert a defect the diff does not support.`,
    source: {
      repositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      path: "engineering/skills/code-review/SKILL.md",
      commit: "d4c8cec441011095e48eff077314cf966a69c642",
      upstreamVersion: "commit-d4c8cec441011095e48eff077314cf966a69c642",
      skillFileSha256: "6303932f1b301c614a6f5a0099cd87a19e1cd1b7cbfa1a1e11e996edbca6426b",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/anthropics/knowledge-work-plugins/blob/d4c8cec441011095e48eff077314cf966a69c642/LICENSE",
      publisher: "Anthropic",
    },
    review: REVIEW_2026_07_12,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["review this diff", "review this change", "review my code", "is this code safe", "before i merge"],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "anthropic-technical-documentation",
    name: "Technical documentation writing",
    description: "Reviewed guidance for writing READMEs, API references, runbooks, architecture docs, and guides.",
    category: "knowledge",
    explanation: {
      purpose:
        "Matches a document to its reader and type — README, API reference, runbook, architecture doc, or onboarding guide — and leads with the most useful information.",
      useCases: [
        "Writing or improving a README or runbook",
        "Documenting an API with examples and error codes",
        "Recording architecture decisions and trade-offs",
      ],
      guardrails:
        "Describes only behavior the code or supplied context shows, links to sources of truth instead of duplicating them, and flags stale content instead of preserving it.",
    },
    instructionVersion: 1,
    instructionSha256: "771d85a68eb6ee7bbf49c00ce0a28c2413b1d35bbcad85c5e86ca91b0bd59e37",
    instructions: `Apply this documentation guidance when the task is to write or improve a README, API reference, runbook, architecture doc, or onboarding guide:
- Identify the reader and the document type first — each type carries its own required sections, such as rollback steps and an escalation path for a runbook.
- Lead with the most useful information: what the thing is, why it exists, and the fastest path to a first success.
- Show rather than tell — concrete commands, request and response examples, and walkthroughs beat abstract description.
- Keep documents current and honest; flag content the code no longer supports instead of leaving it to mislead.
- Link to an existing source of truth instead of duplicating it, and structure API references around endpoints, authentication, errors, and limits.
- For architecture documents, record context, goals, key decisions, and trade-offs so future readers understand why, not only what.
Describe only behavior the code, configuration, or supplied context actually shows.`,
    source: {
      repositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      path: "engineering/skills/documentation/SKILL.md",
      commit: "d4c8cec441011095e48eff077314cf966a69c642",
      upstreamVersion: "commit-d4c8cec441011095e48eff077314cf966a69c642",
      skillFileSha256: "1d469418f786a05be83d2a05f04d68788aeed584d13863a650f5ad73c6c4cf50",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/anthropics/knowledge-work-plugins/blob/d4c8cec441011095e48eff077314cf966a69c642/LICENSE",
      publisher: "Anthropic",
    },
    review: REVIEW_2026_07_12,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_AGENT_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["write docs", "write the readme", "document this", "runbook", "onboarding guide", "api docs"],
    priority: 10,
  },
] as const satisfies readonly GovernedSkillManifest[]
