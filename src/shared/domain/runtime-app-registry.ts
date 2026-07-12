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
  | "grafana"
  | "launchdarkly"
  | "datadog"
  | "netlify"
  | "slack"
  | "asana"

export const RUNTIME_APP_SURFACES = ["chat", "deep-research", "cli"] as const
export type RuntimeAppSurface = (typeof RUNTIME_APP_SURFACES)[number]

export const RUNTIME_APP_IDS = [
  "linear",
  "sentry",
  "cloudflare",
  "supabase",
  "notion",
  "jira",
  "confluence",
  "stripe",
  "vercel",
  "hubspot",
  "intercom",
  "grafana",
  "launchdarkly",
  "datadog",
  "netlify",
  "slack",
  "asana",
  "github",
] as const
export type RuntimeAppId = (typeof RUNTIME_APP_IDS)[number]

interface RuntimeAppBase {
  readonly id: RuntimeAppId
  readonly name: string
  readonly canonicalMention: string
  readonly aliases: readonly string[]
  readonly surfaces: readonly RuntimeAppSurface[]
}

export interface RuntimeMcpAppDefinition extends RuntimeAppBase {
  readonly kind: "mcp"
  readonly executable: true
  readonly vendor: OfficialMcpVendor
  /**
   * `null` means this app may use any tool independently authorized by the
   * server-owned vendor policy. A list is an additional app-level narrowing;
   * it never grants a tool that the vendor policy has not reviewed.
   */
  readonly compatibleToolNames: readonly string[] | null
}

export interface RuntimeBuiltinAppDefinition extends RuntimeAppBase {
  readonly kind: "builtin"
  readonly executable: false
  readonly vendor: null
  readonly compatibleToolNames: readonly []
}

export type RuntimeAppDefinition = RuntimeMcpAppDefinition | RuntimeBuiltinAppDefinition

export interface PublicRuntimeApp {
  id: RuntimeAppId
  name: string
  canonicalMention: string
  aliases: string[]
  surfaces: RuntimeAppSurface[]
}

export interface PublicRuntimeAppCatalog {
  version: 1
  apps: PublicRuntimeApp[]
}

export type RuntimeAppMentionRejectionReason = "invalid_mention" | "unknown_app" | "empty_task"

export type RuntimeAppRouteErrorCode = "invalid_app_mention" | "unknown_app" | "missing_app_task"

export interface RuntimeAppRouteErrorPayload {
  error: RuntimeAppRouteErrorCode
  message: string
}

export type ParseRuntimeAppMentionResult =
  | { kind: "none"; task: string }
  | { kind: "resolved"; appId: RuntimeAppId; mention: string; task: string }
  | { kind: "rejected"; reason: RuntimeAppMentionRejectionReason; mention: string }

const JIRA_READ_TOOLS = [
  "getJiraIssue",
  "getJiraIssueRemoteIssueLinks",
  "getJiraIssueTypeMetaWithFields",
  "getJiraProjectIssueTypesMetadata",
  "getIssueLinkTypes",
  "getTransitionsForJiraIssue",
  "getVisibleJiraProjects",
  "lookupJiraAccountId",
  "searchJiraIssuesUsingJql",
] as const

const CONFLUENCE_READ_TOOLS = [
  "getConfluencePage",
  "getConfluencePageDescendants",
  "getConfluencePageFooterComments",
  "getConfluencePageInlineComments",
  "getConfluenceCommentChildren",
  "getConfluenceSpaces",
  "getPagesInConfluenceSpace",
  "searchConfluenceUsingCql",
] as const

const MCP_SURFACES: readonly RuntimeAppSurface[] = RUNTIME_APP_SURFACES

const RUNTIME_APPS = [
  mcpApp("linear", "Linear", "linear"),
  mcpApp("sentry", "Sentry", "sentry"),
  mcpApp("cloudflare", "Cloudflare", "cloudflare", ["@CF"]),
  mcpApp("supabase", "Supabase", "supabase"),
  mcpApp("notion", "Notion", "notion"),
  mcpApp("jira", "Jira", "atlassian", [], JIRA_READ_TOOLS),
  mcpApp("confluence", "Confluence", "atlassian", [], CONFLUENCE_READ_TOOLS),
  mcpApp("stripe", "Stripe", "stripe"),
  mcpApp("vercel", "Vercel", "vercel"),
  mcpApp("hubspot", "HubSpot", "hubspot"),
  mcpApp("intercom", "Intercom", "intercom"),
  mcpApp("grafana", "Grafana", "grafana"),
  mcpApp("launchdarkly", "LaunchDarkly", "launchdarkly", ["@LD"]),
  mcpApp("datadog", "Datadog", "datadog"),
  mcpApp("netlify", "Netlify", "netlify"),
  mcpApp("slack", "Slack", "slack"),
  mcpApp("asana", "Asana", "asana"),
  // GitHub participates in deterministic mention resolution now so callers
  // can return a clear unavailable state instead of falling back to MCP. It
  // stays dark until the installation-scoped built-in adapter ships.
  {
    id: "github",
    name: "GitHub",
    canonicalMention: "@GitHub",
    aliases: ["@gh"],
    surfaces: [],
    kind: "builtin",
    executable: false,
    vendor: null,
    compatibleToolNames: [],
  },
] as const satisfies readonly RuntimeAppDefinition[]

const SAFE_MENTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const APP_BY_ID = new Map<string, RuntimeAppDefinition>()
const APP_BY_ALIAS = new Map<string, RuntimeAppDefinition>()

initializeRegistry()

export function resolveRuntimeApp(id: unknown): RuntimeAppDefinition | null {
  return typeof id === "string" ? (APP_BY_ID.get(id) ?? null) : null
}

/**
 * Checks only app/vendor routing compatibility. The MCP runtime policy must
 * still independently prove that `toolName` is a curated and enabled tool.
 */
export function isToolCompatibleWithRuntimeApp(appId: unknown, vendor: string, toolName: string): boolean {
  const app = resolveRuntimeApp(appId)
  if (!app || !app.executable || app.kind !== "mcp" || app.vendor !== vendor || toolName.length === 0) return false
  return app.compatibleToolNames === null || app.compatibleToolNames.includes(toolName)
}

export function publicRuntimeAppCatalog(): PublicRuntimeAppCatalog {
  return {
    version: 1,
    apps: RUNTIME_APPS.map((app) => ({
      id: app.id,
      name: app.name,
      canonicalMention: app.canonicalMention,
      aliases: [...app.aliases],
      surfaces: [...app.surfaces],
    })),
  }
}

export function parseLeadingRuntimeAppMention(input: string): ParseRuntimeAppMentionResult {
  const task = input.trim()
  if (!task.startsWith("@")) return { kind: "none", task }

  let tokenEnd = 1
  while (tokenEnd < task.length && !isMentionSeparator(task[tokenEnd] ?? "")) tokenEnd++
  const mention = task.slice(0, tokenEnd)
  const token = mention.slice(1)
  if (!SAFE_MENTION_TOKEN_RE.test(token)) {
    return { kind: "rejected", reason: "invalid_mention", mention }
  }

  const app = APP_BY_ALIAS.get(token.toLowerCase())
  if (!app) return { kind: "rejected", reason: "unknown_app", mention }

  const separator = task[tokenEnd]
  const remainderStart = separator === ":" || separator === "," ? tokenEnd + 1 : tokenEnd
  const cleanedTask = task.slice(remainderStart).trim()
  if (cleanedTask.length === 0) {
    return { kind: "rejected", reason: "empty_task", mention }
  }
  return { kind: "resolved", appId: app.id, mention, task: cleanedTask }
}

/** Stable, human-safe copy shared by every public app-routing surface. */
export function runtimeAppRouteError(reason: RuntimeAppMentionRejectionReason): RuntimeAppRouteErrorPayload {
  if (reason === "empty_task") {
    return { error: "missing_app_task", message: "Add a request after the app mention." }
  }
  if (reason === "unknown_app") {
    return { error: "unknown_app", message: "That app mention is not supported." }
  }
  return {
    error: "invalid_app_mention",
    message: "Use a supported @App mention at the start of your request.",
  }
}

function mcpApp(
  id: Exclude<RuntimeAppId, "github">,
  name: string,
  vendor: OfficialMcpVendor,
  aliases: readonly string[] = [],
  compatibleToolNames: readonly string[] | null = null,
): RuntimeMcpAppDefinition {
  return {
    id,
    name,
    canonicalMention: `@${name}`,
    aliases,
    surfaces: MCP_SURFACES,
    kind: "mcp",
    executable: true,
    vendor,
    compatibleToolNames,
  }
}

function initializeRegistry(): void {
  for (const app of RUNTIME_APPS) {
    if (APP_BY_ID.has(app.id)) throw new Error(`duplicate runtime app id: ${app.id}`)
    APP_BY_ID.set(app.id, app)

    for (const mention of [app.canonicalMention, ...app.aliases]) {
      const token = mention.startsWith("@") ? mention.slice(1) : ""
      if (!SAFE_MENTION_TOKEN_RE.test(token)) throw new Error(`invalid runtime app alias: ${mention}`)
      const normalized = token.toLowerCase()
      if (APP_BY_ALIAS.has(normalized)) throw new Error(`duplicate runtime app alias: ${mention}`)
      APP_BY_ALIAS.set(normalized, app)
    }

    if (app.kind === "mcp" && app.compatibleToolNames !== null) {
      const uniqueTools = new Set(app.compatibleToolNames)
      if (uniqueTools.size !== app.compatibleToolNames.length) {
        throw new Error(`duplicate runtime app tool: ${app.id}`)
      }
    }
  }

  const mcpApps = RUNTIME_APPS.filter((app): app is RuntimeMcpAppDefinition => app.kind === "mcp")
  for (let leftIndex = 0; leftIndex < mcpApps.length; leftIndex++) {
    const left = mcpApps[leftIndex]
    if (!left) continue
    for (const right of mcpApps.slice(leftIndex + 1)) {
      if (left.vendor !== right.vendor) continue
      if (left.compatibleToolNames === null || right.compatibleToolNames === null) {
        throw new Error(`shared runtime vendor requires explicit tool subsets: ${left.vendor}`)
      }
      const leftTools = new Set(left.compatibleToolNames)
      if (right.compatibleToolNames.some((name) => leftTools.has(name))) {
        throw new Error(`overlapping runtime app tools: ${left.id}/${right.id}`)
      }
    }
  }
}

function isMentionSeparator(character: string): boolean {
  return character === ":" || character === "," || /[\t\n\v\f\r ]/.test(character)
}
