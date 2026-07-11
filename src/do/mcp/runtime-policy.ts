export const MCP_RUNTIME_SURFACES = ["chat", "deep-research", "cli", "pr-review", "agent"] as const
export type McpRuntimeSurface = (typeof MCP_RUNTIME_SURFACES)[number]

export const MCP_SURFACES = [...MCP_RUNTIME_SURFACES, "memory-index"] as const
export type McpSurface = (typeof MCP_SURFACES)[number]

/**
 * `memory-index` is intentionally visible in the policy contract so callers
 * cannot mistake an absent field for an enabled capability. Its literal
 * `false` type keeps it structurally unavailable until a provenance-aware
 * indexer exists.
 */
export type McpSurfacePolicy = Readonly<
  Record<McpRuntimeSurface, boolean> & {
    "memory-index": false
  }
>

export type OfficialMcpVendor =
  | "linear"
  | "sentry"
  | "cloudflare"
  | "supabase"
  | "notion"
  | "atlassian"
  | "stripe"
  | "vercel"
  | "hubspot"
  | "intercom"

export interface CuratedReadTool {
  name: string
  /** Sigilix-authored neutral description. Remote descriptions never grant or
   *  describe a runtime capability. */
  description: string
}

export interface VendorRuntimePolicy {
  vendor: OfficialMcpVendor
  surfaces: McpSurfacePolicy
  readTools: readonly CuratedReadTool[]
}

interface OfficialEndpoint {
  vendor: OfficialMcpVendor
  hostname: string
  pathname: string
}

/** Exact portal-visible official endpoints. Host suffixes, alternate paths,
 *  non-default ports, credentials, queries, and fragments are not aliases. */
const OFFICIAL_ENDPOINTS: readonly OfficialEndpoint[] = [
  { vendor: "linear", hostname: "mcp.linear.app", pathname: "/mcp" },
  { vendor: "sentry", hostname: "mcp.sentry.dev", pathname: "/mcp" },
  { vendor: "cloudflare", hostname: "bindings.mcp.cloudflare.com", pathname: "/mcp" },
  { vendor: "supabase", hostname: "mcp.supabase.com", pathname: "/mcp" },
  { vendor: "notion", hostname: "mcp.notion.com", pathname: "/mcp" },
  { vendor: "atlassian", hostname: "mcp.atlassian.com", pathname: "/v1/mcp" },
  { vendor: "atlassian", hostname: "mcp.atlassian.com", pathname: "/v1/mcp/authv2" },
  { vendor: "stripe", hostname: "mcp.stripe.com", pathname: "/" },
  { vendor: "vercel", hostname: "mcp.vercel.com", pathname: "/" },
  { vendor: "hubspot", hostname: "mcp.hubspot.com", pathname: "/" },
  { vendor: "intercom", hostname: "mcp.intercom.com", pathname: "/mcp" },
]

/**
 * The runtime allowlist is intentionally limited to exact remote tool names
 * verified from provider-owned documentation or a checked-in fixture.
 * Remote annotations (`readOnlyHint`) and prose are untrusted and can never
 * promote a tool into this catalog. Adding a tool here is a reviewed server-
 * owned capability change, not a discovery-time inference.
 */
const CURATED_READ_TOOLS: Readonly<Record<OfficialMcpVendor, readonly CuratedReadTool[]>> = {
  // Exact names are published in Linear's own MCP changelog. Keep this list
  // intentionally smaller than the remote discovery result: a new server tool
  // remains denied until its read-only behavior is reviewed here.
  linear: [
    { name: "list_comments", description: "Read Linear comments visible to the connected account." },
    { name: "list_users", description: "Read Linear users visible to the connected account." },
    { name: "list_issue_labels", description: "Read Linear issue labels visible to the connected account." },
  ],
  sentry: reviewedReadTools("Sentry", [
    "find_organizations",
    "find_projects",
    "get_sentry_resource",
    "search_events",
    "search_issues",
  ]),
  cloudflare: reviewedReadTools("Cloudflare", [
    "kv_namespaces_list",
    "kv_namespace_get",
    "r2_buckets_list",
    "r2_bucket_get",
    "d1_databases_list",
    "d1_database_get",
    "workers_list",
    "workers_get_worker",
    "workers_get_worker_code",
    "hyperdrive_configs_list",
    "hyperdrive_config_get",
    "search_cloudflare_documentation",
    "migrate_pages_to_workers_guide",
  ]),
  supabase: reviewedReadTools("Supabase", [
    "list_tables",
    "list_extensions",
    "list_migrations",
    "get_logs",
    "get_advisors",
    "get_project_url",
    "generate_typescript_types",
    "list_edge_functions",
    "get_edge_function",
    "list_projects",
    "get_project",
    "list_organizations",
    "get_organization",
    "get_cost",
    "search_docs",
    "list_branches",
    "list_storage_buckets",
    "get_storage_config",
  ]),
  notion: reviewedReadTools("Notion", [
    "notion-search",
    "notion-fetch",
    "notion-query-data-sources",
    "notion-query-database-view",
    "notion-get-comments",
    "notion-get-teams",
    "notion-get-users",
    "notion-get-self",
    "search",
    "fetch",
  ]),
  atlassian: reviewedReadTools("Atlassian", [
    "atlassianUserInfo",
    "getAccessibleAtlassianResources",
    "getJiraIssue",
    "getJiraIssueRemoteIssueLinks",
    "getJiraIssueTypeMetaWithFields",
    "getJiraProjectIssueTypesMetadata",
    "getIssueLinkTypes",
    "getTransitionsForJiraIssue",
    "getVisibleJiraProjects",
    "lookupJiraAccountId",
    "searchJiraIssuesUsingJql",
    "getConfluencePage",
    "getConfluencePageDescendants",
    "getConfluencePageFooterComments",
    "getConfluencePageInlineComments",
    "getConfluenceCommentChildren",
    "getConfluenceSpaces",
    "getPagesInConfluenceSpace",
    "searchConfluenceUsingCql",
  ]),
  stripe: reviewedReadTools("Stripe", [
    "stripe_api_search",
    "stripe_api_details",
    "stripe_api_read",
    "get_stripe_account_info",
    "search_stripe_resources",
    "fetch_stripe_resources",
    "search_stripe_documentation",
    "stripe_implementation_planner",
  ]),
  vercel: reviewedReadTools("Vercel", [
    "search_documentation",
    "list_teams",
    "list_projects",
    "get_project",
    "list_deployments",
    "get_deployment",
    "get_deployment_build_logs",
    "get_runtime_logs",
    "check_domain_availability_and_price",
    "web_fetch_vercel_url",
    "list_toolbar_threads",
    "get_toolbar_thread",
  ]),
  hubspot: reviewedReadTools("HubSpot", [
    "get_user_details",
    "search_crm_objects",
    "get_crm_objects",
    "search_properties",
    "get_properties",
    "search_owners",
    "get_campaign_contacts_by_type",
    "get_campaign_analytics",
    "get_campaign_asset_types",
    "get_campaign_asset_metrics",
  ]),
  intercom: reviewedReadTools("Intercom", [
    "search",
    "fetch",
    "search_conversations",
    "get_conversation",
    "search_contacts",
    "get_contact",
    "list_companies",
    "get_company",
    "list_articles",
    "search_articles",
    "get_article",
  ]),
}

export interface StoredMcpPolicy {
  version: number
  enabled: boolean
  surfaces: McpSurfacePolicy
  allowedReadTools: string[]
  maxCallsPerRun: number
}

export interface EffectiveMcpPolicy extends StoredMcpPolicy {
  vendor: OfficialMcpVendor | "custom"
  availableReadTools: string[]
}

/** Maximum reviewed capability held by the private credential vault. Tenant
 * grants always apply a second, independently-versioned narrowing layer. */
export function maximumMcpPolicy(rawUrl: string): StoredMcpPolicy {
  const base = vendorPolicyForUrl(rawUrl)
  if (!base) {
    return {
      version: 1,
      enabled: false,
      surfaces: surfacePolicy(),
      allowedReadTools: [],
      maxCallsPerRun: 0,
    }
  }
  return {
    version: 1,
    enabled: true,
    surfaces: base.surfaces,
    allowedReadTools: base.readTools.map((tool) => tool.name),
    maxCallsPerRun: 4,
  }
}

/** Intersection used by the tenant broker. Neither the user-vault ceiling nor
 * the tenant grant can independently broaden the effective capability. */
export function intersectMcpPolicies(
  rawUrl: string,
  owner: StoredMcpPolicy,
  grant: StoredMcpPolicy,
): EffectiveMcpPolicy {
  const ownerEffective = effectiveMcpPolicy(rawUrl, owner)
  const grantEffective = effectiveMcpPolicy(rawUrl, grant)
  const allowed = grantEffective.allowedReadTools.filter((name) => ownerEffective.allowedReadTools.includes(name))
  return {
    vendor: ownerEffective.vendor,
    version: grantEffective.version,
    enabled: ownerEffective.enabled && grantEffective.enabled,
    surfaces: surfacePolicy(
      Object.fromEntries(
        MCP_RUNTIME_SURFACES.map((surface) => [
          surface,
          ownerEffective.surfaces[surface] && grantEffective.surfaces[surface],
        ]),
      ) as Record<McpRuntimeSurface, boolean>,
    ),
    allowedReadTools: allowed,
    availableReadTools: ownerEffective.availableReadTools.filter((name) =>
      grantEffective.availableReadTools.includes(name),
    ),
    maxCallsPerRun: Math.min(ownerEffective.maxCallsPerRun, grantEffective.maxCallsPerRun),
  }
}

export type NarrowPolicyResult = { ok: true; policy: StoredMcpPolicy } | { ok: false; error: string }

export function vendorPolicyForUrl(rawUrl: string): VendorRuntimePolicy | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null
  }
  const pathname = normalizePath(url.pathname)
  const endpoint = OFFICIAL_ENDPOINTS.find(
    (candidate) => candidate.hostname === url.hostname.toLowerCase() && candidate.pathname === pathname,
  )
  if (!endpoint) return null
  return {
    vendor: endpoint.vendor,
    surfaces: surfacePolicy({
      chat: true,
      "deep-research": true,
      cli: true,
      "pr-review": true,
      agent: true,
    }),
    readTools: CURATED_READ_TOOLS[endpoint.vendor],
  }
}

export function effectiveMcpPolicy(rawUrl: string, stored?: StoredMcpPolicy): EffectiveMcpPolicy {
  const base = vendorPolicyForUrl(rawUrl)
  if (!base) {
    return {
      vendor: "custom",
      version: stored?.version ?? 0,
      enabled: false,
      surfaces: surfacePolicy(),
      allowedReadTools: [],
      availableReadTools: [],
      maxCallsPerRun: 0,
    }
  }
  const availableReadTools = base.readTools.map((tool) => tool.name)
  const allowed = stored ? stored.allowedReadTools.filter((name) => availableReadTools.includes(name)) : []
  const storedSurfaces: Record<string, unknown> = isPlainObject(stored?.surfaces) ? stored.surfaces : {}
  return {
    vendor: base.vendor,
    version: stored?.version ?? 0,
    enabled: stored?.enabled ?? false,
    surfaces: surfacePolicy(
      Object.fromEntries(
        MCP_RUNTIME_SURFACES.map((surface) => [surface, base.surfaces[surface] && storedSurfaces[surface] === true]),
      ) as Record<McpRuntimeSurface, boolean>,
    ),
    allowedReadTools: allowed,
    availableReadTools,
    maxCallsPerRun: Math.min(stored?.maxCallsPerRun ?? 0, 4),
  }
}

export function narrowMcpPolicy(rawUrl: string, value: unknown, currentVersion = 0): NarrowPolicyResult {
  const base = vendorPolicyForUrl(rawUrl)
  if (!base) return { ok: false, error: "custom_runtime_disabled" }
  if (!isPlainObject(value)) return { ok: false, error: "invalid_policy" }
  const keys = Object.keys(value)
  if (keys.some((key) => !["version", "enabled", "surfaces", "allowedReadTools", "maxCallsPerRun"].includes(key))) {
    return { ok: false, error: "invalid_policy" }
  }
  if (value.version !== currentVersion) return { ok: false, error: "stale_version" }
  const rawSurfaces = value.surfaces
  if (typeof value.enabled !== "boolean" || !isPlainObject(rawSurfaces)) {
    return { ok: false, error: "invalid_policy" }
  }
  let requestedSurfaces: McpSurfacePolicy
  const surfaceKeys = Object.keys(rawSurfaces)
  if (
    surfaceKeys.length === 2 &&
    surfaceKeys.includes("chat") &&
    surfaceKeys.includes("deepResearch") &&
    typeof rawSurfaces.chat === "boolean" &&
    typeof rawSurfaces.deepResearch === "boolean"
  ) {
    // Rolling-deploy compatibility for the pre-SIG-556 portal. It can only
    // carry the two historical switches, so every new surface stays off.
    requestedSurfaces = surfacePolicy({ chat: rawSurfaces.chat, "deep-research": rawSurfaces.deepResearch })
  } else {
    if (
      surfaceKeys.length !== MCP_SURFACES.length ||
      surfaceKeys.some((key) => !isMcpSurface(key)) ||
      MCP_SURFACES.some((surface) => typeof rawSurfaces[surface] !== "boolean")
    ) {
      return { ok: false, error: "invalid_policy" }
    }
    if (rawSurfaces["memory-index"]) return { ok: false, error: "unsupported_surface" }
    requestedSurfaces = surfacePolicy(
      Object.fromEntries(MCP_RUNTIME_SURFACES.map((surface) => [surface, rawSurfaces[surface]])) as Record<
        McpRuntimeSurface,
        boolean
      >,
    )
  }
  if (!Array.isArray(value.allowedReadTools) || value.allowedReadTools.length > 64) {
    return { ok: false, error: "invalid_policy" }
  }
  const names = value.allowedReadTools
  if (names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 128)) {
    return { ok: false, error: "invalid_policy" }
  }
  const unique = [...new Set(names as string[])]
  const available = new Set(base.readTools.map((tool) => tool.name))
  if (unique.some((name) => !available.has(name))) return { ok: false, error: "unsupported_tool" }
  const maxCallsPerRun = value.maxCallsPerRun
  if (
    typeof maxCallsPerRun !== "number" ||
    !Number.isSafeInteger(maxCallsPerRun) ||
    maxCallsPerRun < 0 ||
    maxCallsPerRun > 4
  ) {
    return { ok: false, error: "invalid_policy" }
  }
  return {
    ok: true,
    policy: {
      version: currentVersion + 1,
      enabled: value.enabled,
      surfaces: surfacePolicy(
        Object.fromEntries(
          MCP_RUNTIME_SURFACES.map((surface) => [surface, base.surfaces[surface] && requestedSurfaces[surface]]),
        ) as Record<McpRuntimeSurface, boolean>,
      ),
      allowedReadTools: unique,
      maxCallsPerRun,
    },
  }
}

export function curatedReadTool(rawUrl: string, name: string): CuratedReadTool | null {
  return vendorPolicyForUrl(rawUrl)?.readTools.find((tool) => tool.name === name) ?? null
}

/** Defense-in-depth check for consumers of the internal runtime catalog. The
 *  MCP DO already applies this table before returning a descriptor; callers
 *  can independently reject a forged or stale vendor/tool tuple. */
export function curatedReadToolForVendor(vendor: string, name: string): CuratedReadTool | null {
  if (!isOfficialVendor(vendor)) return null
  return CURATED_READ_TOOLS[vendor].find((tool) => tool.name === name) ?? null
}

export function isMcpSurface(value: unknown): value is McpSurface {
  return typeof value === "string" && (MCP_SURFACES as readonly string[]).includes(value)
}

export function isMcpRuntimeSurface(value: unknown): value is McpRuntimeSurface {
  return typeof value === "string" && (MCP_RUNTIME_SURFACES as readonly string[]).includes(value)
}

export function mcpSurfaceEnabled(policy: EffectiveMcpPolicy, surface: McpSurface): boolean {
  return surface !== "memory-index" && policy.enabled && policy.surfaces[surface] === true
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return pathname
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOfficialVendor(value: string): value is OfficialMcpVendor {
  return Object.hasOwn(CURATED_READ_TOOLS, value)
}

function surfacePolicy(enabled: Partial<Record<McpRuntimeSurface, boolean>> = {}): McpSurfacePolicy {
  return {
    chat: enabled.chat ?? false,
    "deep-research": enabled["deep-research"] ?? false,
    cli: enabled.cli ?? false,
    "pr-review": enabled["pr-review"] ?? false,
    agent: enabled.agent ?? false,
    "memory-index": false,
  }
}

function reviewedReadTools(vendor: string, names: readonly string[]): readonly CuratedReadTool[] {
  return names.map((name) => ({
    name,
    description: `Use the reviewed ${vendor} ${name} read capability for data visible to the connected account.`,
  }))
}
