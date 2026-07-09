// sig-mcp-slack-static-oauth — a custom MCP OAuth client provider that supplies
// Sigilix's PRE-REGISTERED confidential client for Slack's hosted MCP server
// (https://mcp.slack.com/mcp) and defers to the SDK's default Dynamic Client
// Registration (DCR) flow for every other server.
//
// Why this exists: Slack's hosted MCP server requires a pre-registered
// confidential OAuth client (client_id + client_secret) and does NOT support
// DCR (RFC 7591). The `@modelcontextprotocol/sdk` handles this natively — its
// `auth()` skips registration entirely when `clientInformation()` returns
// credentials, and exchanges the code with the secret. But the `agents` SDK's
// default `DurableObjectOAuthClientProvider` is DCR-only: its
// `clientInformation()` reads storage, so with no prior DCR it returns
// undefined and the SDK tries to register — which Slack rejects.
//
// This subclass overrides a single hook — `clientInformation()` — because that
// is where every relevant SDK decision is actually made (verified against
// @modelcontextprotocol/sdk 1.29.0 `client/auth.js`):
//   1. `auth()` skips DCR (and `saveClientInformation`) whenever
//      `clientInformation()` is truthy. So for Slack we return the static
//      client_id/client_secret and the SDK never attempts registration.
//   2. Because `saveClientInformation` is skipped, the base's internal
//      `clientId` is never populated — and the base's token/verifier/state key
//      builders all dereference it and would THROW. So we set `this.clientId`
//      here. It is then persisted (as the server row's `client_id`) and
//      restored, exactly as a DCR client's would be.
//   3. The token-endpoint auth method is selected from *clientInformation*
//      (`selectClientAuthMethod`), NOT from `clientMetadata` (which only ships
//      to the server during DCR — skipped here). So `client_secret_post` is
//      carried on the returned object, where the SDK actually honors it.
// For every non-Slack server, and when the Slack credentials aren't configured,
// we defer entirely to the base (DCR) behavior. Token/verifier/state
// persistence and endpoint discovery are left to the base class.

import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider"
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"

/** Host of Slack's hosted MCP server. Static-client OAuth applies only here. */
const SLACK_MCP_HOST = "mcp.slack.com"

/** Human-facing DCR (Dynamic Client Registration, RFC 7591) client metadata a
 *  provider shows on its OAuth consent screen when the portal connects an MCP
 *  server (e.g. Linear). The base `DurableObjectOAuthClientProvider` sends only
 *  a bare `client_name` (the storage-key namespace, "sigilix-portal-mcp"),
 *  derives `client_uri` from the callback origin, and never sends a `logo_uri`
 *  at all — so providers rendered a placeholder logo. We override all three to
 *  the official Sigilix brand: the display name, the marketing site, and the
 *  canonical square Sigilix mark served on the primary brand domain. */
const MCP_CLIENT_DISPLAY_NAME = "Sigilix"
const MCP_CLIENT_URI = "https://sigilix.ai"
const MCP_CLIENT_LOGO_URI = "https://sigilix.ai/Sigilix.png"

/** The `agents` SDK's server table — the base provider knows only its
 *  `serverId`, so we resolve this connection's URL from the same DO SQLite the
 *  MCPClientManager writes to (`registerServer` / restore both persist here). */
const SERVERS_TABLE = "cf_agents_mcp_servers"

/** The base's own `saveClientInformation` parameter — the SDK's
 *  `OAuthClientInformationFull` — reused so we can carry
 *  `token_endpoint_auth_method` without importing the transitive SDK types. */
type ClientInformationFull = Parameters<DurableObjectOAuthClientProvider["saveClientInformation"]>[0]

export class SlackAwareOAuthProvider extends DurableObjectOAuthClientProvider {
  constructor(
    storage: DurableObjectStorage,
    clientName: string,
    baseRedirectUrl: string,
    private readonly slackClientId: string | undefined,
    private readonly slackClientSecret: string | undefined,
  ) {
    super(storage, clientName, baseRedirectUrl)
  }

  /** Brand the DCR consent screen for every server that registers via DCR. The
   *  base getter carries only the storage-key `client_name` and no `logo_uri`;
   *  we extend it with the official Sigilix name, site, and square logo. (Slack
   *  uses the static confidential client above and never runs DCR, so this
   *  metadata is only ever sent for DCR servers — exactly where it's wanted.) */
  override get clientMetadata(): OAuthClientMetadata {
    return {
      ...super.clientMetadata,
      client_name: MCP_CLIENT_DISPLAY_NAME,
      client_uri: MCP_CLIENT_URI,
      logo_uri: MCP_CLIENT_LOGO_URI,
    }
  }

  /** True only when this connection targets Slack's hosted MCP host AND both
   *  static credentials are configured — the sole case we diverge from DCR. */
  private useSlackStaticClient(): boolean {
    if (!this.slackClientId || !this.slackClientSecret) return false
    return this.resolveServerHost() === SLACK_MCP_HOST
  }

  /** Resolve this connection's server hostname from the DO SQLite by serverId.
   *  Returns null if the id/row/URL isn't available yet (brand-new DO with no
   *  registered server, or serverId unset) — callers then fall back to super. */
  private resolveServerHost(): string | null {
    let serverId: string
    try {
      serverId = this.serverId
    } catch {
      return null
    }
    try {
      const rows = this.storage.sql
        .exec<{ server_url: string }>(`SELECT server_url FROM ${SERVERS_TABLE} WHERE id = ?`, serverId)
        .toArray()
      const serverUrl = rows[0]?.server_url
      if (!serverUrl) return null
      return new URL(serverUrl).hostname
    } catch {
      return null
    }
  }

  /** Return the static Slack client so the SDK skips DCR; also set `clientId`
   *  (the SDK won't call `saveClientInformation` on this path) and carry the
   *  confidential token-auth method. Non-Slack defers to super (DCR) unchanged. */
  override async clientInformation(): ReturnType<DurableObjectOAuthClientProvider["clientInformation"]> {
    if (this.useSlackStaticClient()) {
      const clientId = this.slackClientId as string
      // Populate the base's internal clientId — the SDK skips
      // saveClientInformation when this method is truthy, and the base's
      // key builders throw without it.
      this.clientId = clientId
      const info: ClientInformationFull = {
        client_id: clientId,
        client_secret: this.slackClientSecret,
        redirect_uris: [this.redirectUrl],
        token_endpoint_auth_method: "client_secret_post",
      }
      return info
    }
    return super.clientInformation()
  }
}
