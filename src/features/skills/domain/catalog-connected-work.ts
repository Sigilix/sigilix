// Governed skills for the connected-work apps (Slack, Jira, PagerDuty, Asana)
// and the model-workflow guidance set (goal definition, CI diagnosis, digests,
// stakeholder updates). Same rules as `catalog.ts`: every source is pinned and
// hashed, and the injected text is Sigilix-authored, bounded guidance.

import type { GovernedSkillManifest, SkillReviewProvenance, SkillSurface } from "./catalog"

const CHAT_RESEARCH_SURFACES = ["chat", "deep-research"] as const satisfies readonly SkillSurface[]
// "agent" — the Slack agent + the Linear issue-triage pipeline. See catalog.ts.
const CHAT_RESEARCH_AGENT_SURFACES = ["chat", "deep-research", "agent"] as const satisfies readonly SkillSurface[]

const REVIEW_2026_07_12: SkillReviewProvenance = {
  status: "approved-guidance-only",
  reviewedBy: "sigilix-engineering",
  reviewedAt: "2026-07-12",
}

export const CONNECTED_WORK_SKILLS = [
  {
    schemaVersion: 1,
    id: "slack-search-grounding",
    name: "Slack search and thread grounding",
    description: "Reviewed Slack-authored guidance for finding and citing workspace messages, threads, and files.",
    category: "knowledge",
    explanation: {
      purpose:
        "Turns a question about workspace activity into focused Slack searches whose results are read in thread context and cited, instead of paraphrased from memory.",
      useCases: [
        "Finding the thread where a decision was made",
        "Locating messages, files, or people behind a report",
        "Grounding a review or answer in cited workspace evidence",
      ],
      guardrails:
        "Keeps the connection read-only, prefers the narrowest search surface, and never posts, reacts, or edits workspace content.",
    },
    instructionVersion: 1,
    instructionSha256: "62824c67dd5e7c6d4b8df858196c595f9f7e796c14d1ffdba3eb11c172600152",
    instructions: `Apply this Slack search workflow when the task needs messages, files, channels, or people from a connected workspace:
- Choose the narrowest search surface first: public-channel search by default, and the broader private or direct-message search only when the question requires it and the account's consent covers it.
- Start broad with keywords or a natural-language question, then narrow with location, sender, content, and date modifiers instead of guessing channel names.
- Break a complex question into several focused searches — the topic first, then specific people, then specific channels — rather than relying on one query.
- Combine terms with spaces, exclude with a leading minus, and quote exact phrases; boolean operators and parentheses are not supported by Slack search.
- Treat search as non-real-time: read the channel directly for the newest messages, and open the full thread before citing a threaded message.
- Resolve user IDs to profiles before naming people, and cite the channel and thread every material claim came from.
Keep the workflow read-only. Never post, reply, react, or edit workspace content from a search task.`,
    source: {
      repositoryUrl: "https://github.com/slackapi/slack-mcp-plugin",
      path: "skills/slack-search/SKILL.md",
      commit: "9ea300a7493079d880aaa7d2650cfcd694243154",
      upstreamVersion: "commit-9ea300a7493079d880aaa7d2650cfcd694243154",
      skillFileSha256: "d2ea69e3287cd8c060238ab8a45ede9ef0e7046de6e4ae452ef15bfd4e201ebc",
      license: "MIT",
      licenseUrl: "https://github.com/slackapi/slack-mcp-plugin/blob/9ea300a7493079d880aaa7d2650cfcd694243154/LICENSE",
      publisher: "Slack",
    },
    review: REVIEW_2026_07_12,
    appIds: ["slack"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "slack thread",
      "slack search",
      "search slack",
      "slack message",
      "slack channel history",
      "find the thread",
    ],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "atlassian-jira-triage",
    name: "Jira issue triage",
    description: "Reviewed Atlassian workflow for deduplicating, scoring, and filing Jira issues from a bug report.",
    category: "operations",
    explanation: {
      purpose:
        "Structures bug triage around targeted JQL evidence and banded duplicate confidence so a report lands on the right existing issue or a well-formed new one.",
      useCases: [
        "Deduplicating a new bug report against existing issues",
        "Detecting a regression hiding behind a resolved ticket",
        "Filing a structured issue with environment and impact",
      ],
      guardrails:
        "Presents candidate matches and waits for an explicit decision; never comments on or creates an issue without the user's go-ahead.",
    },
    instructionVersion: 1,
    instructionSha256: "39156d0d8aea2e7dc1ebd3473f87dfd5a80bf0ba061506630ea6e4372160b57b",
    instructions: `Apply this Jira triage workflow when the task is a bug report or a request to file, deduplicate, or route an issue:
- Extract the error signature, affected component, and user-visible symptom from the report before searching anything.
- Run several targeted JQL searches — by error text, by component, and by symptom — and include resolved issues so a regression is not misread as a new defect.
- Score duplicate confidence in bands instead of asserting a match: near-certain duplicate, likely duplicate, related issue, or genuinely new report.
- Present the candidate matches with their evidence and wait for an explicit decision before touching any issue.
- When a new issue is warranted, use a structured summary of component, error, and symptom, and include environment, reproduction steps, impact, and related issues in the description.
- Respect the project's required fields, and call out a suspected regression explicitly with the release evidence that suggests it.
Never comment on, transition, or create an issue without the user's explicit confirmation in that session.`,
    source: {
      repositoryUrl: "https://github.com/atlassian/atlassian-mcp-server",
      path: "skills/triage-issue/SKILL.md",
      commit: "f22e7075136a62baa7c10200a64884f83bf3ebe1",
      upstreamVersion: "commit-f22e7075136a62baa7c10200a64884f83bf3ebe1",
      skillFileSha256: "4ce1808138ea8871e5a113e4f7b7ae28dc8e78a36df4cb7c87f9666c20620e0c",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/atlassian/atlassian-mcp-server/blob/f22e7075136a62baa7c10200a64884f83bf3ebe1/LICENSE",
      publisher: "Atlassian",
    },
    review: REVIEW_2026_07_12,
    appIds: ["jira"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["jira triage", "triage this bug", "duplicate jira issue", "file a jira issue", "jql search"],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "pagerduty-incident-investigation",
    name: "PagerDuty incident investigation",
    description: "Reviewed PagerDuty workflow for resolving, investigating, and summarizing an incident from evidence.",
    category: "operations",
    explanation: {
      purpose:
        "Anchors an incident investigation to one resolved PagerDuty incident and keeps the what-happened, root-cause, and recommended-action questions tied to provider evidence.",
      useCases: [
        "Investigating an active page or incident reference",
        "Correlating an incident window with recent deploys",
        "Producing an evidence-backed incident summary",
      ],
      guardrails:
        "Stops visibly when the connection is unavailable, stays read-only, and never acknowledges, resolves, or reassigns an incident on its own.",
    },
    instructionVersion: 1,
    instructionSha256: "acdeb90663ada3850c9e7f31e2ae6984509c663781e0a8322ad9239eb3e38702",
    instructions: `Apply this incident investigation workflow when the task references a PagerDuty incident, page, or on-call question:
- Verify the PagerDuty connection with a minimal read before starting, and stop with a clear message if it is unavailable instead of degrading silently.
- Resolve the exact incident first: use a direct identifier as given, look up numeric references, and when no identifier exists, list the active triggered and acknowledged incidents and let the user choose.
- Structure the investigation around three questions — what happened, what is the likely root cause, and what actions are recommended — and keep follow-ups in the same investigation context.
- Separate provider evidence such as alerts, timeline entries, services, and responders from inference, and label unconfirmed hypotheses as hypotheses.
- Correlate the incident window with recent deploys and repository changes before proposing a fix path.
- Keep the workflow read-only. Do not acknowledge, resolve, reassign, or annotate an incident without a separate explicit request.
Summarize with the incident reference, the evidence used, the open unknowns, and the next verification step.`,
    source: {
      repositoryUrl: "https://github.com/PagerDuty/github-agenthq-plugins",
      path: "skills/investigate/SKILL.md",
      commit: "162e40f8afba1ba2a59ddc017795e54c81e27076",
      upstreamVersion: "commit-162e40f8afba1ba2a59ddc017795e54c81e27076",
      skillFileSha256: "33ffab6beef0ffdfb9dfd5c67e98e3ee12d5437d2aa3825d1fc541187b4f8844",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/PagerDuty/github-agenthq-plugins/blob/162e40f8afba1ba2a59ddc017795e54c81e27076/LICENSE",
      publisher: "PagerDuty",
    },
    review: REVIEW_2026_07_12,
    appIds: ["pagerduty"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "pagerduty incident",
      "investigate the incident",
      "on-call incident",
      "incident root cause",
      "who got paged",
    ],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "asana-task-context",
    name: "Asana task and project context",
    description:
      "Reviewed Asana guidance for reading tasks, projects, and portfolios without guessing scope or identifiers.",
    category: "knowledge",
    explanation: {
      purpose:
        "Keeps Asana reads scoped to a confirmed workspace and project, with identifiers taken only from real reads, so task context enters an answer without invented structure.",
      useCases: [
        "Pulling task and project context into an answer",
        "Summarizing a project's open work and owners",
        "Preparing a reviewed change to tracked work",
      ],
      guardrails:
        "Resolves ambiguous references by asking, never fabricates identifiers, and requires explicit confirmation before any write path is requested.",
    },
    instructionVersion: 1,
    instructionSha256: "fe178ff19db2ee1feed0e3b35f439a71f60a7c3b6192d7794ff7b90c483e4217",
    instructions: `Apply this Asana workflow when the task involves reading or planning work tracked in Asana:
- Verify the connection with a minimal read first and surface a clear failure instead of proceeding on assumptions.
- Confirm the exact workspace and project before acting: resolve ambiguous references like “my project” by asking, never by guessing.
- Prefer narrow project- and section-scoped reads over broad workspace searches, and page through results instead of truncating them silently.
- Treat identifiers as authoritative — never fabricate or guess an identifier that was not returned by a read.
- Summarize any proposed create or modify action and wait for explicit confirmation before requesting it through an authorized write path; list the affected items before any bulk change.
- On a rate limit, wait briefly and retry once; on an authorization error, direct the user to reconnect rather than retrying blindly.
Keep reads scoped to what the connected account can see, and cite the tasks and projects the answer used.`,
    source: {
      repositoryUrl: "https://github.com/Asana/cursor-marketplace-plugin",
      path: "skills/asana-usage/SKILL.md",
      commit: "caf02337846594b6af5221ea5165c1dd0d273d9b",
      upstreamVersion: "commit-caf02337846594b6af5221ea5165c1dd0d273d9b",
      skillFileSha256: "6b3fddd179be3087cf8951ed1f27fe6bc3567ece6c6bc77303ece8a69c04c6fa",
      license: "MIT",
      licenseUrl:
        "https://github.com/Asana/cursor-marketplace-plugin/blob/caf02337846594b6af5221ea5165c1dd0d273d9b/LICENSE",
      publisher: "Asana",
    },
    review: REVIEW_2026_07_12,
    appIds: ["asana"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["asana task", "asana project", "asana portfolio", "work in asana", "asana status"],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "openai-define-goal",
    name: "Goal definition",
    description:
      "Reviewed workflow for turning a fuzzy request into one measurable, verifiable objective before work starts.",
    category: "engineering",
    explanation: {
      purpose:
        "Converts broad or open-ended requests into a concrete objective with a named outcome, a verification method, explicit scope, and a stop-and-ask condition.",
      useCases: [
        "Scoping a vague task before the agent starts work",
        "Defining pass/fail criteria for a bug fix",
        "Setting measurable thresholds for performance work",
      ],
      guardrails:
        "Only reframes the user's request — it cannot start work, and a restated goal that changes meaning must be confirmed before execution.",
    },
    instructionVersion: 1,
    instructionSha256: "8964c1800e132242b4aafe4c4aa0108553781d2d741ae54a3d38b0fd163a0fa1",
    instructions: `Apply this goal-definition workflow when a request is broad, fuzzy, or open-ended and work is about to start:
- Restate the request as one concrete objective that names the outcome, the artifact or system involved, and how completion will be verified.
- Make the goal measurable: an exact validation check, a quality threshold, a bounded artifact, or a required evidence count.
- State what is in scope and out of scope, and add a stop-and-ask condition for the point where continuing needs the user's input.
- Reject pure activity goals such as “make progress” or “keep investigating”; convert them into outcomes that can pass or fail.
- For a bug, define success as reproduce-then-fix with a failing check that passes afterward; for performance, name the metric, the threshold, and the measurement runs.
- Confirm the refined goal with the user before executing whenever the restatement changed the request's meaning.
Keep the goal short enough to check every subsequent step against it.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/define-goal/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "708df89ff19cbae82a762efae036735d1914b5c7e44df1832e0b723f6cd9ee30",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/define-goal/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW_2026_07_12,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_AGENT_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "define the goal",
      "what does done mean",
      "acceptance criteria",
      "scope this task",
      "measurable objective",
    ],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "openai-ci-failure-diagnosis",
    name: "CI failure diagnosis",
    description: "Reviewed workflow for explaining a failing pull-request check from its real run logs.",
    category: "engineering",
    explanation: {
      purpose:
        "Grounds a failing-check explanation in the actual run logs — the failing step, the first causal error, and the code it exercises — instead of the check's name.",
      useCases: [
        "Explaining why a pull-request check is red",
        "Separating the causal failure from downstream noise",
        "Verifying a fix by re-running the failing check",
      ],
      guardrails:
        "Reports missing logs instead of guessing, treats logless third-party checks as out of scope, and applies a fix only after explicit approval.",
    },
    instructionVersion: 1,
    instructionSha256: "42927980073de346e4e7180e60ec422414b159c89dcd1248d451d4cd757b24b4",
    instructions: `Apply this CI diagnosis workflow when a pull-request check is failing and the user wants to know why or how to fix it:
- Identify the exact pull request and its failing checks first, and read the real run logs rather than reasoning from the check name alone.
- Summarize each failure with the check name, the failing step, and a minimal log excerpt that shows the actual error, and say clearly when a log is unavailable.
- Treat third-party status checks that expose no logs as out of scope: report their details link instead of guessing at their internals.
- Separate the first causal failure from downstream noise before proposing a fix, and connect the failing assertion to the code it exercises.
- Propose a fix plan and apply it only after explicit approval, then re-run the checks to confirm the failure actually cleared.
- Never mark a diagnosis complete on “should pass now” — completion is a green re-run of the previously failing check.
Keep the summary short, evidence-first, and free of speculation the logs do not support.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/gh-fix-ci/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "7b326b4a2f0f5f85122144628ec02077e48841e0e0e82efce88b3415bcfb7c26",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-fix-ci/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW_2026_07_12,
    appIds: ["github"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "failing check",
      "ci failure",
      "why is ci red",
      "build is failing",
      "fix the pipeline",
      "failing pr check",
    ],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "anthropic-activity-digest",
    name: "Cross-source activity digest",
    description:
      "Reviewed workflow for summarizing a period of activity across connected sources into one actionable digest.",
    category: "knowledge",
    explanation: {
      purpose:
        "Builds a catch-up digest from the sources an organization has actually connected, leading with action items and grouping by topic instead of by tool.",
      useCases: [
        "Catching up after time away",
        "Producing a daily or weekly team digest",
        "Collecting decisions and mentions across sources",
      ],
      guardrails:
        "Covers only sources that were actually readable, names the ones that were not, and never invents coverage for a missing system.",
    },
    instructionVersion: 1,
    instructionSha256: "ca19f728ba214f2f5fae7588eba94a44ba65d40a46d39eaac71e8181a650d9c0",
    instructions: `Apply this digest workflow when the task asks to catch up on a period of activity across connected sources:
- Fix the time window first — default to the last day, and widen it only when the user asks for a longer period.
- Gather mentions, assigned work, document changes, and thread activity from each connected source that is actually available, and note any source that could not be read.
- Lead with action items, then decisions, then mentions, then general updates — the reader's obligations come first.
- Group items by topic or project rather than by source, and merge duplicates that appear in more than one system.
- Keep each item to one line with enough context to act on, naming the underlying thread, document, or task it came from.
- Degrade gracefully: a missing source shrinks the digest; it never silently invents coverage.
Close with compact counts of action items and decisions so the reader can gauge the load at a glance.`,
    source: {
      repositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      path: "enterprise-search/skills/digest/SKILL.md",
      commit: "d4c8cec441011095e48eff077314cf966a69c642",
      upstreamVersion: "commit-d4c8cec441011095e48eff077314cf966a69c642",
      skillFileSha256: "d711d49b898eb303b74488dce75308e8737786d87210f1dca13ec325bc7f5737",
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
    triggerPhrases: ["catch me up", "daily digest", "weekly digest", "what did i miss", "summarize activity"],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "anthropic-stakeholder-update",
    name: "Stakeholder update drafting",
    description: "Reviewed workflow for drafting audience-appropriate status updates from real project context.",
    category: "knowledge",
    explanation: {
      purpose:
        "Drafts status updates whose length, framing, and detail match the audience, pulling accomplishments, blockers, and decisions from available context instead of inventing them.",
      useCases: [
        "Drafting a weekly engineering or executive update",
        "Turning project context into a launch status",
        "Writing an honest at-risk escalation",
      ],
      guardrails:
        "Asks for what the sources do not show, reports status honestly at the first credible sign of risk, and never softens or omits a known risk.",
    },
    instructionVersion: 1,
    instructionSha256: "228a1a8412e8e935de1056d3e98693c685adcd569749624871cdbf219b6266d6",
    instructions: `Apply this drafting workflow when the task asks for a status update, progress report, or stakeholder summary:
- Establish the cadence and audience first — an executive update, an engineering update, and a customer update need different length, framing, and detail.
- Pull accomplishments, blockers, decisions, and next steps from the available context, and ask for whatever the sources do not show instead of inventing it.
- Lead with the conclusion: a short summary and an honest overall status before any detail.
- Report status honestly, and move to at-risk at the first credible sign of trouble rather than the last.
- Make every ask specific — who is needed, for which decision, by when — and attach owners and dates to next steps.
- Keep executive updates within a few hundred words; keep engineering updates concrete with links, owners, and open decisions.
Never soften or omit a known risk to make the update read better.`,
    source: {
      repositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      path: "product-management/skills/stakeholder-update/SKILL.md",
      commit: "d4c8cec441011095e48eff077314cf966a69c642",
      upstreamVersion: "commit-d4c8cec441011095e48eff077314cf966a69c642",
      skillFileSha256: "bcdb8ee95dc34d025dcc3d98e7435c4dca45930581b3b7a8707f8770dd364e79",
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
    triggerPhrases: ["status update", "stakeholder update", "progress report", "weekly update", "draft the update"],
    priority: 10,
  },
] as const satisfies readonly GovernedSkillManifest[]
