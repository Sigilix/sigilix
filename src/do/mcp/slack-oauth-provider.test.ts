// sig-mcp-slack-static-oauth — SlackAwareOAuthProvider tests.
//
// These exercise the REAL provider (a subclass of the agents SDK's real
// DurableObjectOAuthClientProvider) against a fake DO storage whose `sql.exec`
// mirrors the `cf_agents_mcp_servers` row the MCPClientManager persists. The
// point is the divergence logic: for Slack's hosted MCP host we must return the
// static confidential client (so the SDK skips DCR), advertise
// client_secret_post ON clientInformation (where the SDK's
// selectClientAuthMethod reads it), and set the base's clientId (the SDK skips
// saveClientInformation on this path, and the base's key builders throw without
// it). For every other host — or when the creds aren't configured — behavior
// must be byte-for-byte the base (DCR) behavior.

import { describe, it, expect } from "vitest"
import { SlackAwareOAuthProvider } from "./slack-oauth-provider"

const CALLBACK = "https://api.sigilix.ai/mcp/oauth/callback"
const CLIENT_NAME = "sigilix-portal-mcp"
const SLACK_ID = "10539390863863.11471637305556"
const SLACK_SECRET = "s3cr3t-value"

/** Fake DO storage: `sql.exec` (server_url lookup by id) plus the KV
 *  get/put/list/delete the base touches (e.g. saveCodeVerifier). */
function makeStorage(serverUrlById: Record<string, string>): DurableObjectStorage {
  const kv = new Map<string, unknown>()
  return {
    sql: {
      exec(_query: string, ...bindings: unknown[]) {
        const id = String(bindings[0])
        const url = serverUrlById[id]
        return { toArray: () => (url ? [{ server_url: url }] : []) }
      },
    },
    async get(k: string) {
      return kv.get(k)
    },
    async put(k: string, v: unknown) {
      kv.set(k, v)
    },
    async delete(k: string) {
      return kv.delete(k)
    },
    async list() {
      return new Map()
    },
  } as unknown as DurableObjectStorage
}

function makeProvider(opts: {
  serverUrl?: string
  slackId?: string | undefined
  slackSecret?: string | undefined
  serverId?: string | null
}) {
  const serverId = opts.serverId ?? "srv-1"
  const storage = makeStorage(opts.serverUrl ? { [serverId]: opts.serverUrl } : {})
  const provider = new SlackAwareOAuthProvider(
    storage,
    CLIENT_NAME,
    CALLBACK,
    "slackId" in opts ? opts.slackId : SLACK_ID,
    "slackSecret" in opts ? opts.slackSecret : SLACK_SECRET,
  )
  if (opts.serverId !== null) provider.serverId = serverId
  return provider
}

describe("SlackAwareOAuthProvider — Slack hosted MCP host", () => {
  it("clientInformation returns the static confidential client with client_secret_post (so the SDK skips DCR)", async () => {
    const p = makeProvider({ serverUrl: "https://mcp.slack.com/mcp" })
    expect(await p.clientInformation()).toEqual({
      client_id: SLACK_ID,
      client_secret: SLACK_SECRET,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "client_secret_post",
    })
  })

  it("clientInformation sets the base clientId (the SDK skips saveClientInformation on the static path)", async () => {
    const p = makeProvider({ serverUrl: "https://mcp.slack.com/mcp" })
    await p.clientInformation()
    expect(p.clientId).toBe(SLACK_ID)
  })

  it("regression guard: after clientInformation, the base's clientId-dependent flow works (saveCodeVerifier no longer throws)", async () => {
    const p = makeProvider({ serverUrl: "https://mcp.slack.com/mcp" })
    // Without the clientId side-effect this rejects with
    // "Trying to access clientId before it was set" — the P0 the reviewer caught.
    await p.clientInformation()
    await expect(p.saveCodeVerifier("verifier-abc-123")).resolves.toBeUndefined()
  })
})

describe("SlackAwareOAuthProvider — falls back to the base (DCR) behavior", () => {
  it("a non-Slack host defers to super: no static client, and no clientId side-effect", async () => {
    const p = makeProvider({ serverUrl: "https://example.com/mcp" })
    expect(await p.clientInformation()).toBeUndefined()
    expect(() => p.clientId).toThrow() // base leaves clientId unset for DCR
  })

  it("Slack host but the secret is unconfigured → super (no crash, unchanged)", async () => {
    const p = makeProvider({ serverUrl: "https://mcp.slack.com/mcp", slackSecret: undefined })
    expect(await p.clientInformation()).toBeUndefined()
  })

  it("Slack host but the id is unconfigured → super (no crash, unchanged)", async () => {
    const p = makeProvider({ serverUrl: "https://mcp.slack.com/mcp", slackId: undefined })
    expect(await p.clientInformation()).toBeUndefined()
  })

  it("serverId not yet set → resolves as non-Slack (super), never throws", async () => {
    const p = makeProvider({ serverUrl: "https://mcp.slack.com/mcp", serverId: null })
    expect(await p.clientInformation()).toBeUndefined()
  })

  it("no matching server row → resolves as non-Slack (super)", async () => {
    const p = makeProvider({}) // no server_url stored for the id
    expect(await p.clientInformation()).toBeUndefined()
  })
})

describe("SlackAwareOAuthProvider — DCR client metadata (consent-screen branding)", () => {
  it("registers with the Sigilix brand: display name, site, and the official square logo", () => {
    // This is the metadata the SDK POSTs to a provider's DCR endpoint (e.g.
    // Linear). Without the override the consent screen shows the bare
    // "sigilix-portal-mcp" name, a callback-derived client_uri, and a
    // placeholder logo — the bug this fix closes.
    const p = makeProvider({ serverUrl: "https://mcp.linear.app/mcp" })
    const meta = p.clientMetadata
    expect(meta.client_name).toBe("Sigilix")
    expect(meta.client_uri).toBe("https://sigilix.ai")
    expect(meta.logo_uri).toBe("https://sigilix.ai/Sigilix.png")
    // The callback (redirect) URL still flows through from the base metadata.
    expect(meta.redirect_uris).toContain(CALLBACK)
    // The override must SPREAD the base (not replace it): the required DCR
    // fields the SDK sets must survive, or registration would silently break.
    expect(meta.grant_types).toContain("authorization_code")
    expect(meta.token_endpoint_auth_method).toBe("none")
  })
})
