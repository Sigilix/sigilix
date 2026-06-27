# Sigilix on Slack — setup & go-live (SIG-196)

`@sigilix` in Slack: grounded codebase/PR Q&A, "make a Linear triage" from a thread, and shared
agent-memory — the same Sigilix identity and moat as the GitHub review bot, the Linear agent, and
the CLI. It runs on the **existing Sigilix Worker** as the `/slack/events` route and **ships dark**:
nothing happens until you register the app, set the secrets, and flip `SIGILIX_SLACK_MODE`.

It is **Sigilix on Slack** — the app name, icon, and voice are Sigilix's, not a generic Slack bot.

## Architecture (what's already in the Worker)

| Route | Purpose |
| --- | --- |
| `GET /slack/install` | Start OAuth — mints a CSRF `state` nonce (KV, 10-min TTL) and redirects to Slack's consent screen. Use this as the "Add to Slack" link. |
| `GET /slack/oauth/callback` | OAuth token exchange — verifies the `state` nonce (single-use), stores the workspace bot token in KV (`slack-install:<teamId>`), redirects to `/slack/installed`. |
| `POST /slack/events` | The event webhook — verifies the Slack signature (HMAC v0 + 5-min replay window), acks within 3 s, dedupes on `event_id`, and runs the agent in `ctx.waitUntil`. |

Grounding (`gatherAgentContext`/`runAgentLoop`), memory (SIG-522 Vectorize+KV), and Linear triage
(`triageIssue` + `LinearClient.createIssue`) are all reused **in-process**, bounded by a per-channel
**scope resolver**: a channel can only reach a repo that has an **exact** `owner/repo` entry in
`OPENCLAW_GITHUB_INSTALLATION_MAP` — a Slack channel can never broaden access beyond where the
GitHub App is installed.

## One-time setup (founder)

### 1. Register the Slack app

api.slack.com → **Create New App** → **From an app manifest** → pick the workspace →
paste `docs/slack/sigilix-app-manifest.json`. (If your Worker is not served at `app.sigilix.ai`,
edit the two URLs in the manifest first to your Worker's public host.)

The manifest requests the **minimal** bot scopes: `app_mentions:read`, `chat:write`,
`channels:history`, `groups:history`.

### 2. Set the secrets (`wrangler secret put …`)

```
wrangler secret put SLACK_SIGNING_SECRET     # Basic Information → App Credentials → Signing Secret
wrangler secret put SLACK_CLIENT_ID          # (for the OAuth install flow)
wrangler secret put SLACK_CLIENT_SECRET
# Single-workspace beta shortcut (skip OAuth): paste the bot token from OAuth & Permissions:
wrangler secret put SLACK_BOT_TOKEN          # xoxb-… ; getSlackBotToken falls back to this when no KV install record exists
```

### 3. Configure channel → repo / Linear scope

Set `SIGILIX_SLACK_SCOPE_MAP` (a `[vars]` entry or a secret) — JSON keyed by `"<teamId>:<channelId>"`:

```json
{
  "T0123ABC:C0456DEF": { "repos": ["sigilix/sigilix"], "linearTeam": "<LINEAR_TEAM_UUID>" }
}
```

- `repos` must be **exact** `owner/repo` strings that already exist in `OPENCLAW_GITHUB_INSTALLATION_MAP`
  (any repo without an exact install entry is dropped — scope-safety).
- `linearTeam` is the Linear **team UUID** (not the team key like `SIG`). Required for the
  "make a Linear triage" action; omit it and triage replies with a "not connected to Linear" notice.

### 4. Flip the mode

`SIGILIX_SLACK_MODE` is a `[vars]` entry, default `"off"`:

- `off` (default) — the route only answers Slack's `url_verification` handshake; **no agent work**.
- `shadow` — runs the full agent and **logs** what it *would* post, but posts nothing and records no
  usage. Use this to bake the path on a real channel before going live.
- `on` — posts replies, creates Linear issues, and meters usage.

### 5. Invite Sigilix

In a configured channel: `/invite @Sigilix`, then `@Sigilix <your question>` — or
`@Sigilix make a linear triage for this thread`.

## Caps

Per-`(workspace, user)` rolling-window cap (KV-backed, separate from the PR-review `usage_ledger`).
Defaults: **5 h window, 3 actions**. In `on` mode an over-cap mention gets a brief notice; in
`shadow` the would-deny is only logged. Tune at free-launch alongside the PR-review cap.

## Memory

Slack recalls from and captures to the **same SIG-522 agent-memory store** (Vectorize + KV), scoped
to `userId = "slack:<teamId>"`, `repoId = "<owner>/<repo>"` (the channel's primary repo). The
`repoId` namespace is the privacy boundary — two channels mapped to different repos cannot see each
other's memory. Thread text is **capped + secret-redacted** before it reaches the model or the store.

> Privacy note: persistent channel memory is enabled for the **gated beta** with redaction + scope
> isolation. Broad GA is gated on the SOC 2 work (SIG-188) — keep `SIGILIX_SLACK_MODE` limited to the
> beta workspace until then.

## Implementation note

The route is implemented natively on the Worker (request-signature verification in
`src/lib/slack/slack-verify.ts`, the Web API calls in `src/lib/slack/slack-api.ts`) rather than via a
third-party Slack framework, so it reuses the Worker's existing KV, grounding, memory, and Linear
plumbing directly and stays fully unit-testable.

## Not in v1

- **PR authoring from Slack** (`@Sigilix open a PR …`) — fast-follow (SIG-545 #2); heavier + needs
  tighter caps/governance.
- **Portal connection UI / full connection registry** (SIG-193 / SIG-197) — v1 uses the lightweight
  `SIGILIX_SLACK_SCOPE_MAP`; the portal "Add to Slack" + scope editor come later.
