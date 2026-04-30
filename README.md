# `openclaw-worker`

OpenClaw issue-triage bot, ported from the local NSSM daemon to a Cloudflare Worker.

When a Linear issue is created in the Arc and Anchor workspace, this Worker:

1. Receives the webhook from Linear (HMAC-verified).
2. Fetches the issue body via the Linear GraphQL API.
3. Calls Ollama Turbo (`glm-5.1:cloud` by default) for a structured triage verdict.
4. Posts a Greptile-style comment on the issue (with `<!-- openclaw:issue-triage -->` marker for idempotent re-runs).
5. Sets `priority`, `estimate`, and adds `labels` on the issue.

It is a one-file fetch handler with three routes (`/`, `/linear/webhook`, `/linear/manual`). No daemon, no polling, no key on disk.

## Why a Worker

Replaces `tools/openclaw/triage-issue.mjs` and `triage-mention.mjs` from the rema-portal Node daemon, which ran under NSSM on a Windows box and managed a GitHub App private key, a polling state file, an auto-update loop, and a multi-repo project-board write surface. That code path had four security holes patched in the last week. The Worker:

- Has no persistent process — Cloudflare invokes it per webhook.
- Stores no key on disk — secrets live in Cloudflare's secret store.
- Replaces the GitHub Projects v2 GraphQL surface with Linear's per-team-scoped API. The cross-repo write vulnerability class disappears entirely.
- Replaces the polling state file with Cloudflare KV.
- Replaces the auto-update + restart logic with `wrangler deploy` from CI.

PR-side scripts (`triage-ci`, `triage-cr`, `triage-pr-overview`) stay on the Windows box for now — they need PR diffs and the codebase semantic index. Migration of those is tracked separately.

## Architecture

```
Linear (issue.created webhook)
    │ HMAC-signed POST
    ▼
Cloudflare Worker (this repo)
    │ ┌─ HMAC verify (LINEAR_WEBHOOK_SECRET)
    │ ├─ KV dedupe check (OPENCLAW_STATE)
    │ ├─ Linear GraphQL: fetch issue body + labels
    │ ├─ Ollama Turbo: glm-5.1:cloud → JSON verdict
    │ ├─ Linear GraphQL: post/edit comment with marker
    │ └─ Linear GraphQL: set priority, estimate, labels
    ▼
Linear issue updated
```

## Setup

### 1. Cloudflare account

Create a Cloudflare account (free tier) at <https://dash.cloudflare.com>. The Worker runs under the **Workers Unbound** plan ($5/mo base + $0.50/M requests) — Bundled tier won't work because Ollama Turbo calls take 30-90 seconds, exceeding the 10ms CPU budget.

### 2. Install dependencies

```bash
npm install
```

### 3. Authenticate `wrangler`

```bash
npx wrangler login
```

This opens a browser to authorize the Cloudflare API token. The token lives at `~/.wrangler/config/default.toml`.

### 4. Create the KV namespace

```bash
npx wrangler kv:namespace create OPENCLAW_STATE
```

Copy the returned `id` into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 5. Set the three secrets

```bash
npx wrangler secret put LINEAR_API_KEY
# Paste your Linear personal API key (Settings → API → Personal API keys)
# OR an OAuth client_credentials token if using the OAuth app pattern

npx wrangler secret put LINEAR_WEBHOOK_SECRET
# Paste the signing secret from your Linear OAuth app's webhook config

npx wrangler secret put OLLAMA_API_KEY
# Paste your Ollama Turbo API key (https://ollama.com/settings/keys)
```

Optional:

```bash
npx wrangler secret put OPENCLAW_MODEL          # defaults to glm-5.1:cloud
npx wrangler secret put OPENCLAW_TEAM_KEY       # e.g. "ARC" — scope to one team
```

### 6. Deploy

```bash
npm run deploy
```

Wrangler prints the Worker URL — something like `https://openclaw-worker.<your-account>.workers.dev`. Copy it.

### 7. Wire the Linear webhook

In Linear → **Settings → API → Webhooks** (or in your OAuth app's webhook config):

- **URL**: `https://openclaw-worker.<your-account>.workers.dev/linear/webhook`
- **Events**: `Issue create` (and `Issue update` if you want re-triage on body edits — disabled by default in the Worker; toggle in `src/index.ts`)
- **Resource types**: `Issue`
- **Signing secret**: copy this and store it as `LINEAR_WEBHOOK_SECRET` (step 5 above)

Save. Linear sends a test payload — the Worker should return 200 and log a "skipped" line (test payloads aren't real `Issue.create` events).

### 8. Smoke test

Create a new issue in Linear. Within ~30-90 seconds, OpenClaw posts a triage comment with priority, estimate, and label suggestions.

If you want to manually re-trigger a triage on an existing issue:

```bash
curl -X POST "https://openclaw-worker.<your-account>.workers.dev/linear/manual" \
  -H "authorization: Bearer $LINEAR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"issueId": "ARC-42"}'
```

## CI / auto-deploy

The `.github/workflows/deploy.yml` Action deploys on every push to `main`. Add two repo secrets:

- `CLOUDFLARE_API_TOKEN` — generate at <https://dash.cloudflare.com/profile/api-tokens> with the **"Edit Cloudflare Workers"** template.
- `CLOUDFLARE_ACCOUNT_ID` — find in the Workers dashboard sidebar.

Push to main → Worker redeploys automatically.

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in your dev secrets
npm run dev                       # starts wrangler dev on http://localhost:8787
```

Use `ngrok` or `cloudflared tunnel` to expose `localhost:8787` to Linear if you want to test webhooks locally.

## Files

```
openclaw-worker/
├── README.md                              # this file
├── package.json
├── tsconfig.json
├── wrangler.toml                          # Cloudflare config + KV binding + secrets list
├── .dev.vars.example                      # local secret template (.dev.vars is gitignored)
├── .github/workflows/deploy.yml           # auto-deploy on push to main
├── prompts/
│   └── issue-triage.md                    # OpenClaw v5 system prompt (verbatim from rema-portal)
└── src/
    ├── index.ts                           # main fetch handler — routing + auth
    └── lib/
        ├── linear.ts                      # Linear GraphQL client (issue + comment + update)
        ├── ollama.ts                      # Ollama Turbo client (single generate call)
        ├── triage.ts                      # prompt build + verdict parse + comment format
        ├── webhook-verify.ts              # HMAC-SHA256 signature verify
        └── dedupe.ts                      # KV-backed marker lookup / set
```

## Roadmap

- **PR-side scripts**: port `triage-ci`, `triage-cr`, `triage-pr-overview` once the Linear-issue path is validated. Add a `/github/webhook` route, GitHub App JWT signing in-Worker, and a Vectorize binding for the codebase index.
- **Cycle awareness**: when triaging an issue mid-cycle, suggest whether it fits the current cycle or should be deferred to the next based on team capacity.
- **Linked PR detection**: when a PR mentions an issue, post a "PR ready for review" comment on the issue side.

## Security

- HMAC verification on every webhook delivery — invalid signatures return 401.
- All secrets live in Cloudflare's secret store, encrypted at rest, never logged.
- The Worker has no filesystem; the GitHub App private key path that historically lived on the Windows box is gone.
- Linear API token is workspace-scoped; the Worker can't write outside the Arc and Anchor workspace.
- Manual trigger route requires a Bearer token equal to `LINEAR_API_KEY`. Random clients can't fire triages.

## Troubleshooting

**Webhook returns 401**: signing secret mismatch. Re-check that `LINEAR_WEBHOOK_SECRET` (step 5) matches the secret shown in Linear's webhook config (step 7).

**Webhook returns 200 but no comment appears**: check Worker logs (`npx wrangler tail`). Common causes — Ollama Turbo timeout (>5 min), KV namespace ID still set to `REPLACE_WITH_KV_NAMESPACE_ID`, or model name typo.

**Triage comment is wrong / hallucinated**: the model output didn't parse cleanly and got fabricated content. Check the raw response in logs, then iterate on the prompt at `prompts/issue-triage.md`.

**Same comment posted twice**: KV is empty (cold cache) and the comment-body marker scan also missed the existing one. Check that the marker `<!-- openclaw:issue-triage -->` appears in your existing triage comments.
