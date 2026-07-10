export const MCP_SURFACES = ["chat", "deep-research"] as const
export type McpSurface = (typeof MCP_SURFACES)[number]

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
  chat: boolean
  deepResearch: boolean
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
  chatEnabled: boolean
  deepResearchEnabled: boolean
  allowedReadTools: string[]
  maxCallsPerRun: number
}

export interface EffectiveMcpPolicy extends StoredMcpPolicy {
  vendor: OfficialMcpVendor | "custom"
  availableReadTools: string[]
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
    chat: true,
    deepResearch: true,
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
      chatEnabled: false,
      deepResearchEnabled: false,
      allowedReadTools: [],
      availableReadTools: [],
      maxCallsPerRun: 0,
    }
  }
  const availableReadTools = base.readTools.map((tool) => tool.name)
  const allowed = stored ? stored.allowedReadTools.filter((name) => availableReadTools.includes(name)) : []
  return {
    vendor: base.vendor,
    version: stored?.version ?? 0,
    enabled: stored?.enabled ?? false,
    chatEnabled: base.chat && (stored?.chatEnabled ?? false),
    deepResearchEnabled: base.deepResearch && (stored?.deepResearchEnabled ?? false),
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
  if (typeof value.enabled !== "boolean" || !isPlainObject(value.surfaces)) {
    return { ok: false, error: "invalid_policy" }
  }
  if (
    Object.keys(value.surfaces).some((key) => key !== "chat" && key !== "deepResearch") ||
    typeof value.surfaces.chat !== "boolean" ||
    typeof value.surfaces.deepResearch !== "boolean"
  ) {
    return { ok: false, error: "invalid_policy" }
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
  if (
    !Number.isSafeInteger(value.maxCallsPerRun) ||
    (value.maxCallsPerRun as number) < 0 ||
    (value.maxCallsPerRun as number) > 4
  ) {
    return { ok: false, error: "invalid_policy" }
  }
  return {
    ok: true,
    policy: {
      version: currentVersion + 1,
      enabled: value.enabled,
      chatEnabled: base.chat && value.surfaces.chat,
      deepResearchEnabled: base.deepResearch && value.surfaces.deepResearch,
      allowedReadTools: unique,
      maxCallsPerRun: value.maxCallsPerRun as number,
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
  return value === "chat" || value === "deep-research"
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

function reviewedReadTools(vendor: string, names: readonly string[]): readonly CuratedReadTool[] {
  return names.map((name) => ({
    name,
    description: `Use the reviewed ${vendor} ${name} read capability for data visible to the connected account.`,
  }))
}
