import { describe, expect, it } from "vitest"
import {
  MCP_RUNTIME_SURFACES,
  MCP_SURFACES,
  curatedReadToolForVendor,
  effectiveMcpPolicy,
  isMcpRuntimeSurface,
  isMcpSurface,
  mcpMemoryIndexEnabled,
  mcpSurfaceEnabled,
  narrowMcpPolicy,
  vendorPolicyForUrl,
  type McpSurface,
} from "./runtime-policy"

const ALL_SURFACES_OFF = {
  chat: false,
  "deep-research": false,
  cli: false,
  "pr-review": false,
  agent: false,
  "memory-index": false,
} as const

const RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF = {
  chat: true,
  "deep-research": true,
  cli: true,
  "pr-review": true,
  agent: true,
  "memory-index": false,
} as const

const ALL_SURFACES_ON = {
  ...RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF,
  "memory-index": true,
} as const

const VERIFIED_VENDOR_CASES = [
  {
    vendor: "linear",
    url: "https://mcp.linear.app/mcp",
    tools: ["list_comments", "list_users", "list_issue_labels"],
  },
  {
    vendor: "sentry",
    url: "https://mcp.sentry.dev/mcp",
    tools: ["find_organizations", "find_projects", "get_sentry_resource", "search_events", "search_issues"],
  },
  {
    vendor: "cloudflare",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    tools: [
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
    ],
  },
  {
    vendor: "supabase",
    url: "https://mcp.supabase.com/mcp",
    tools: [
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
    ],
  },
  {
    vendor: "notion",
    url: "https://mcp.notion.com/mcp",
    tools: [
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
    ],
  },
  {
    vendor: "atlassian",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    tools: [
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
    ],
  },
  {
    vendor: "stripe",
    url: "https://mcp.stripe.com/",
    tools: [
      "stripe_api_search",
      "stripe_api_details",
      "stripe_api_read",
      "get_stripe_account_info",
      "search_stripe_resources",
      "fetch_stripe_resources",
      "search_stripe_documentation",
      "stripe_implementation_planner",
    ],
  },
  {
    vendor: "vercel",
    url: "https://mcp.vercel.com/",
    tools: [
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
    ],
  },
  {
    vendor: "hubspot",
    url: "https://mcp.hubspot.com/",
    tools: [
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
    ],
  },
  {
    vendor: "intercom",
    url: "https://mcp.intercom.com/mcp",
    tools: [
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
    ],
  },
] as const

describe("MCP server-owned runtime policy", () => {
  it("defines every product surface explicitly while keeping memory indexing non-runtime", () => {
    expect(MCP_SURFACES).toEqual(["chat", "deep-research", "cli", "pr-review", "agent", "memory-index"])
    expect(MCP_RUNTIME_SURFACES).toEqual(["chat", "deep-research", "cli", "pr-review", "agent"])
    for (const surface of MCP_SURFACES) expect(isMcpSurface(surface)).toBe(true)
    for (const surface of MCP_RUNTIME_SURFACES) expect(isMcpRuntimeSurface(surface)).toBe(true)
    expect(isMcpRuntimeSurface("memory-index")).toBe(false)
    expect(isMcpSurface("unknown")).toBe(false)
  })

  it("matches only exact HTTPS official endpoints", () => {
    expect(vendorPolicyForUrl("https://mcp.linear.app/mcp")?.vendor).toBe("linear")
    expect(vendorPolicyForUrl("https://mcp.linear.app/mcp/")?.vendor).toBe("linear")
    expect(vendorPolicyForUrl("http://mcp.linear.app/mcp")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.linear.app.evil.example/mcp")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.linear.app:8443/mcp")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.linear.app/mcp?tool=read")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.atlassian.com/v1/mcp")?.vendor).toBe("atlassian")
    expect(vendorPolicyForUrl("https://mcp.atlassian.com/v1/mcp/authv2")?.vendor).toBe("atlassian")
    expect(vendorPolicyForUrl("https://mcp.atlassian.com/v1/mcp/authv2/extra")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.atlassian.com/v1/mcp/anything-else")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.supabase.com/mcp/project/ref")).toBeNull()
    expect(vendorPolicyForUrl("https://mcp.vercel.com/team/acme")).toBeNull()
  })

  it.each(VERIFIED_VENDOR_CASES)(
    "keeps the verified $vendor catalog dark until an explicit policy update",
    ({ vendor, url, tools }) => {
      expect(vendorPolicyForUrl(url)).toMatchObject({ vendor })
      expect(vendorPolicyForUrl(url)?.surfaces).toEqual(ALL_SURFACES_ON)
      expect(vendorPolicyForUrl(url)?.surfaces["memory-index"]).toBe(true)
      expect(vendorPolicyForUrl(url)?.readTools.map((tool) => tool.name)).toEqual(tools)
      expect(effectiveMcpPolicy(url)).toEqual({
        vendor,
        version: 0,
        enabled: false,
        surfaces: ALL_SURFACES_OFF,
        allowedReadTools: [],
        availableReadTools: tools,
        maxCallsPerRun: 0,
      })
      for (const name of tools) expect(curatedReadToolForVendor(vendor, name)).not.toBeNull()
      expect(curatedReadToolForVendor(vendor, "unreviewed_write_tool")).toBeNull()

      expect(
        narrowMcpPolicy(url, {
          version: 0,
          enabled: true,
          surfaces: RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF,
          allowedReadTools: [tools[0]],
          maxCallsPerRun: 4,
        }),
      ).toEqual({
        ok: true,
        policy: {
          version: 1,
          enabled: true,
          surfaces: RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF,
          allowedReadTools: [tools[0]],
          maxCallsPerRun: 4,
        },
      })
    },
  )

  it("gives custom MCP servers zero runtime surfaces and tools", () => {
    expect(effectiveMcpPolicy("https://example.com/mcp")).toEqual({
      vendor: "custom",
      version: 0,
      enabled: false,
      surfaces: ALL_SURFACES_OFF,
      allowedReadTools: [],
      availableReadTools: [],
      maxCallsPerRun: 0,
    })
  })

  it("never grants an unknown or write-looking tool from remote metadata", () => {
    const policy = effectiveMcpPolicy("https://mcp.linear.app/mcp")
    expect(policy.allowedReadTools).not.toContain("create_issue")
    expect(policy.allowedReadTools).toEqual([])
    expect(policy.availableReadTools).toContain("list_comments")
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces: RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF,
        allowedReadTools: ["list_issues"],
        maxCallsPerRun: 4,
      }),
    ).toEqual({ ok: false, error: "unsupported_tool" })
  })

  it("lets internal consumers independently verify the exact vendor/tool tuple", () => {
    expect(curatedReadToolForVendor("linear", "list_comments")?.description).toMatch(/read linear comments/i)
    expect(curatedReadToolForVendor("linear", "create_issue")).toBeNull()
    expect(curatedReadToolForVendor("custom", "list_comments")).toBeNull()
  })

  it("accepts a strict narrowing to no surfaces and no tools", () => {
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: false,
        surfaces: ALL_SURFACES_OFF,
        allowedReadTools: [],
        maxCallsPerRun: 0,
      }),
    ).toEqual({
      ok: true,
      policy: {
        version: 1,
        enabled: false,
        surfaces: ALL_SURFACES_OFF,
        allowedReadTools: [],
        maxCallsPerRun: 0,
      },
    })
  })

  it("rejects a stale optimistic-concurrency version", () => {
    expect(
      narrowMcpPolicy(
        "https://mcp.linear.app/mcp",
        {
          version: 0,
          enabled: true,
          surfaces: RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF,
          allowedReadTools: [],
          maxCallsPerRun: 1,
        },
        2,
      ),
    ).toEqual({ ok: false, error: "stale_version" })
  })

  it("treats the global policy switch as authoritative for every surface", () => {
    const policy = effectiveMcpPolicy("https://mcp.linear.app/mcp", {
      version: 1,
      enabled: false,
      surfaces: RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF,
      allowedReadTools: ["list_comments"],
      maxCallsPerRun: 4,
    })

    for (const surface of MCP_SURFACES) expect(mcpSurfaceEnabled(policy, surface)).toBe(false)
  })

  it("fails closed when a stored policy is missing the new surface record", () => {
    const malformedStored = {
      version: 1,
      enabled: true,
      allowedReadTools: ["list_comments"],
      maxCallsPerRun: 4,
    } as unknown as NonNullable<Parameters<typeof effectiveMcpPolicy>[1]>

    const policy = effectiveMcpPolicy("https://mcp.linear.app/mcp", malformedStored)
    expect(policy.surfaces).toEqual(ALL_SURFACES_OFF)
    for (const surface of MCP_SURFACES) expect(mcpSurfaceEnabled(policy, surface)).toBe(false)
  })

  it("keeps memory non-invokable while exposing a separate, explicit index-policy check", () => {
    const narrowed = narrowMcpPolicy("https://mcp.linear.app/mcp", {
      version: 0,
      enabled: true,
      surfaces: ALL_SURFACES_ON,
      allowedReadTools: ["list_comments"],
      maxCallsPerRun: 1,
    })
    if (!narrowed.ok) throw new Error(narrowed.error)
    const effective = effectiveMcpPolicy("https://mcp.linear.app/mcp", narrowed.policy)

    expect(mcpSurfaceEnabled(effective, "memory-index")).toBe(false)
    expect(mcpMemoryIndexEnabled(effective)).toBe(true)
    expect(mcpMemoryIndexEnabled({ ...effective, allowedReadTools: [] })).toBe(false)
  })

  it("allows each runtime surface to be independently disabled", () => {
    for (const disabledSurface of MCP_RUNTIME_SURFACES) {
      const surfaces = { ...RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF, [disabledSurface]: false }
      const narrowed = narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces,
        allowedReadTools: ["list_comments"],
        maxCallsPerRun: 1,
      })
      expect(narrowed).toMatchObject({ ok: true, policy: { surfaces } })
      if (!narrowed.ok) throw new Error(narrowed.error)
      const effective = effectiveMcpPolicy("https://mcp.linear.app/mcp", narrowed.policy)
      expect(mcpSurfaceEnabled(effective, disabledSurface)).toBe(false)
      for (const surface of MCP_RUNTIME_SURFACES.filter((candidate) => candidate !== disabledSurface)) {
        expect(mcpSurfaceEnabled(effective, surface)).toBe(true)
      }
      expect(mcpSurfaceEnabled(effective, "memory-index")).toBe(false)
    }
  })

  it("accepts installation-admin memory indexing as an explicit non-runtime surface", () => {
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces: ALL_SURFACES_ON,
        allowedReadTools: ["list_comments"],
        maxCallsPerRun: 1,
      }),
    ).toEqual({
      ok: true,
      policy: {
        version: 1,
        enabled: true,
        surfaces: ALL_SURFACES_ON,
        allowedReadTools: ["list_comments"],
        maxCallsPerRun: 1,
      },
    })
  })

  it.each(MCP_SURFACES)("requires the explicit %s surface field", (missingSurface) => {
    const surfaces = { ...RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF } as Record<McpSurface, boolean>
    delete surfaces[missingSurface]
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces,
        allowedReadTools: [],
        maxCallsPerRun: 1,
      }),
    ).toEqual({ ok: false, error: "invalid_policy" })
  })

  it.each(MCP_SURFACES)("requires a boolean %s surface field", (invalidSurface) => {
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces: { ...RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF, [invalidSurface]: "yes" },
        allowedReadTools: [],
        maxCallsPerRun: 1,
      }),
    ).toEqual({ ok: false, error: "invalid_policy" })
  })

  it("rejects unknown surface fields", () => {
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces: { ...RUNTIME_SURFACES_ON_MEMORY_INDEX_OFF, deployment: false },
        allowedReadTools: [],
        maxCallsPerRun: 1,
      }),
    ).toEqual({ ok: false, error: "invalid_policy" })
  })

  it("accepts the legacy two-switch portal shape while keeping every new surface off", () => {
    expect(
      narrowMcpPolicy("https://mcp.linear.app/mcp", {
        version: 0,
        enabled: true,
        surfaces: { chat: true, deepResearch: true },
        allowedReadTools: ["list_comments"],
        maxCallsPerRun: 1,
      }),
    ).toMatchObject({
      ok: true,
      policy: {
        surfaces: { ...ALL_SURFACES_OFF, chat: true, "deep-research": true },
      },
    })
  })
})
