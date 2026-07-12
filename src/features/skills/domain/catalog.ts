// SIG-561 — server-owned, reviewed guidance catalog. Runtime code never fetches
// upstream repositories: every source is pinned here and changes only through a
// reviewed code change. The injected text is intentionally Sigilix-authored,
// bounded guidance rather than executable package content.

export const SKILL_SURFACES = ["chat", "deep-research", "cli", "pr-review", "agent"] as const
export type SkillSurface = (typeof SKILL_SURFACES)[number]

export interface SkillSourceProvenance {
  repositoryUrl: string
  path: string
  commit: string
  upstreamVersion: string
  skillFileSha256: string
  license: "Apache-2.0" | "MIT"
  licenseUrl: string
  publisher: string
}

export interface SkillReviewProvenance {
  status: "approved-guidance-only"
  reviewedBy: "sigilix-engineering"
  reviewedAt: "2026-07-11"
}

export interface SkillCapabilityRequirement {
  kind: "mcp-tool"
  vendor: string
  tool: string
}

export interface GovernedSkillManifest {
  schemaVersion: 1
  id: string
  name: string
  description: string
  instructionVersion: 1
  instructionSha256: string
  instructions: string
  source: SkillSourceProvenance
  review: SkillReviewProvenance
  appIds: readonly string[]
  eligibleSurfaces: readonly SkillSurface[]
  /** Schema-required capability prerequisites. They only gate resolution; a
   * guidance skill can never acquire or widen an MCP/tool capability. */
  requiredCapabilities: readonly SkillCapabilityRequirement[]
  dataSensitivity: "public-guidance"
  triggerPhrases: readonly string[]
  /** Deterministic specificity rank. Lower values win. */
  priority: number
}

const CHAT_RESEARCH_SURFACES = ["chat", "deep-research"] as const satisfies readonly SkillSurface[]

const REVIEW: SkillReviewProvenance = {
  status: "approved-guidance-only",
  reviewedBy: "sigilix-engineering",
  reviewedAt: "2026-07-11",
}

export const GOVERNED_SKILL_CATALOG = [
  {
    schemaVersion: 1,
    id: "supabase-postgres-best-practices",
    name: "Supabase Postgres best practices",
    description: "Reviewed Postgres performance, schema, connection, and row-level-security guidance from Supabase.",
    instructionVersion: 1,
    instructionSha256: "da5fddfbf8af5765cd0934ded1d65e9a3d27f79168eab78c7c50e70762aa6ed8",
    instructions: `Apply these Postgres practices when the task concerns SQL, schema design, performance, or RLS:
- Prioritize query plans, appropriate indexes, bounded pagination, and removal of N+1 access patterns.
- Treat connection limits and pooling as production constraints; keep transactions short and design to prevent deadlocks.
- Prefer explicit constraints, suitable data types, lowercase identifiers, indexed foreign keys, and deliberate primary keys.
- Enforce least privilege and row-level security. Check both correctness and RLS query performance before recommending a policy.
- Use evidence such as EXPLAIN plans, database statistics, logs, or the visible schema before claiming a performance problem.
- Separate critical query, connection, and security risks from lower-priority monitoring or advanced optimizations.
Only make claims supported by the task context. Present proposed SQL as a reviewable change, never as an already-applied mutation.`,
    source: {
      repositoryUrl: "https://github.com/supabase/agent-skills",
      path: "skills/supabase-postgres-best-practices/SKILL.md",
      commit: "1ad9aaeb49caafd9e95c0a91116f71890eebbc53",
      upstreamVersion: "1.1.1",
      skillFileSha256: "ccd6e4596bd51cf344fe76c464867c541ccc16b6d90ae7a9db449fb17588613b",
      license: "MIT",
      licenseUrl: "https://github.com/supabase/agent-skills/blob/1ad9aaeb49caafd9e95c0a91116f71890eebbc53/LICENSE",
      publisher: "Supabase",
    },
    review: REVIEW,
    appIds: ["supabase"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "supabase",
      "postgres",
      "postgresql",
      "row level security",
      "rls policy",
      "sql query",
      "database schema",
      "database index",
    ],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "supabase-platform-workflows",
    name: "Supabase platform workflows",
    description: "Reviewed Supabase Auth, Data API, migration, Storage, and project-troubleshooting guidance.",
    instructionVersion: 1,
    instructionSha256: "0765dbc86876a8d177d8fb11c66d7085abaaa483fa22e564f45f12b8d442321b",
    instructions: `Apply these Supabase platform practices when the task concerns Auth, the Data API, migrations, Storage, Edge Functions, or project setup:
- Verify version-sensitive behavior against current Supabase documentation and the checked-in project configuration before recommending an API, flag, or schema workflow.
- Treat Data API grants and row-level security as separate controls. Publicly reachable tables need deliberate role grants and policies that enforce the actual ownership model.
- Never use user-editable metadata for authorization, expose service-role credentials to a client, or treat an authenticated role by itself as object-level authorization.
- Determine whether the repository uses declarative schemas or imperative migrations before proposing a database change, and preserve its existing migration convention.
- For auth and storage failures, inspect session freshness, cookie boundaries, role grants, RLS policies, and the minimum required storage operations instead of retrying blindly.
- Separate evidence from recommendations. Present SQL, policy, or configuration changes as proposals until the user confirms they were applied and verified.
Use only task-visible evidence. Do not claim a dashboard setting, grant, policy, migration, or deployment already exists unless the supplied context proves it.`,
    source: {
      repositoryUrl: "https://github.com/supabase/agent-skills",
      path: "skills/supabase/SKILL.md",
      commit: "1ad9aaeb49caafd9e95c0a91116f71890eebbc53",
      upstreamVersion: "0.1.2",
      skillFileSha256: "4aa35891985d59880b241d3bc500124a0b533e088814ce7eb722839e9a6b3d81",
      license: "MIT",
      licenseUrl: "https://github.com/supabase/agent-skills/blob/1ad9aaeb49caafd9e95c0a91116f71890eebbc53/LICENSE",
      publisher: "Supabase",
    },
    review: REVIEW,
    appIds: ["supabase"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "supabase auth",
      "supabase storage",
      "supabase edge function",
      "supabase migration",
      "supabase data api",
      "supabase project setup",
      "supabase project configuration",
    ],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "cloudflare-durable-objects",
    name: "Cloudflare Durable Objects",
    description: "Reviewed design, storage, alarm, WebSocket, and testing guidance for Cloudflare Durable Objects.",
    instructionVersion: 1,
    instructionSha256: "0c869b79de334cd0720e591789af79d5607c781b002b0265da969d19a8664cac",
    instructions: `Apply these Durable Objects practices when the task concerns stateful coordination:
- Model one Durable Object around one coordination atom such as a room, tenant, or job; avoid a single global bottleneck.
- Use deterministic object naming when callers must reach the same entity, and keep stateless request work outside the object.
- Persist authoritative state before updating in-memory caches. Keep related SQLite writes together without an intervening await.
- Limit constructor concurrency blocking to schema initialization. Do not hold it across request handling or external I/O.
- Treat alarms as a single replaceable schedule per object and design rescheduling and idempotency explicitly.
- Prefer SQLite-backed storage for structured state, and test storage, alarms, and concurrency through the Workers runtime harness.
Ground recommendations in the visible code and configuration. Distinguish an existing control from a proposed change.`,
    source: {
      repositoryUrl: "https://github.com/cloudflare/skills",
      path: "skills/durable-objects/SKILL.md",
      commit: "27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      upstreamVersion: "commit-27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      skillFileSha256: "cd6797cb18f3ae8f721dfd2e5cb27b73a0aa8636683f1a38163dab2fd51a8dfb",
      license: "Apache-2.0",
      licenseUrl: "https://github.com/cloudflare/skills/blob/27ce0c0e159225caa7ed30ebefd4107aa6c52497/LICENSE",
      publisher: "Cloudflare",
    },
    review: REVIEW,
    appIds: ["cloudflare"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["durable object", "durable objects", "stateful coordination", "websocket hibernation", "do alarm"],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "cloudflare-workers-best-practices",
    name: "Cloudflare Workers best practices",
    description:
      "Reviewed production guidance for Cloudflare Workers code, bindings, configuration, and observability.",
    instructionVersion: 1,
    instructionSha256: "dfa7f73c7c02bb18ce5a4595c41d3a0ea4e2b0d282d24c46f1785244c82b59d5",
    instructions: `Apply these Cloudflare Workers practices when the task concerns Workers or Wrangler:
- Verify current Cloudflare documentation and project types before making version-sensitive API or configuration claims.
- Stream large or unknown response bodies; keep post-response work in ctx.waitUntil and preserve the context receiver.
- Prefer in-process bindings and service bindings over public REST hops from a Worker. Move background work to queues or workflows.
- Never keep request-scoped mutable state at module scope. Every promise must be awaited, returned, intentionally voided, or scheduled.
- Keep secrets out of source and committed configuration. Use Web Crypto for security-sensitive randomness and comparisons.
- Enable structured observability and align binding access with generated Worker types and the checked-in Wrangler configuration.
Flag only concrete, context-supported risks. Do not invent a platform limit or configuration field from memory.`,
    source: {
      repositoryUrl: "https://github.com/cloudflare/skills",
      path: "skills/workers-best-practices/SKILL.md",
      commit: "27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      upstreamVersion: "commit-27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      skillFileSha256: "099432ff265ff6080327ef0b392c118b835d2a5bda98a7de07e1afd115ed6458",
      license: "Apache-2.0",
      licenseUrl: "https://github.com/cloudflare/skills/blob/27ce0c0e159225caa7ed30ebefd4107aa6c52497/LICENSE",
      publisher: "Cloudflare",
    },
    review: REVIEW,
    appIds: ["cloudflare"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["cloudflare worker", "cloudflare workers", "wrangler", "workers binding", "worker binding"],
    priority: 10,
  },
  {
    schemaVersion: 1,
    id: "cloudflare-wrangler",
    name: "Cloudflare Wrangler",
    description:
      "Reviewed Wrangler configuration, local-development, binding, type-generation, and deployment guidance.",
    instructionVersion: 1,
    instructionSha256: "1da6342ad74d1733c34e4479876544bcc86340c38e69a8aedce85cf5ff1789f4",
    instructions: `Apply these Wrangler practices when the task concerns Wrangler commands or Cloudflare Worker configuration:
- Treat Wrangler flags, subcommands, binding shapes, and compatibility behavior as version-sensitive. Verify them against the installed version, config schema, or current Cloudflare documentation.
- Read the existing Wrangler configuration before proposing edits. Preserve its format and environment structure unless the task explicitly requests a migration.
- Keep compatibility dates, flags, bindings, migrations, and generated environment types aligned; call out any generated file that must be refreshed after a config change.
- Distinguish local simulation from remote resources, especially for stateful bindings, and state clearly when a recommendation would touch production data.
- Keep secrets out of source and committed configuration. Never print, invent, or move secret values into ordinary variables.
- Prefer dry-run or non-mutating validation evidence before deployment, and never describe a deployment as complete without a confirmed result.
Ground every command or configuration field in visible project evidence or current documentation.`,
    source: {
      repositoryUrl: "https://github.com/cloudflare/skills",
      path: "skills/wrangler/SKILL.md",
      commit: "27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      upstreamVersion: "commit-27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      skillFileSha256: "42abe11ba6c0cb0c135deed1d591d844838fe0b61fc8c6d675a832435508a61b",
      license: "Apache-2.0",
      licenseUrl: "https://github.com/cloudflare/skills/blob/27ce0c0e159225caa7ed30ebefd4107aa6c52497/LICENSE",
      publisher: "Cloudflare",
    },
    review: REVIEW,
    appIds: ["cloudflare"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["wrangler", "wrangler jsonc", "wrangler toml", "wrangler binding", "wrangler compatibility date"],
    priority: 4,
  },
  {
    schemaVersion: 1,
    id: "cloudflare-agents-sdk",
    name: "Cloudflare Agents SDK",
    description: "Reviewed state, routing, RPC, scheduling, streaming, and security guidance for Cloudflare Agents.",
    instructionVersion: 1,
    instructionSha256: "68305e4dde8347b8d4baf7d92c0b8f874794a2cf4e46662935ed0bbe64e6c2ae",
    instructions: `Apply these Cloudflare Agents SDK practices when the task concerns a stateful agent, agent routing, RPC, scheduling, or streaming:
- Verify the installed Agents SDK version and current Cloudflare documentation before relying on an API, decorator, route shape, or experimental capability.
- Model each agent around one durable identity and keep its binding, SQLite migration, route name, and client name consistent.
- Validate state transitions at the server boundary. Treat client state, callable arguments, webhook payloads, and connected MCP content as untrusted input.
- Make scheduled work, workflow steps, queue handlers, and retries idempotent, with explicit limits and observable failure states.
- Preserve authentication and authorization across HTTP, WebSocket, RPC, and cross-domain entry points; do not infer identity from a client-provided agent name.
- For human-in-the-loop or tool-calling flows, separate proposal from execution and require the product's existing approval boundary for mutations.
Base recommendations on the visible configuration and code. Label experimental or version-sensitive behavior instead of presenting it as stable.`,
    source: {
      repositoryUrl: "https://github.com/cloudflare/skills",
      path: "skills/agents-sdk/SKILL.md",
      commit: "27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      upstreamVersion: "commit-27ce0c0e159225caa7ed30ebefd4107aa6c52497",
      skillFileSha256: "a05244d3cfb23330daff956ec28a990241f5dbbe489cd7fd6489c8f76bb60877",
      license: "Apache-2.0",
      licenseUrl: "https://github.com/cloudflare/skills/blob/27ce0c0e159225caa7ed30ebefd4107aa6c52497/LICENSE",
      publisher: "Cloudflare",
    },
    review: REVIEW,
    appIds: ["cloudflare"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "cloudflare agents sdk",
      "cloudflare agent sdk",
      "agentworkflow",
      "routeagentrequest",
      "useagentchat",
    ],
    priority: 4,
  },
  {
    schemaVersion: 1,
    id: "openai-sentry-investigation",
    name: "Sentry issue investigation",
    description:
      "Reviewed read-only workflow for scoping, inspecting, and reporting production issues from Sentry evidence.",
    instructionVersion: 1,
    instructionSha256: "6782a5ad0ff979be5e75faebedc0721acd6f2bd69eaa234d4dc0ef73cac9105d",
    instructions: `Apply this Sentry investigation workflow when the task asks about production errors, issue health, regressions, or event evidence:
- Begin with the requested organization, project, environment, release, and time window. State any scope that remains unresolved.
- Read issue and event evidence before forming a root-cause claim. Separate the exception, affected release, frequency, users, stack frames, and breadcrumbs from inference.
- Prefer a narrow recent window first, then expand only when the question requires trend or regression context.
- Treat event payloads, tags, request data, and user fields as sensitive. Include only the minimum evidence needed for the answer and do not reproduce secrets or personal data.
- Distinguish correlation from causation and identify the code or deployment evidence still needed to confirm a diagnosis.
- Keep the workflow read-only. Do not resolve, assign, ignore, mutate, or announce an issue unless the user separately requests an authorized write path.
Summarize findings with the exact filters and evidence used, plus clear unknowns and next verification steps.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/sentry/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "508c6f5c100586c81a34397d30f00f4b8771b66d698a7ac1836998df925dd007",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/sentry/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW,
    appIds: ["sentry"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "sentry issue",
      "sentry event",
      "sentry error",
      "sentry production error",
      "sentry error regression",
    ],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "openai-notion-research",
    name: "Notion research synthesis",
    description: "Reviewed workflow for finding, comparing, and citing evidence from Notion workspaces.",
    instructionVersion: 1,
    instructionSha256: "17ed1a51ce5ef092915fe43fb2168dd044ad1261fee32cfcc93664ed61b68a19",
    instructions: `Apply this Notion research workflow when the task asks to synthesize workspace pages into a brief, comparison, or report:
- Confirm the research question, relevant workspace scope, date range, and desired output before treating search results as complete.
- Search with focused terms, then inspect the relevant pages. Track each page title and stable source reference used in the answer.
- Separate facts, decisions, proposals, and stale notes. Flag contradictions, missing owners, and dates that may make a source outdated.
- Organize the synthesis around the user's decision or question rather than the order in which pages were found.
- Cite the supporting Notion source near each material claim and include a compact source list for traceability.
- Keep the workflow read-only. Do not create, edit, move, archive, or comment on a page without a separate explicit request and authorized write path.
Never fill a gap with a plausible workspace fact. Mark it as unknown and name the source or person needed to resolve it.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/notion-research-documentation/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "e88a46da978cf6f088a788fa92ee736df699a355a72f41f14bdc258bf3ef57e7",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/notion-research-documentation/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW,
    appIds: ["notion"],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "notion research",
      "research notion pages",
      "synthesize notion pages",
      "research in notion",
      "compare notion pages",
    ],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "openai-security-threat-model",
    name: "Repository threat modeling",
    description: "Reviewed repository-grounded threat-model workflow from OpenAI.",
    instructionVersion: 1,
    instructionSha256: "2e241a4633a81e104e4b6b7c89a5492a6076b92afaae430a8b8eab813147c111",
    instructions: `Apply this workflow only when the user explicitly requests a threat model or abuse-path analysis:
- Define the in-scope runtime components and explicitly separate them from CI, development tooling, tests, and excluded paths.
- Derive concrete trust boundaries, assets, entry points, protocols, authentication, validation, and rate limits from repository evidence.
- State realistic attacker capabilities and non-capabilities. Prefer a small number of concrete attacker goals over a generic checklist.
- Express each threat as an abuse path tied to an asset and boundary, then rank likelihood and impact with short reasons.
- Distinguish existing mitigations supported by evidence from conditional recommendations, and identify assumptions that change priority.
- Cover every discovered entry point and boundary before finalizing a concise, actionable threat model.
Never claim a component or control that is not present in the supplied evidence.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/security-threat-model/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "1283c0dd62a8104d9edda4583569b5d8510b4ddaa45120687c999250fd96bad2",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: ["threat model", "threat modeling", "abuse path", "trust boundary", "attacker capabilities"],
    priority: 5,
  },
  {
    schemaVersion: 1,
    id: "openai-security-best-practices",
    name: "Security best practices",
    description: "Reviewed language- and framework-aware secure-development guidance from OpenAI.",
    instructionVersion: 1,
    instructionSha256: "797e16c333c05341a1494aadf7c615a0ea630595fc6d7b88a995a0410fb377ff",
    instructions: `Apply this workflow only when the user explicitly asks for security best practices, a security report, or secure-by-default help:
- Identify every in-scope language and primary framework before applying framework-specific advice, including both frontend and backend.
- Prefer secure defaults while preserving required behavior. Ground passive findings in visible code and focus on high-impact risks.
- For a requested report, prioritize findings by severity, give critical findings a concise impact statement, and cite concrete code locations.
- Separate verified vulnerabilities from hardening suggestions and assumptions. Avoid claiming missing TLS in local development as a defect.
- Treat cookie security and HSTS as deployment-sensitive controls; do not recommend settings that would break non-TLS development.
- Propose one focused fix at a time and account for compatibility and regression risk.
Do not turn a general code-review request into a security audit unless the user explicitly asks for one.`,
    source: {
      repositoryUrl: "https://github.com/openai/skills",
      path: "skills/.curated/security-best-practices/SKILL.md",
      commit: "49f948faa9258a0c61caceaf225e179651397431",
      upstreamVersion: "commit-49f948faa9258a0c61caceaf225e179651397431",
      skillFileSha256: "7b3dae1ffc5434d890f3c65c8f552af52d0307fab3b35dec13013c9ca3844c4f",
      license: "Apache-2.0",
      licenseUrl:
        "https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices/LICENSE.txt",
      publisher: "OpenAI",
    },
    review: REVIEW,
    appIds: [],
    eligibleSurfaces: CHAT_RESEARCH_SURFACES,
    requiredCapabilities: [],
    dataSensitivity: "public-guidance",
    triggerPhrases: [
      "security best practices",
      "security review",
      "security report",
      "secure by default",
      "vulnerability report",
    ],
    priority: 10,
  },
] as const satisfies readonly GovernedSkillManifest[]

export function governedSkillById(id: string): GovernedSkillManifest | null {
  return GOVERNED_SKILL_CATALOG.find((skill) => skill.id === id) ?? null
}
