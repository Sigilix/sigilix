# `openclaw-worker`

**Arc** — Linear-side issue triage + GitHub-side PR review, running as a single Cloudflare Worker. Ported from the local NSSM daemon (`rema-portal/tools/openclaw/`).

The repository, infrastructure (KV / Vectorize / wrangler config), env vars, and dedupe markers all keep the legacy `openclaw` name for stability and zero-config impact. The user-facing bot identity (display names on Linear and GitHub, comment headings, footers, mention triggers) is **Arc**.

**Linear side** — issue triage and @-mention replies on Linear webhooks.
**GitHub side** — PR overview, CI failure triage, and proactive primary review on GitHub App webhooks.

## What it does

**Linear: Issue triage** (`Issue.create`)
1. Verifies HMAC, then fetches the issue body via Linear GraphQL.
2. Embeds the issue body (Workers AI, `@cf/baai/bge-base-en-v1.5`, 768 dims) and queries Vectorize for top-K relevant code chunks.
3. Calls Ollama Turbo (`glm-5.1:cloud` default) with issue + chunks.
4. Rewrites the issue description into `## Context / ## Acceptance criteria / ## Done when` (preserves media URLs).
5. Posts a triage comment, sets priority + estimate + labels (auto-creates missing labels).

**Linear: Mention reply** (`Comment.create` with `@arc` — also matches legacy `@openclaw`)
1. Pre-filters on the comment body, then fetches the comment + parent issue + recent thread.
2. Runs the same Vectorize retrieval against the asker's question.
3. Calls Ollama Turbo with the mention-reply prompt; posts the answer back.
4. Skips self-mentions; dedupes via KV.

**GitHub: PR overview** (`pull_request.opened/synchronize/reopened/ready_for_review`)
1. Fetches PR title + body + diff + recent commits.
2. Asks the model for a structured overview: 1–5 confidence, per-file priority scores, bullets to scrutinize.
3. Posts (or PATCHes in place) a single sticky top-level comment with the dedupe marker `<!-- openclaw:pr-overview -->`.

**GitHub: CI failure triage** (`workflow_run.completed` with `conclusion=failure`)
1. Lists failed jobs on the run, fetches each job's plain-text log, concatenates them.
2. Pulls PR diff + file contents the failure log mentions (Contents API at the PR head SHA) + Vectorize chunks.
3. Asks the model for a Greptile-shaped diagnosis (root cause / likely fix / failure excerpt / confidence).
4. Posts only when confidence is `high` or `medium`; updates in place via the `<!-- openclaw:ci-triage -->` marker.

**GitHub: Proactive primary review** (`pull_request.opened/synchronize/reopened/ready_for_review`)
1. Fetches PR diff and reviews it in isolation — no awareness of other reviewers.
2. Each finding gets a 1–5 score and a category (`logic`, `security`, `performance`, `error-handling`, `testing`, `complexity`, `style`, `syntax`, `docs`). The category leads the inline comment as `**category:**` (greptile-style).
3. Submits ONE review via `POST /pulls/{n}/reviews` with all findings as inline comments. Approval state is derived from the max finding score:
   - max 5 → `REQUEST_CHANGES`
   - max 3–4 → `COMMENT`
   - max 1–2 (or no findings) → `APPROVE`
4. KV-deduped on `(prNumber, headSha)` so re-firing webhooks don't double-review the same code.
5. Re-runs on every push (`synchronize`) so the bot keeps verifying after fix commits and can flip to `APPROVE`. A stale-head guard in the consumer skips jobs whose queued SHA no longer matches the PR head, preventing out-of-order queue processing from posting reviews against superseded commits.

**GitHub: @-mention reply** (`issue_comment.created` and `pull_request_review_comment.created` with `@arc`)
1. Filters on the comment body before queueing — most PR comments don't @ Arc.
2. Fetches PR + diff + the source comment + surrounding thread (issue comment thread for top-level, the inline review-comment chain for inline mentions).
3. Runs Vectorize retrieval against the asker's question, scoped to the repo's namespace.
4. Calls Ollama with the greptile-style verification prompt; the model picks a verdict tag per concern (`✅ FIXED`, `↩️ WITHDRAWN`, `⚠️ STANDS`, `🔍 Analysis`, `💬 Answer`, etc.) and writes the prose itself.
5. Posts on the right surface: top-level → new issue comment; inline → reply threaded under the root review comment.
6. Skips self-authored comments via `isArcGithubLogin()`. Other bots (CR, etc.) CAN mention Arc and get a response.

Routes: `/` (liveness), `/linear/webhook`, `/linear/manual`, `/github/webhook`. No daemon, no polling, no key on disk.

## Why a Worker

Replaces `tools/openclaw/triage-issue.mjs` and `triage-mention.mjs` from the rema-portal Node daemon, which ran under NSSM on a Windows box and managed a GitHub App private key, a polling state file, an auto-update loop, and a multi-repo project-board write surface. That code path had four security holes patched in the last week. The Worker:

- Has no persistent process — Cloudflare invokes it per webhook.
- Stores no key on disk — secrets live in Cloudflare's secret store.
- Replaces the GitHub Projects v2 GraphQL surface with Linear's per-team-scoped API. The cross-repo write vulnerability class disappears entirely.
- Replaces the polling state file with Cloudflare KV.
- Replaces the auto-update + restart logic with `wrangler deploy` from CI.

The three ported PR-side scripts (`triage-ci`, `triage-cr`, `triage-pr-overview`) plus one new **proactive primary reviewer** now run in the Worker via a GitHub App. The Windows daemon is fully decommissioned.

## Architecture

```text
Linear (Issue.create / Comment.create)        GitHub (PR / workflow_run / review / issue_comment / review_comment)
    │ HMAC-signed POST                            │ HMAC-signed POST (X-Hub-Signature-256)
    ▼                                             ▼
              Cloudflare Worker — fetch() handler
    │ ┌─ HMAC verify per provider
    │ ├─ Route on (path, headers, payload)
    │ └─ Enqueue typed JobMessage → return 202 in ~50ms
    ▼
              Cloudflare Queue (openclaw-jobs)
    │
    ▼
              Cloudflare Worker — queue() handler (15-min budget)
    │ ┌─ KV dedupe (OPENCLAW_STATE)
    │ ├─ Linear OAuth or GitHub App installation token (KV-cached)
    │ ├─ Vectorize retrieval (Workers AI + OPENCLAW_CODE_INDEX)
    │ ├─ Ollama Turbo: glm-5.1:cloud / kimi-k2.6:cloud → JSON verdict
    │ └─ Post comment / submit review back to provider
    ▼
Linear issue / GitHub PR updated
```

The queue indirection is mandatory: Cloudflare's `ctx.waitUntil()` is hard-capped at 30 seconds and Ollama Turbo calls routinely take 30-90s. Queue consumers get up to 15 minutes per invocation, plenty for any model. Webhooks return 202 in ~50ms — well under GitHub's 10s webhook timeout — and the actual work runs decoupled.

GitHub auth uses a GitHub App: the Worker signs RS256 JWTs with the App's private key (Web Crypto, not node:crypto), exchanges them for per-installation access tokens via `POST /app/installations/{id}/access_tokens`, and caches the tokens in KV. Installation IDs come from the `installation.id` field on each inbound webhook, so a single Worker fans out across every repo where the App is installed.

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

### 4b. Create the Cloudflare Queue

```bash
npx wrangler queues create openclaw-jobs
```

Long-running work (Ollama Turbo calls, 30-90s typical) runs in a queue consumer instead of `ctx.waitUntil()`. Cloudflare's `waitUntil` is hard-capped at 30 seconds on every plan and isn't configurable; queue consumers get up to 15 minutes per invocation. The webhook handlers `.send()` a typed `JobMessage` and return 200 in ~50ms; the consumer picks the message up and runs the actual triage. Producer + consumer bindings are already declared in `wrangler.toml` — this command just creates the queue itself.

### 4c. Create the Vectorize index

```bash
npx wrangler vectorize create openclaw-code-index --dimensions=768 --metric=cosine
```

This creates the index that holds embedded code chunks. The Worker queries it at triage / mention-reply time.

### 4d. Index your repos

For each repo you want Arc to know about, run the local indexer:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>
export CLOUDFLARE_API_TOKEN=<token with Workers AI Read + Vectorize Write>

node scripts/index-repo.mjs ../rubberfit
node scripts/index-repo.mjs ../Rubberfit-Desktop --namespace=rubberfit-desktop
```

The default namespace is the repo directory name lowercased. Linear team keys map to namespaces via `OPENCLAW_TEAM_REPO_MAP` (see step 5).

The first run takes several minutes for a 10k-chunk repo. Subsequent runs are full re-embeds — incremental indexing is a future enhancement.

### 4e. Auto-reindex on every push (recommended)

To keep the index fresh without running the CLI manually, drop a thin workflow file into each tracked repo. It calls a **reusable workflow** in this repo (`.github/workflows/codebase-index.yml`) so the indexer logic stays in one place.

**Step 1 — set org-level secrets** (one-time, applies to every repo):

Go to https://github.com/organizations/Arc-and-Anchor/settings/secrets/actions and add:
- `CLOUDFLARE_ACCOUNT_ID` — your CF account ID
- `CLOUDFLARE_AI_TOKEN` — token with `Account → Workers AI → Read` and `Account → Vectorize → Edit`

Set them with **Repository access → All repositories** (or pick the specific repos you want to index).

**Step 2 — drop the caller workflow into each tracked repo**, at `.github/workflows/openclaw-index.yml`. Copy from `examples/openclaw-index.yml` in this repo:

```yaml
name: OpenClaw codebase index
on:
  push:
    branches: [dev, main]
  workflow_dispatch:

jobs:
  index:
    uses: Arc-and-Anchor/openclaw-worker/.github/workflows/codebase-index.yml@main
    secrets:
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_AI_TOKEN }}
```

Triggers on push to `dev` OR `main`. dev is the active development branch; main is the customer-facing release. Both reindex into the same namespace (`<repo-name>` lowercased) — whichever branch changed last wins, matching what the team is actually working on at any given moment. The reusable workflow checks out the calling repo at the triggering ref, runs the indexer, and upserts vectors into Vectorize.

### 5. Set the secrets

**Linear:**

```bash
npx wrangler secret put LINEAR_API_KEY
# Paste your Linear personal API key (Settings → API → Personal API keys)

npx wrangler secret put LINEAR_WEBHOOK_SECRET
# Paste the signing secret from your Linear OAuth app's webhook config

npx wrangler secret put OLLAMA_API_KEY
# Paste your Ollama Turbo API key (https://ollama.com/settings/keys)
```

**GitHub App** (required for the `/github/webhook` route — without these the route returns 503):

```bash
npx wrangler secret put GITHUB_APP_ID
# Numeric App ID from
# https://github.com/organizations/Arc-and-Anchor/settings/apps/<your-app>

npx wrangler secret put GITHUB_PRIVATE_KEY
# PEM-encoded RSA private key from "Generate a private key" on the App
# settings page. PKCS#1 (BEGIN RSA PRIVATE KEY) and PKCS#8 (BEGIN PRIVATE KEY)
# both work — paste the whole multi-line PEM, including BEGIN/END markers.

npx wrangler secret put GITHUB_WEBHOOK_SECRET
# HMAC secret from the GitHub App's webhook config
```

**Optional:**

```bash
npx wrangler secret put OPENCLAW_MODEL              # defaults to glm-5.1:cloud
npx wrangler secret put OPENCLAW_TEAM_KEY           # e.g. "ARC" — scope to one team
npx wrangler secret put OPENCLAW_MENTION_TRIGGERS   # CSV of @-handles, defaults to "arc,arc[bot],Arc[bot],openclaw,openclaw[bot],OpenClaw[bot]" (legacy aliases included)
npx wrangler secret put OPENCLAW_TEAM_REPO_MAP      # JSON: {"ARC":"rubberfit","RFD":"rubberfit-desktop"}
npx wrangler secret put LINEAR_OAUTH_CLIENT_ID      # OAuth app — comments post as the app actor
npx wrangler secret put LINEAR_OAUTH_CLIENT_SECRET  # paired with the client_id above
```

`OPENCLAW_TEAM_REPO_MAP` controls which Vectorize namespace gets queried for triage / mention-reply on each Linear team's issues. Without it, the team key (lowercased) is used as the namespace — so a Linear team with key `ARC` queries the `arc` namespace.

### 5b. Create + install the GitHub App

Go to <https://github.com/organizations/Arc-and-Anchor/settings/apps> → **New GitHub App**.

**Required permissions** (Repository):
- **Actions**: Read (CI run jobs + logs)
- **Contents**: Read (file contents at a given ref)
- **Issues**: Write (top-level PR comments)
- **Pull requests**: Read & write (PR diff, review comments, submit review)
- **Metadata**: Read (default)

**Required webhook events:**
- `Pull request` (opened, synchronize, ready_for_review, reopened)
- `Workflow run` (CI failure triage)
- `Issue comment` (top-level PR conversation @-mentions)
- `Pull request review comment` (inline review-comment @-mentions)

Set the webhook URL to `https://openclaw-worker.<your-account>.workers.dev/github/webhook` and copy the webhook secret to `GITHUB_WEBHOOK_SECRET` (step 5 above).

Generate a private key from the App settings page; paste the whole PEM into `GITHUB_PRIVATE_KEY`.

Install the App on the repos you want Arc to review.

### 6. Deploy

```bash
npm run deploy
```

Wrangler prints the Worker URL — something like `https://openclaw-worker.<your-account>.workers.dev`. Copy it.

### 7. Wire the Linear webhook

In Linear → **Settings → API → Webhooks** (or in your OAuth app's webhook config):

- **URL**: `https://openclaw-worker.<your-account>.workers.dev/linear/webhook`
- **Resource types**: check **Issue** AND **Comment** — Issue triggers triage, Comment triggers the @-mention reply path
- **Signing secret**: copy this and store it as `LINEAR_WEBHOOK_SECRET` (step 5 above)

Save. Linear sends a test payload — the Worker should return 200 and log a "skipped" line (test payloads aren't real `Issue.create` events).

### 8. Smoke test

Create a new issue in Linear. Within ~30-90 seconds, Arc posts a triage comment with priority, estimate, and label suggestions.

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
├── wrangler.toml                          # Cloudflare config + KV/Vectorize bindings + secrets list
├── .dev.vars.example                      # local secret template (.dev.vars is gitignored)
├── .github/workflows/deploy.yml           # auto-deploy on push to main
├── .github/workflows/ci.yml               # PR typecheck (lint job for branch protection)
├── .github/workflows/codebase-index.yml   # reusable workflow — auto-reindex on push to dev/main
├── examples/openclaw-index.yml            # template caller for each tracked repo
├── scripts/index-repo.mjs                 # CLI indexer (chunk + embed + upsert to Vectorize)
└── src/
    ├── index.ts                           # main fetch handler — routing + HMAC verify
    ├── prompts/
    │   ├── issue-triage.ts                # Linear issue triage prompt
    │   ├── mention-reply.ts               # Linear @-mention reply prompt
    │   ├── github-mention.ts              # GitHub PR @-mention reply prompt (greptile-style verification)
    │   ├── pr-overview.ts                 # GitHub PR top-level overview
    │   ├── ci-triage.ts                   # GitHub CI failure diagnosis
    │   └── pr-review.ts                   # Proactive primary reviewer (greptile-style)
    └── lib/
        ├── linear.ts                      # Linear GraphQL client
        ├── linear-oauth.ts                # Linear OAuth client_credentials (app-actor token)
        ├── webhook-verify.ts              # Linear HMAC-SHA256 verify
        ├── github.ts                      # GitHub REST + GraphQL client (Worker-friendly)
        ├── github-app.ts                  # RS256 JWT signer + installation token cache
        ├── github-webhook-verify.ts       # GitHub HMAC-SHA256 verify (sha256= prefix)
        ├── ollama.ts                      # Ollama Turbo client
        ├── embeddings.ts                  # Workers AI BGE base v1.5 wrapper
        ├── retrieval.ts                   # Vectorize query + chunk formatting
        ├── mention.ts                     # @-mention detection helpers
        ├── triage.ts                      # Linear issue-triage pipeline
        ├── mention-reply.ts               # Linear mention-reply pipeline
        ├── triage-pr-overview.ts          # GitHub PR overview pipeline
        ├── triage-ci.ts                   # GitHub CI failure pipeline
        ├── triage-pr-review.ts            # GitHub proactive primary review pipeline
        ├── github-mention.ts              # GitHub PR @-mention reply pipeline
        └── dedupe.ts                      # KV-backed marker lookup / set
```

## Roadmap

- **Cycle awareness**: when triaging an issue mid-cycle, suggest whether it fits the current cycle or should be deferred to the next based on team capacity.
- **Linked PR detection**: when a PR mentions an issue, post a "PR ready for review" comment on the issue side.
- **Incremental indexing**: re-embed only changed files on each push (current scripts/index-repo.mjs re-embeds the whole repo).

## Security

- HMAC verification on every webhook delivery — invalid signatures return 401. Linear: raw hex digest in `linear-signature`. GitHub: `sha256=<hex>` in `X-Hub-Signature-256`.
- All secrets live in Cloudflare's secret store, encrypted at rest, never logged.
- The Worker has no filesystem; the GitHub App private key path that historically lived on the Windows box is gone.
- Linear API token is workspace-scoped; the Worker can't write outside the Arc and Anchor workspace.
- GitHub App installation tokens are scoped to whatever the App is installed on. Tokens last ~1 hour and are KV-cached per-installation; the App's master private key is the only sensitive credential.
- Manual trigger route requires a Bearer token equal to `LINEAR_API_KEY`. Random clients can't fire triages.

## Troubleshooting

**Webhook returns 401**: signing secret mismatch. Re-check that `LINEAR_WEBHOOK_SECRET` (step 5) matches the secret shown in Linear's webhook config (step 7).

**Webhook returns 200 but no comment appears**: check Worker logs (`npx wrangler tail`). Common causes — Ollama Turbo timeout (>5 min), KV namespace ID still set to `REPLACE_WITH_KV_NAMESPACE_ID`, or model name typo.

**Triage comment is wrong / hallucinated**: the model output didn't parse cleanly and got fabricated content. Check the raw response in logs, then iterate on the prompt at `src/prompts/issue-triage.ts`.

**Same comment posted twice**: KV is empty (cold cache) and the comment-body marker scan also missed the existing one. Check that the marker `<!-- openclaw:issue-triage -->` appears in your existing triage comments.
