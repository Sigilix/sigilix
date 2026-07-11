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
