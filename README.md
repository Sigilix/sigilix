<!-- post-transfer-canary -->
# Sigilix

> *The mark of merge-ready code.*

**Sigilix** — multi-agent AI code review for GitHub, plus Linear-side issue triage and @-mention replies, running as a single Cloudflare Worker.

Four specialists (logic, security, performance, tests) review every PR in parallel via Ollama Turbo cloud-routed models. A synthesizer dedupes their verdicts and posts one coherent review with inline anchored findings. This is the ensemble architecture other AI review tools (CodeRabbit, Greptile, Cursor Bugbot) don't run.

## Naming history

The product was previously named **Arc** (2026-04 to 2026-05), and before that **OpenClaw** (initial daemon, ported from `rema-portal/tools/openclaw/`).

Internal infrastructure — Cloudflare KV namespace, Vectorize index, Queue, env var prefixes — all keep the legacy `OPENCLAW_*` / `openclaw` names for stability and zero-config impact. Renaming those is deferred to a separate operational migration, since they're internal and not visible to API consumers.

User-facing surfaces (Cloudflare Worker name `sigilix`, GitHub App name `sigilix`, bot login `sigilix[bot]`, repository, deploy domain, comment headings, footers, HTTP `user-agent`) are all rebranded to **Sigilix**. SIG-83 / SIG-85 / SIG-36: dedupe markers in PR comment bodies write as `<!-- sigilix:* -->`; bilingual read-side matchers still recognize the legacy `<!-- openclaw:* -->` form so back-compat with pre-rebrand comments on still-open PRs survives. Drop the bilingual matchers once those PRs close. Mention triggers continue to accept legacy `@arc`, `@arc-copilot`, and `@openclaw`.

**Linear side** — issue triage and @-mention replies on Linear webhooks.
**GitHub side** — PR overview, CI failure triage, and proactive primary review on GitHub App webhooks.

## What it does

**Linear: Issue triage** (`Issue.create`)
1. Verifies HMAC, then fetches the issue body via Linear GraphQL.
2. Embeds the issue body (Workers AI, `@cf/baai/bge-base-en-v1.5`, 768 dims) and queries Vectorize for top-K relevant code chunks.
3. Calls Ollama Turbo (`glm-5.1:cloud` default) with issue + chunks.
4. Rewrites the issue description into `## Context / ## Acceptance criteria / ## Done when` (preserves media URLs).
5. Posts a triage comment, sets priority + estimate + labels (auto-creates missing labels).

**Linear: Mention reply** (`Comment.create` with `@sigilix` — also matches legacy `@arc`, `@openclaw`)
1. Pre-filters on the comment body, then fetches the comment + parent issue + recent thread.
2. Runs the same Vectorize retrieval against the asker's question.
3. Calls Ollama Turbo with the mention-reply prompt; posts the answer back.
4. Skips self-mentions; dedupes via KV.

**GitHub: PR overview** (`pull_request.opened/synchronize/reopened/ready_for_review`)
1. Fetches PR title + body + diff + recent commits.
2. Asks the model for a structured overview: 1–5 confidence, per-file priority scores, bullets to scrutinize.
3. Posts (or PATCHes in place) a single sticky top-level comment with the dedupe marker `<!-- sigilix:pr-overview -->`.

**GitHub: CI failure triage** (`workflow_run.completed` with `conclusion=failure`)
1. Lists failed jobs on the run, fetches each job's plain-text log, concatenates them.
2. Pulls PR diff + file contents the failure log mentions (Contents API at the PR head SHA) + Vectorize chunks.
3. Asks the model for a Greptile-shaped diagnosis (root cause / likely fix / failure excerpt / confidence).
4. Posts only when confidence is `high` or `medium`; updates in place via the `<!-- sigilix:ci-triage -->` marker.

**GitHub: Proactive primary review** (`pull_request.opened/synchronize/reopened/ready_for_review`)
1. Fetches PR diff and reviews it in isolation — no awareness of other reviewers.
2. Each finding gets a 1–5 score and a category (`logic`, `security`, `performance`, `error-handling`, `testing`, `complexity`, `style`, `syntax`, `docs`). The category leads the inline comment as `**category:**` (greptile-style).
3. Submits ONE review via `POST /pulls/{n}/reviews` with all findings as inline comments. Approval state is two-state: any finding posts `REQUEST_CHANGES`; an empty findings list posts `APPROVE`. **Branch-protection note (ARC-276):** the `APPROVE` event is a real GitHub review approval and counts toward the required-reviewer count on repos that don't exclude bot reviewers in their branch protection settings. This is intentional — Sigilix is opinionated by design ("if a PR needs changes, say it; otherwise approve"). Teams that don't want bot approvals to satisfy required-reviewer should exclude `sigilix[bot]` (and the legacy `arc-copilot[bot]`) from required-reviewer rules. See [Cider Security's write-up](https://medium.com/cider-sec/bypassing-required-reviews-using-github-actions-6e1b29135cc7) on the trade-off.
4. **Fix Plan** (ARC-180): when at least one finding scores ≥ 4, the review body opens with a prioritized repair queue grouping Critical (score 5) and High (score 4) findings by severity, ordered by path then line. The Fix Plan stays stable across re-reviews so a reviewer working top-to-bottom sees the same queue ordering they did last time.
5. KV-deduped on `(prNumber, headSha)` so re-firing webhooks don't double-review the same code.
6. Re-runs on every push (`synchronize`) so the bot keeps verifying after fix commits and can flip to `APPROVE`. A stale-head guard in the consumer skips jobs whose queued SHA no longer matches the PR head, preventing out-of-order queue processing from posting reviews against superseded commits.

**GitHub: @-mention reply** (`issue_comment.created` and `pull_request_review_comment.created` with `@sigilix`)
1. Filters on the comment body before queueing — most PR comments don't @ Sigilix.
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
    │ ├─ Ollama Turbo: glm-5.1:cloud / kimi-k2.7-code:cloud → JSON verdict
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

Repo indexing is owned by the Worker indexer. Do not add GitHub Actions workflows that write directly to Vectorize; the retired `.github/workflows/openclaw-index.yml` / `.github/workflows/codebase-index.yml` path used bare repo namespaces and can leave orphan vectors outside uninstall cleanup.

New GitHub App installs and repository-added events enqueue `index-repo` jobs automatically. Push events refresh the default branch plus configured long-lived branches (`dev`, `develop`, `development`, `staging`, `stage`, or `OPENCLAW_INDEX_BRANCHES`) and active same-repo PR branches. For repos that predate the Worker indexer rollout, use the authenticated admin routes:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_ADMIN_TOKEN" \
  "https://<worker-host>/admin/index-repo?owner=Sigilix&repo=sigilix"

curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_ADMIN_TOKEN" \
  "https://<worker-host>/admin/index-backfill?dryRun=true"

curl -X POST \
  -H "Authorization: Bearer $OPENCLAW_ADMIN_TOKEN" \
  "https://<worker-host>/admin/index-reconcile?dryRun=true"
```

The canonical default-branch namespace is `<owner>/<repo>` lowercased. Branch-scoped indexes use `<owner>/<repo>/__branch__/<hexEncodedBranch>` internally. Default repo listings stay branch-free unless a caller explicitly opts into branch namespaces, which the Linear mention agent does when it builds retrieval scope. Linear team keys map to namespaces via `OPENCLAW_TEAM_REPO_MAP` (see step 5).

### 5. Set the secrets

**Linear:**

```bash
npx wrangler secret put LINEAR_API_KEY
# Paste your Linear personal API key (Settings → API → Personal API keys)

npx wrangler secret put LINEAR_WEBHOOK_SECRET
# Paste the signing secret from your Linear OAuth app's webhook config

# REQUIRED (SIG-406 alpha): the review ensemble (specialists + synthesizer +
# dispatcher) runs on OpenRouter — review fails closed without this key.
npx wrangler secret put OPENROUTER_API_KEY
# Paste your OpenRouter API key (https://openrouter.ai/keys)

# OPTIONAL / LEGACY: serves non-review command paths (/api/chat, @-mention agent
# loop, indexer) + local eval testing (a `:cloud` model override routes here).
npx wrangler secret put OLLAMA_API_KEY
# Paste your Ollama Turbo API key (https://ollama.com/settings/keys)
```

**GitHub App** (required for the `/github/webhook` route — without these the route returns 503):

```bash
npx wrangler secret put GITHUB_APP_ID
# Numeric App ID from
# https://github.com/organizations/Sigilix/settings/apps/<your-app>

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
npx wrangler secret put OPENCLAW_MENTION_TRIGGERS   # CSV of @-handles, defaults to "sigilix,sigilix[bot],Sigilix[bot],arc,arc[bot],Arc[bot],arc-copilot,arc-copilot[bot],openclaw,openclaw[bot],OpenClaw[bot]" (env var name kept legacy for zero-config compatibility; legacy aliases preserved for historical PR threads)
npx wrangler secret put OPENCLAW_TEAM_REPO_MAP      # JSON: {"ARC":"rubberfit","RFD":"rubberfit-desktop"}
npx wrangler secret put LINEAR_OAUTH_CLIENT_ID      # OAuth app — comments post as the app actor
npx wrangler secret put LINEAR_OAUTH_CLIENT_SECRET  # paired with the client_id above

# ARC-190 — DO-backed pr-review run state:
npx wrangler secret put OPENCLAW_PR_REVIEW_DO_MAX_RETRIES    # 1..10, default 3
npx wrangler secret put OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS    # 60000..1800000 ms, default 1200000 (20 min)
npx wrangler secret put OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT  # 1..100, default 10
```

`OPENCLAW_TEAM_REPO_MAP` controls which Vectorize namespace gets queried for triage / mention-reply on each Linear team's issues. Without it, the team key (lowercased) is used as the namespace — so a Linear team with key `ARC` queries the `arc` namespace.

### 5b. Create + install the GitHub App

Go to <https://github.com/organizations/Sigilix/settings/apps> → **New GitHub App**.

**Required permissions** (Repository):
- **Actions**: Read (CI run jobs + logs)
- **Contents**: Read (file contents at a given ref)
- **Issues**: Write (top-level PR comments)
- **Pull requests**: Read & write (PR diff, review comments, submit review)
- **Metadata**: Read (default)

**Required webhook events:**
- `Installation` and `Installation repositories` (repo indexing and cleanup)
- `Pull request` (opened, synchronize, ready_for_review, reopened)
- `Push` (default/dev/active-PR branch re-indexing)
- `Workflow run` (CI failure triage)
- `Issue comment` (top-level PR conversation @-mentions)
- `Pull request review` (formal review-dismissal feedback capture)
- `Pull request review comment` (inline review-comment @-mentions)

Set the webhook URL to `https://sigilix.<your-account>.workers.dev/github/webhook` and copy the webhook secret to `GITHUB_WEBHOOK_SECRET` (step 5 above).

Generate a private key from the App settings page; paste the whole PEM into `GITHUB_PRIVATE_KEY`.

Install the App on the repos you want Arc to review.

### 6. Deploy

```bash
npm run deploy
```

Wrangler prints the Worker URL — something like `https://sigilix.<your-account>.workers.dev`. Copy it.

### 7. Wire the Linear webhook

In Linear → **Settings → API → Webhooks** (or in your OAuth app's webhook config):

- **URL**: `https://sigilix.<your-account>.workers.dev/linear/webhook`
- **Resource types**: check **Issue** AND **Comment** — Issue triggers triage, Comment triggers the @-mention reply path
- **Signing secret**: copy this and store it as `LINEAR_WEBHOOK_SECRET` (step 5 above)

Save. Linear sends a test payload — the Worker should return 200 and log a "skipped" line (test payloads aren't real `Issue.create` events).

### 8. Smoke test

Create a new issue in Linear. Within ~30-90 seconds, Arc posts a triage comment with priority, estimate, and label suggestions.

If you want to manually re-trigger a triage on an existing issue:

```bash
curl -X POST "https://sigilix.<your-account>.workers.dev/linear/manual" \
  -H "authorization: Bearer $LINEAR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"issueId": "ARC-42"}'
```

## Per-repo config (`sigilix.json`, `sigilix.yaml`, `sigilix.yml`)

Drop a Sigilix config file at the repo root to give Sigilix per-repo
guidance. Read at the PR head SHA on every review run, so you can
iterate on the rules in the same PR they apply to. Precedence is
`sigilix.json` first, then `sigilix.yaml`, then `sigilix.yml`; remove
the JSON file when migrating a repo to YAML.

```json
{
  "guidance": "This repo is a TypeScript Cloudflare Worker. Reject any new class declarations. Comments should explain the WHY, not the WHAT.",
  "rules": {
    "logic":       "Flag any function over 50 lines.",
    "security":    "Always check token handling and signal-aborted paths.",
    "performance": "Reject sync I/O in request handlers.",
    "tests":       "Require at least one test per new exported function."
  }
}
```

YAML is useful when comments make the config easier to maintain:

```yaml
# Repo-wide guidance is shown to every specialist and the synthesizer.
guidance: This repo is a TypeScript Cloudflare Worker. Reject any new class declarations.

rules:
  logic: Flag any function over 50 lines.
  security: Always check token handling and signal-aborted paths.
  performance: Reject sync I/O in request handlers.
  tests: Require at least one test per new exported function.
```

All fields are optional. Missing file = no extra context (current behavior). Malformed JSON/YAML = ignored with a structured warning logged but the review still runs — the config is never load-bearing for review correctness. YAML is parsed as JSON-compatible data: use explicit `true`/`false` booleans and numbers, quote glob patterns that start with `!` or `*`, and do not use custom tags, anchors, or aliases.

`guidance` is prepended to every specialist's prompt **and** the synthesizer's prompt. `rules.<role>` is appended only to that role's prompt. Unknown fields are forward-compat ignored.

### Specialist tools

Use `mcp` to approve a small in-process tool surface for specific specialists. Missing config means no tools are exposed. Each specialist invocation can make at most two tool calls, each capped at five seconds; tool results are injected into that specialist's conversation before the final review verdict.

```json
{
  "mcp": {
    "enabled": true,
    "specialists": {
      "security": { "tools": ["file_grep"] },
      "logic": { "tools": ["file_grep", "docs_fetch"] }
    },
    "tools": {
      "docs_fetch": { "enabled": false }
    }
  }
}
```

Known tool ids are `file_grep`, `docs_fetch`, `observability_lookup`, and `browser_check`. Unknown roles/tools are ignored fail-open. `tools.<id>.enabled: false` disables that tool globally even when a specialist lists it. URL-fetch tools use runtime-owned host allowlists/endpoints, not PR-controlled config; without those runtime settings they return `unavailable` instead of fetching. Tool results always carry an explicit status (`complete`, `empty`, `truncated`, `unavailable`, or `error`); non-`complete` results and `file_grep` `empty` results are not proof that a bug is absent.

### Path instructions

Use `pathInstructions` when a repo needs different review behavior for different parts of the codebase. This mirrors the path-instruction pattern used by AI review competitors: auth/API paths can be strict about authorization, database paths can focus on migrations and transactions, generated paths can be handled differently via `pathInstructions`, or excluded entirely via `pathFilters`, and tests/docs can get their own expectations.

```json
{
  "pathInstructions": [
    {
      "paths": ["src/auth/**", "workers/api/**"],
      "guidance": "Treat these as security-sensitive request paths.",
      "rules": {
        "security": "Block missing authorization checks, unsafe token handling, or secrets written to logs.",
        "tests": "Require integration coverage for auth behavior changes."
      }
    },
    {
      "path": "tests/**",
      "instructions": "Review test names, edge cases, and failure-path coverage."
    }
  ]
}
```

Each entry applies only when at least one reviewable changed file matches `paths` (or the single-path alias `path`). `guidance` / `instructions` is shown to all specialists for the matching files. `rules.<role>` is shown only to that specialist, then the synthesizer sees the full matched block during fan-in so severity decisions remain consistent.

Bad entries are dropped fail-open. Empty strings, unknown role names, and entries without a valid path are ignored. Entries are capped defensively to avoid prompt blowups (`20` entries, `50` paths per entry, `4000` code points per guidance/rule string).

### Existing AI instruction files

When `sigilix.json` has no top-level `guidance`, Sigilix also reads common repo-authored AI instruction files as advisory review context. Explicit Sigilix config always wins: a non-empty `guidance` field disables this fallback, and `OPENCLAW_INGEST_AI_INSTRUCTIONS=off` disables it globally.

Supported files:

- `CLAUDE.md`
- `AGENTS.md`
- `.cursorrules`
- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`

Root instruction files keep priority order: `CLAUDE.md` first, then `AGENTS.md`, `.cursorrules`, and `.github/copilot-instructions.md`; the first non-empty file wins. GitHub instruction files under `.github/instructions/` are additive and may include flat frontmatter:

```markdown
---
applyTo: src/auth/**, workers/**/*.ts
---
Auth and worker changes need integration coverage for failure paths.
```

`applyTo` is matched against the PR's changed file paths. Files without `applyTo` apply repo-wide. All ingested instruction text is fenced as untrusted advisory context, source-labeled for provenance, and cannot override Sigilix's correctness, security, or recall constraints. Caps: 4,000 code points per instruction chunk, 12,000 code points total, at most 20 `.github/instructions/` files, and 64 KiB per GitHub instruction file.

### Path filters (ARC-176)

Drop files from review entirely via the top-level `pathFilters` array. Plain pattern excludes; `!pattern` re-includes (override prior excludes). Saves model spend on lockfiles, generated files, snapshots, etc. Triggers the existing "router said no specialists" short-circuit when only filtered paths changed.

```json
{
  "pathFilters": [
    "dist/**",
    "**/*.lock",
    "**/*.snap",
    "package-lock.json",
    "!critical/important.lock"
  ]
}
```

Applied BEFORE the diff packing layer, so filtered files don't burn token budget. Telemetry records dropped paths under `diffPacking.filesDroppedByFilter` — useful for tuning the list (spotting accidental over-exclusion).

### Review profile (ARC-176)

`profile` is a one-line directive prepended to specialist prompts:

| Value | Behavior |
|---|---|
| `"chill"` (default if absent) | Surface only must-fix findings; skip nits and style |
| `"assertive"` | Surface must-fix findings AND nits and style; thorough mode |

```json
{ "profile": "chill" }
```

The model still weighs context — `profile` shifts the floor on flag-worthiness, not a hard rule.

### Deterministic checks (ARC-193)

Add a `deterministicChecks` array to `sigilix.json` to surface flat
patterns BEFORE the LLM runs. Each rule defines a JS regex matched
against added diff lines; matches become structured findings injected
into the specialist prompts as authoritative facts:

```json
{
  "deterministicChecks": [
    {
      "id": "no-todo-without-author",
      "pattern": "TODO(?!\\([^)]+\\))",
      "severity": "warn",
      "message": "TODOs must include an author: TODO(name): ...",
      "paths": ["src/**/*.ts"]
    },
    {
      "id": "no-console-log",
      "pattern": "console\\.log\\(",
      "severity": "error",
      "message": "console.log left in production code"
    }
  ]
}
```

Required fields: `id`, `pattern`, `message`. Optional: `severity` (`info|warn|error`, defaults to `warn`), `paths` (glob array; rule applies repo-wide when omitted).

A malformed regex is dropped silently and recorded in telemetry; never breaks the review.

### `describe.enabled` (boolean, default true) — ARC-191

Per-repo opt-out for `/sigilix describe`. Default behavior (missing field) is enabled — any OWNER / MEMBER / COLLABORATOR can invoke `/sigilix describe` on a PR. Set to `false` to disable, e.g. for repos with strict mandatory PR templates that should not be drafted over:

```json
{
  "describe": {
    "enabled": false
  }
}
```

When disabled, Sigilix posts a brief "feature disabled" comment so the user knows the gate fired (rather than silently dropping the command). Strict boolean parsing — string `"false"` does NOT disable; only literal `false`.

### `commands.<cmd>` per-command overrides — ARC-185

Each slash command (`review`, `improve`, `describe`, `ask`) can declare its own `prompt.addendum` (text appended to the system prompt, ≤ 4000 Unicode code points) AND `model.primary` / `model.fallbacks` (model lineup override). Configures cost/quality knobs per command — cheap fast `ask`, thorough `review`, etc.

```json
{
  "commands": {
    "review": {
      "prompt": { "addendum": "Pay extra attention to AbortSignal handling." },
      "model":  { "primary": "kimi-k2.7-code:cloud", "fallbacks": ["glm-5.1:cloud"] }
    },
    "improve": {
      "prompt": { "addendum": "Match the existing TypeScript style; favor `??` over `||`." }
    }
  }
}
```

**Wiring (v1):**
- `improve`, `describe` — per-command override applies to the single-shot model + retry chain.
- `review` — addendum appended to the **synthesizer** prompt; `model.primary` overrides the synth model. Specialists stay on the v3.1 LOCKED lineup. v1 limitation: only the *first* user-supplied fallback reaches the synth runtime (single-fallback `ModelConfig`); telemetry records the dropped count.
- `ask` — schema slot reserved; runtime path lands when `/sigilix ask` ships.

**Validation (strict):**
- Unknown command keys (typos like `"reviews"`) → parse error.
- Unknown model names (not in the routing registry) → parse error.
- `addendum` > 4000 code points → parse error.
- `fallbacks` > 4 entries → parse error.

**Parse-error PR comment:** when a slash-command-driven handler runs (`/sigilix improve`, `/sigilix describe`) and the config fails strict parse, Sigilix posts a top-level PR comment with the parse reason and a snippet of the raw config. Idempotent per head SHA (marker `<!-- sigilix:config-error:<sha7> -->`); a fresh config on the next push replaces the comment by virtue of the new head SHA producing a new marker. Sigilix continues to operate in default-config mode in the meantime.

**Telemetry:** `command-config-resolved`, `command-config-parse-error`, `command-config-error-comment-posted`, `command-config-error-comment-suppressed-dedupe`, `command-config-error-comment-failed`.

### `depVulnScan.enabled` (boolean, default true) — ARC-186

Per-repo opt-OUT for the dependency-vulnerability scan. Default (missing field) = enabled. Strict-bool parsing (mirror of `describe.enabled`).

```json
{
  "depVulnScan": {
    "enabled": false
  }
}
```

When disabled, the scanner short-circuits silently and emits `dep-vuln-scan-skipped { reason: "disabled-config" }` telemetry. The security-specialist prompt loses the dep-vuln fact block; everything else (secret scan, deterministic regex checks, full LLM review) still runs.

### `astRules` (object) — ARC-181

Per-repo configuration for the AST rule-pack scanner. All subfields optional:

```json
{
  "astRules": {
    "enabled": true,
    "severityThreshold": "warning",
    "disabledRules": ["no-await-in-loop"],
    "autoInline": false
  }
}
```

- `enabled` (default `true`) — hard kill-switch. Strict-bool; only literal `false` disables.
- `severityThreshold` (default `"warning"`) — `info` / `warning` / `error`. `info` is reserved for future expansion (v1 ships zero info-severity rules).
- `disabledRules` (default `[]`) — ruleId list. Unknown IDs silently ignored (forward-compat).
- `autoInline` (default `false`) — opt-IN to deterministic inline-comment posting for `error`-severity findings without LLM intermediation. Default flips to `true` after 2 weeks of FP-telemetry shows < 5%.

Full rule-pack reference + telemetry events live in the [AST rule-pack scanner section](#ast-rule-pack-scanner-arc-181).

### `sarifEvidence` (object) — ARC-188

Per-repo configuration for the SARIF evidence channel. Reads `.sigilix/trivy.sarif.json` (or configured path) at the PR head and feeds Trivy / Kubescape / any SARIF v2.1.0 producer's findings into the security-specialist prompt as authoritative facts. SBOM (when present in the report) is rendered as a compact metadata block in the synth prompt only.

```json
{
  "sarifEvidence": {
    "enabled": true,
    "path": ".sigilix/trivy.sarif.json",
    "severityThreshold": "warning",
    "disabledRules": ["TRIVY-LIC-001"],
    "disabledCategories": ["license"]
  }
}
```

- `enabled` (default `true`) — strict-bool kill-switch.
- `path` (default `.sigilix/trivy.sarif.json`) — single-file path. v1 explicitly does NOT support globs; aggregate multi-tool scans into one SARIF file in your CI (SARIF supports multiple `runs[]` per file).
- `severityThreshold` (default `"warning"`) — `info` / `warning` / `error`. SARIF `level: "note"` maps to `info`; `level: "none"` is filtered.
- `disabledRules` (default `[]`) — SARIF rule_ids to silence.
- `disabledCategories` (default `[]`) — bulk-disable a class: `iac` / `vulnerability` / `license` / `secret` / `misconfiguration` / `other`.

Caps applied to keep prompts predictable: 2 MB report-size cap, 200 findings per scan (excess truncated with telemetry), 10 findings per file in the human-readable prompt block (full set in the synth JSON). Stale-report telemetry fires when SARIF `invocations[].endTimeUtc` is > 7 days old.

License findings route to the `security` specialist (Sigilix has no compliance specialist; security is the closest superset for governance/compliance signal). Path normalization rejects host-absolute, Windows-absolute, UNC, and traversal-shaped paths.

Auto-inline posting is **NOT** wired in v1 — Trivy raw output can be noisy in unfamiliar codebases. Findings only appear in the LLM specialist prompts, not as deterministic comments.

### `reviewMemory` (object) — ARC-189

Per-repo configuration for cross-PR review memory. **Default OFF** on both knobs — opposite polarity from every other scanner. Retrieval requires both env (`OPENCLAW_REVIEW_MEMORY_ENABLED=on`) AND `enabled: true` here. Capture requires env (`OPENCLAW_REVIEW_MEMORY_CAPTURE=on`) AND (`enabled: true` OR `captureOnly: true`).

```json
{
  "reviewMemory": {
    "enabled": true,
    "captureOnly": false,
    "categories": ["performance", "tests"],
    "maxInjectedMemories": 5,
    "minSignalThreshold": 3,
    "maxSignalAgeDays": 90
  }
}
```

- `enabled` (default `false`) — strict-bool kill-switch. Only literal `true` opts in.
- `captureOnly` (default `false`) — when set, capture writes to KV but retrieval stays off. Lets a repo build up a corpus before turning on prompt injection.
- `categories` (default all 4) — opt-in subset of `security` / `logic` / `performance` / `tests`. Empty array means all 4.
- `maxInjectedMemories` (clamped to `[1, 10]`, default 5) — cap on records injected into the synth prompt.
- `minSignalThreshold` (clamped to `[2, 20]`, default 3) — minimum dismissal signals required for a category to be "active."
- `maxSignalAgeDays` (clamped to `[7, 365]`, default 90) — sliding window for active-signal counting. Stored signals older than 180 days are pruned at write time regardless.

## Review provenance + stale markers (ARC-184)

After every successful review, Sigilix persists a per-PR **review manifest** to KV (`pr-review-manifest:<owner>/<repo>#<n>`) capturing the inputs the model reviewed against:

- PR / base / head / merge-base SHAs
- File-list hash (SHA-256 of the sorted changed-file set, with rename pairs)
- Prompt version (`PROMPT_VERSION` constant in `src/prompts/pr-review.ts`)
- Model id (specialist or `ensemble-synth`)
- Target id (`{kind: "review", reviewId}` in the success path; `{kind: "issue-comment", commentId}` reserved for fallback paths)

When a `synchronize` or `edited` webhook arrives and a manifest exists, Sigilix enqueues a parallel **stale-mark job** alongside the regular review. The consumer reads the live manifest, fetches current state via the GitHub `pulls/files` and `compare` endpoints, computes drift, and PATCHes a stale-notice block into the prior review's body.

**Drift triggers:** head SHA, base SHA, file-list hash, prompt version. Model id is recorded but does not trigger stale (cost — model bumps shouldn't invalidate every open PR). The stale check has a head-SHA short-circuit: if `manifest.headSha === current.headSha`, the manifest IS the up-to-date one and no other deltas matter.

**Stale notice format:**

```
<!-- sigilix:stale-marker:start -->
> [!WARNING]
> **This review is stale.** Reviewed head `<old>` against base `<old>`. PR is now at `<new>` against base `<new>`. Run `/sigilix review` to re-review the current diff, or wait — Sigilix will refresh on the next push.
<!-- sigilix:stale-marker:end -->
```

Idempotent on re-application — re-running on a body that already has a stale block replaces in place. The block sits between the leading `<!-- sigilix:pr-review -->` marker and the original review body; the rest is untouched.

**Sticky summary footer:** every review body now ends with `_Reviewed against \`<sha7>\` at <ISO timestamp>._` so a reader can see at a glance which head SHA the verdict applies to (without reading the markers).

**Permission requirement:** the GitHub App needs both `pull_requests: write` AND `issues: write`. The first covers `PATCH /pulls/{n}/reviews/{id}`; the second covers the issue-comment fallback path's `PATCH /issues/comments/{id}`.

**Kill-switch:** `OPENCLAW_REVIEW_MANIFEST_ENABLED=off` short-circuits both manifest writes and stale-mark enqueues. Single flag for production rollback.

**Known v1 limitations** (documented in spec §13a, accepted for v1):
- Cloudflare KV is eventually consistent; manifest written by a just-completed review may not be visible to the next webhook for ~60 s. Mitigated by the head-SHA short-circuit; remaining false-stale cases self-correct on the next webhook.
- A `synchronize` webhook arriving while the previous review is still in-queue (no manifest yet) sees `manifest = null` and emits `review-manifest-missing` without a stale mark. Brief gap (seconds) until the new review lands and writes a fresh manifest.
- Inline review comments are NOT individually marked stale in v1 — only the top-level review body. Re-reviewing rebuilds the inline comments anyway.

**Telemetry events:** `review-manifest-written`, `review-manifest-write-failed`, `review-manifest-missing`, `review-manifest-invalid`, `review-stale-detected`, `review-stale-not-detected`, `review-stale-current-state-empty-retry`, `review-stale-superseded`, `review-stale-target-missing`, `review-stale-marked`, `review-stale-mark-failed`.

## Secret scanning (ARC-187)

Sigilix runs a Worker-native secret scanner against added diff lines BEFORE the LLM specialist fanout. **Always on**, no config needed — secret detection is baseline behavior, not opt-in.

Built-in rule baseline (severity = `error` unless noted):

| Rule | Pattern shape |
|---|---|
| `aws-access-key` | `AKIA...` / `ASIA...` (16 chars) |
| `github-token` | `gh{p,o,s,r,u}_...` (36-255 chars) |
| `slack-webhook` | `https://hooks.slack.com/services/...` |
| `stripe-secret-key` | `sk_live_...` / `sk_test_...` |
| `anthropic-api-key` | `sk-ant-...` |
| `openai-api-key` | `sk-...` (excluding `sk-ant-`) |
| `ollama-api-key` | `ollama_...` |
| `private-key-pem-header` | `-----BEGIN ... PRIVATE KEY-----` |
| `generic-high-entropy-token` (warn) | 40+ char base64-ish; suppresses hex-only and URL fragments |

**Privacy contract:** raw secrets are NEVER stored, logged, or returned. Hits surface only a redacted preview (first 4 + ... + last 4 chars) and a stable fingerprint for cross-run dedup. Telemetry (`secretScan.fingerprints`) stores fingerprints only.

When a hit fires, the security specialist receives it as an authoritative fact in the prompt and the review surfaces a "rotate immediately" recommendation. The scan covers added diff lines only — pre-existing secrets aren't re-flagged on every PR.

## Dependency vulnerability scan (ARC-186)

Sigilix runs a **deterministic dep-vuln scan** before the LLM specialist fanout (alongside the secret scan + deterministic regex checks). v1 covers npm only — `package.json` + `package-lock.json`. Findings are injected into the security-specialist + synthesizer prompts as authoritative facts. **Always on**, opt-OUT via `sigilix.json` (`depVulnScan.enabled: false`).

**How it works:**

1. Fetches `package.json` + `package-lock.json` at the PR head + base SHA via the existing GitHub Contents API.
2. Parses both lockfile formats (npm v6 + npm v7+) and **filters to root deps only** by intersecting lockfile entries with the union of `dependencies` + `devDependencies` + `peerDependencies` from `package.json`. Hoisted transitives are dropped.
3. Computes the added/upgraded set as the `(name, version)` pairs in the head lockfile that differ from the base lockfile. Lockfile-only changes (e.g. `npm audit fix` bumps with no `package.json` edit) are detected.
4. For each added/upgraded dep, looks it up in the bundled advisory DB and runs **range-aware** matching: a finding emits only when the version is inside a vulnerable range AND below the patch_in for THAT specific range. Multi-major advisories (e.g. patched in `1.4.2` AND `2.1.3`) are matched correctly without the false-negative trap of a global-min `>= patched_in` rule.

**Bundled advisory DB:** `src/features/dep-vulns/domain/dep-vulns.json` — capped at **500 KB** (CI enforces). v1 ships 8 well-known historical advisories as a seed. Full curation lands in a quarterly operator-refresh PR per the §10a retention policy: all critical+high regardless of age, all medium from the last 12 months, top-N low by npm download count.

**Strict missing-lockfile policy:** if the head lockfile is absent (gitignored, etc.), the scan emits `dep-vuln-scan-skipped { reason: "missing-lockfile" }` and exits cleanly. No `package.json`-only fallback in v1; deferred to v2.

**v2 future scope:** Python ecosystems (`requirements.txt`, `Pipfile`, `Pipfile.lock`), live Aikido/OSS-Index API fetch, transitive resolution, workspaces / monorepos (v1 scans every changed leaf manifest pair independently).

**Telemetry:** `dep-vuln-scan-skipped` (with reason), `dep-vuln-scan-ran` (with `findingsCount`, `depsScanned`, `durationMs`), `dep-vuln-snapshot-meta` (snapshot date + advisory count once per scan), `dep-vuln-finding` (per emitted finding for severity aggregation).

## AST rule-pack scanner (ARC-181)

Sigilix runs a **deterministic AST rule scan** over changed JS/TS files BEFORE the LLM specialist fanout (alongside the secret scan, dep-vuln scan, and deterministic regex checks). v1 ships **10 curated rules** — 5 security (`error` severity) + 5 correctness/perf (`warning` severity). Findings are injected into the security/logic/performance specialist prompts as authoritative facts. Bundle delta: ~52 KB gzipped (`acorn` + `acorn-walk` + `acorn-typescript`).

**v1 rule pack:**

| Rule ID | Severity | Role |
|---|---|---|
| `no-eval-call` | error | security |
| `no-new-function-constructor` | error | security |
| `spawn-shell-true` | error | security |
| `no-disabled-tls-reject-unauthorized` | error | security |
| `no-document-write-call` | error | security |
| `no-async-without-await` | warning | logic |
| `no-throw-literal` | warning | logic |
| `no-await-in-loop` | warning | performance |
| `no-floating-promise-call-known-async` | warning | logic |
| `no-process-env-mutation` | warning | logic |

**How it works:**

1. After `pathFilters` excludes lockfiles/dist/etc., the runner fetches each changed JS/TS file at the PR head SHA via the GitHub Contents API.
2. acorn parses each file (`acorn-typescript` handles `.ts`/`.tsx`/`.mts`/`.cts`/`.jsx` syntax). Files > 500 KB are skipped with `ast-rules-scan-skipped-large-file` telemetry.
3. Each enabled rule visits matching node types via `acorn-walk` and emits zero or more `AstRuleHit` candidates.
4. Hits are filtered to lines in the unified diff's `+` (new-side) set — pre-existing code in unchanged regions of touched files is NOT re-flagged. Multi-line node spans intersect with the changed-line set.
5. Each kept hit becomes an `AstFinding` with a stable `astFindingId = ast/<ruleId>/<pathHash7>/<line>` for synth supersession and audit-marker rendering.
6. Findings are rendered as a `[AST RULE FINDINGS — pre-LLM]` block in the specialist prompts AND as a structured JSON block in the synth prompt for `(path, line, role_hint)` supersession matching.

**Auto-inline posting (opt-IN):** when `astRules.autoInline: true` is set in `sigilix.json`, `error`-severity findings post inline review comments without LLM intermediation. Default `false` for v1 cautious rollout — flips after 2 weeks of FP-rate telemetry shows < 5%. Each posted comment carries a hidden `<!-- ast/<ruleId>/<pathHash7>/<line> -->` audit marker so re-review tooling can identify deterministic supersessions.

**`sigilix.json` config:**

```json
{
  "astRules": {
    "enabled": true,
    "severityThreshold": "warning",
    "disabledRules": ["no-await-in-loop"],
    "autoInline": false
  }
}
```

Locked defaults when fields are absent: `{ enabled: true, severityThreshold: "warning", disabledRules: [], autoInline: false }`. `severityThreshold` of `"info"` is reserved for future expansion (v1 ships zero info-severity rules).

**v2 future scope:** type-aware rules (requires the TypeScript compiler, much larger bundle), cross-file analysis, custom user-defined rules in JSON/YAML DSL, multi-emit-per-file (currently the rule-pack emits one finding per `Program` visit for `no-await-in-loop`).

**Telemetry:** `ast-rules-scan-skipped` (with reason), `ast-rules-scan-ran` (`filesScanned`, `findingsCount`, `durationMs`), `ast-rules-finding` (per finding with `roleHint`), `ast-rules-scan-skipped-large-file`, `ast-rules-finding-no-review-position`, `ast-rules-parse-failed`, `ast-rules-inline-posted` (per auto-posted comment), `ast-rules-auto-inline-summary`.

## SARIF evidence channel (ARC-188)

Sigilix ingests **SARIF v2.1.0** reports as a generic deterministic evidence channel. Trivy is the prototype consumer (IaC misconfig, dep CVEs, license violations, secret leaks); the channel works for any SARIF-emitting tool — Kubescape, CodeQL, Snyk, Bandit, Semgrep — without code changes. **Always on**, opt-OUT via `sigilix.json` (`sarifEvidence.enabled: false`).

**How it works:**

1. The runner fetches a single SARIF file at `.sigilix/trivy.sarif.json` (or `sarifEvidence.path`) at the PR head SHA.
2. Defensive parser validates `version: "2.1.0"`; `2.0.0` and malformed reports skip with telemetry.
3. Each `result` is path-normalized (URI decode → `file://` strip → leading-`./` strip → Windows-separator normalize → traversal-reject → host-absolute-reject; encoded traversal `%2e%2e/` is caught after decode), filtered against the PR's `+`-line set, and run through the multi-source taxonomy resolver (`result.taxa[]` de-referenced against `runs[].taxonomies[]`, then `properties.tags[]`, then `rule.id` substring, then `rule.name`, then `tool.driver.name`).
4. Findings emit into the security-specialist prompt as authoritative facts. SBOM-flagged runs produce a compact metadata block (≤20 lines: package count + top-N direct deps + license counts) routed to the synth prompt only — for Fix Plan ordering (direct-dep findings outrank deep transitives).

**Categorization:**

| Category | Detected via | `roleHint` |
|---|---|---|
| `iac` / `misconfiguration` | `Kubernetes`/`Helm`/`Dockerfile`/`Terraform`/`AVD-KSV-` ruleId | `security` |
| `vulnerability` | `CVE-`/`GHSA-` ruleId or `Vulnerability` tag | `security` |
| `license` | `License` tag or keyword | `security` (Sigilix has no compliance specialist) |
| `secret` | `Secret`/`credential` tag | `security` |
| `other` | unmatched fallback | `security` |

**Caps + stale telemetry:** 2 MB report cap (pre-parse), 200 findings per scan (excess truncated + `sarif-evidence-truncated`), 10 findings per file in the human-readable prompt block (full set in synth JSON), stale-report telemetry when `invocations[].endTimeUtc` > 7 days old.

**Path-only fallback:** IaC findings often lack a line number. The runner keeps these when the path is in the PR's changed-file set.

**Auto-inline posting NOT in v1.** Trivy raw output is too noisy to deterministically comment without LLM review; we let the security specialist judge each finding before it surfaces. Defer to v2 once we have FP-rate telemetry from real PRs.

**Single-file model.** Multi-tool aggregation is the user's CI's responsibility — SARIF supports multiple `runs[]` in a single file. v2 candidate: glob support + GHA workflow-run artifact fetch.

**Telemetry:** `sarif-evidence-scan-skipped` (with reason), `sarif-evidence-scan-ran` (with `findingsCount`, `resultsConsidered`, `durationMs`), `sarif-evidence-finding` (per emitted finding), `sarif-evidence-truncated` (when 200-cap fires), `sarif-evidence-stale-report` (with `ageHours` when > 7d), `sarif-evidence-parse-failed`, `unsupported-sarif-version`.

## Cross-PR review memory (ARC-189)

Sigilix is otherwise stateless across PRs — same blind spots, same low-signal nits recur forever. Reviewers either ignore them or reply with "not relevant" / "false positive" / "ignore" — but Sigilix has no memory of those signals and re-emits the same class of comment on the next PR.

ARC-189 adds a **minimal cross-PR review-memory store** so Sigilix carries learned dismissal preferences across reviews on the same `(owner, repo, path?, category)` tuple. When a team has dismissed N+ findings of class C on path P in the last 90 days, the next review's synthesizer prompt receives a `[REVIEW MEMORY]` block instructing it to **soften** matching findings (downgrade `score` by one tier, shorten body) and emit a `provenance.softened[]` entry. Default OFF on both capture and retrieval — opt-in via env + `sigilix.json`.

**How it works:**

1. Every Sigilix-authored inline review comment carries a hidden HTML marker: `<!-- sigilix:fid:<sha16>:cat:<category>:sev:<severity>:path:<sha12> -->`.
2. When a reviewer posts an inline reply (`pull_request_review_comment.created` webhook), Sigilix dispatches a non-blocking `ctx.waitUntil()` capture pipeline: it fetches the parent comment, extracts the marker, and parses the reply body for dismissal keywords (`not relevant`, `false positive`, `ignore`, `noise`, `dismiss`, `won't fix`/`wontfix`, plus bare-`nit`) or narrow acceptance keywords (`good catch`, `fixed`, `addressed`, etc.).
3. Top-level PR conversation comments (`issue_comment.created`) are captured only when the comment explicitly carries a copied Sigilix marker/fingerprint and Sigilix verifies that marker against a real Sigilix-authored PR comment/review comment. No timeline-order heuristic is trusted.
4. On a dismissal hit, Sigilix writes a structured signal record to KV under `review-memory:<owner>/<repo>:cat:<category>` and, when the trusted source has a raw path, `review-memory:<owner>/<repo>:path:<sha256>:cat:<category>` (full SHA-256 in the key; the marker's sha12 is a human-readable hint only). Records carry no reviewer identity, no PR title/body, and no free-text quote — only category, severity, finding-ID-hash, path-hash, timestamp, PR number.
5. Accepted/dismissed/stale outcomes with hidden `sigilix:fingerprint` markers also feed the SIG-147 precision profile. `pull_request_review.dismissed` maps only to `stale`, only when the dismissed Sigilix review was posted on an older commit than the current PR head and the review body contains mappable finding fingerprints.
6. On the next review, the synth prompt receives a `[REVIEW MEMORY]` block listing active categories (≥3 dismissals in trailing 90d) and active path-categories (same plus ≥1 signal in trailing 30d). The synth applies the soften and emits `provenance.softened[]` entries the orchestrator dereferences for score-decrement before posting.

**Privacy contract:**

- Raw repo-relative paths NEVER stored in keys, values, or prompts (only sha12/sha256 hashes).
- No reviewer login persisted (memory aggregates dismissals across reviewers).
- No `evidenceQuote` of the dismissal text (deferred to v2 with a real PII redaction bundle).
- KV records are scoped to `(owner, repo)` — fork dismissals don't pollute the upstream repo's memory.

**Default OFF.** Capture requires `OPENCLAW_REVIEW_MEMORY_CAPTURE=on` AND `enabled: true || captureOnly: true` in `sigilix.json`. Retrieval requires `OPENCLAW_REVIEW_MEMORY_ENABLED=on` AND `enabled: true`. See the `reviewMemory` config section above for the full truth table.

**v1 ships soften-only.** The `drop` action is deferred to v2 once telemetry tunes the threshold. v1 always softens (score `-1` clamped at 1).

**Scope limitations**:
- Top-level PR conversation capture requires explicit marker/fingerprint correlation and verification against a Sigilix-authored source comment. Freeform "the bot is wrong" comments without a copied marker are skipped rather than guessed from timeline order.
- Reaction-based feedback is not captured today because GitHub's documented webhook events do not include a standalone reaction event for PR review comments. Adding this requires a supported event source or a separate polling job.
- `pull_request_review.dismissed` is stale-only; it never records a false-positive dismissal without commit-sha proof that the dismissed review is stale.
- KV-only storage (no D1).
- KV has no CAS, so concurrent same-comment deliveries can record up to 2 signals per replyCommentId — bounded duplicate tolerance documented and absorbed by threshold-3 activation.

**PROMPT_VERSION bump (1 → 2).** Adding the `[REVIEW MEMORY]` injection + `provenance.softened[]` schema bumps the prompt version, which marks every open-PR review manifest stale on first deploy of v2. The one-shot deploy aid `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE=on` (with companion `_SET_AT=$(date +%s)`) surgically filters the `"prompt-version"` reason out of the `StaleResult.reasons[]` array WITHOUT skipping legitimate head/base/file-list drift. The aid auto-fail-safes after 72h (operator alert + suppression turned off automatically) so it can't be left on indefinitely.

**Telemetry:** `review-memory-capture-skipped` (with reason and `signal_source`), `review-memory-capture-written` (with `signal_source`), `review-memory-capture-failed` (with stage), `review-feedback-outcome-recorded`, `review-feedback-outcome-skipped`, `review-memory-lookup-skipped` (with reason), `review-memory-lookup-ran` (with `memoriesFound`/`memoriesInjected`/`durationMs`), `review-memory-corrupt-record`, `review-memory-softened-rendered` (with `softenedCount`), `review-stale-prompt-version-suppressed`, `review-stale-prompt-version-suppressed-heartbeat` (with `level: info|warn`), `review-stale-prompt-version-suppressed-stale` (after 72h fail-safe), `review-stale-prompt-version-suppress-misconfig` (with reason).

## Coverage-diff ingestion (SIG-118)

Sigilix can read a **test-coverage report from the PR head's CI run** and feed *coverage-gap* facts to the tests specialist. A coverage gap is a line that this PR **added** AND that the CI coverage run reports as **uncovered** — exactly the lines a reviewer should ask for a test on.

**Default OFF** (`coverage.source: "off"`) — opposite polarity from the always-on scanners. Production behavior is unchanged until an operator opts in. Enable per-repo in `sigilix.json`:

```json
{
  "coverage": {
    "source": "github-actions-artifact",
    "artifactName": "coverage-lcov",
    "entry": "lcov.info"
  }
}
```

- `source` (default `"off"`) — `"github-actions-artifact"` reads an LCOV artifact uploaded by the head SHA's GitHub Actions run; any other value (including `"off"`) keeps the feature dormant.
- `artifactName` (default `"coverage-lcov"`) — the `actions/upload-artifact` name to look for.
- `entry` (default `"lcov.info"`) — the LCOV file inside the artifact ZIP.

**How it works:**

1. Find the latest **completed + successful** workflow run whose `head_sha` equals the PR head SHA (a mismatched SHA means the artifact is for a different commit — skipped).
2. List that run's artifacts, take the first non-expired one matching `artifactName` whose **compressed** `size_in_bytes` is ≤ 5 MiB (checked BEFORE download).
3. Download the artifact ZIP. **Security:** GitHub's artifact endpoint replies with a 302 to a short-lived signed storage URL; the redirect is followed MANUALLY — the first request carries the install token, the redirect target is required to be `https:`, and the second request to the signed URL carries **no auth headers** (the signed query string is the credential; sending the install token there would leak it to the storage host). The download is byte-capped at 15 MiB.
4. Extract just the `entry` file (uncompressed entry capped at 15 MiB), parse `DA:<line>,0` records as the uncovered set, normalize each `SF:` path (strip the runner workspace prefix / `file://` / `./`), and resolve it to a changed file by exact-or-unique-suffix match (ambiguous / traversal paths rejected).
5. Intersect the uncovered lines with the PR's **added** lines (reusing `buildChangedLines`) and emit a `[COVERAGE GAPS — pre-LLM, LCOV]` block to the tests specialist with citable `coverageGap:<path>:<line>` refs.

The two tests-finding gates (`evaluateTestingFindingCitation`, `evaluateTestFinding`) accept a `coverageGap:<path>:<line>` ref as a real missing-coverage citation when the (path, line) is in the gap set and the cited path matches the finding's path.

**Best-effort + non-fatal:** any failure — no run, no artifact, head-SHA mismatch, expired/oversized artifact, fetch/parse error — is swallowed and the review proceeds with no coverage block. Coverage ingestion can never break a review.

**Telemetry:** `coverage-ingest` (with `source`/`runId`/`artifactName`/`gaps_count`/`skipped_reason`), `coverage-ingest-ran` (with `lcovFiles`/`gaps`), `coverage-ingest-skipped` (with `reason`).

**Dependency note:** ZIP extraction uses [`fflate`](https://github.com/101arrowz/fflate) (`0.8.2`, exact pin, MIT license) — used ONLY for extracting the LCOV entry from a GitHub Actions artifact ZIP in the Worker. No other code path uses it.

## DO-backed pr-review run state (ARC-190)

A Cloudflare Durable Object (`PrReviewRunDO`) replaces the legacy 7-day KV `pr-review:<owner>/<repo>#<pr>@<sha>` dedupe key with a per-PR state machine. The DO owns dedupe, retry orchestration, and a public status route; the queue consumer wrapper claims runs via `/pickup` and reports outcomes via `/run-result` so retries are scheduled centrally instead of leaking into queue redelivery.

**Webhook flow:** automatic PR-review webhooks call DO `/enqueue`. The DO emits the queue message with `runId`; the consumer wrapper claims via `/pickup`, runs the ensemble, and reports via `/run-result`. The DO call is **awaited** (not `ctx.waitUntil`) so a transport / non-OK failure returns 503 to GitHub for redelivery.

**Status route:** `GET /reviews/<owner>/<repo>/<prNumber>` returns a projection of the current run (`runId`, `headSha`, `state`, `attempts`, `startedAt`, `pickedUpAt?`, `finishedAt?`, `lastError?`) plus a bounded `RunRecord` history as JSON. v1 is unauth (read-only metadata only — no diffs, no comment bodies, no secrets). Returns 404 when no run state exists for the PR. The full schema lives in `src/do/types.ts` (`StatusResponseFound` / `StatusResponseEmpty`).

**Retry orchestration:** transient verdicts (HTTP 5xx, network/model timeouts, `failureReason ∈ {timeout, aborted, fallback_failed:...}`) trigger a retry alarm with 30s / 90s / 270s backoff. Terminal verdicts (HTTP 422 invalid-anchor, `missing_api_key`, `outside-config-allowed-paths`, `submit_fallback_failed`, hallucination-only verdicts) skip retries. A watchdog alarm (default 20 min, configurable) catches consumers that crashed before posting `/run-result`. Attempts are incremented at retry-alarm fire time only — scheduling does not increment.

**Telemetry split:** every dedupe-related event carries `dedupe_system: "kv" | "do"`. DO-routed events use the `do-review-*` namespace — emitted from inside the DO (`do-review-enqueued`, `do-review-deduped`, `do-review-superseded`, `do-review-pickup-skipped`, `do-review-picked-up`, `do-review-retry-fired`, `do-review-retry-noop`, `do-review-watchdog-transient`, `do-review-watchdog-terminal`, `do-review-watchdog-noop`, `do-review-result-superseded`, `do-review-alarm-stale`) and from the webhook + consumer wrapper (`do-review-enqueue-failed`, `do-review-enqueue-non-ok`, `do-review-consumer-pickup-unexpected-status`, `do-review-consumer-run-result-non-ok`, `do-review-consumer-run-result-failed`). KV-routed sibling JobMessage variants (`pr-overview`, `pr-improve`, `pr-describe`, `pr-stale-mark`, `ci-triage`, `github-mention`) carry `dedupe_system: "kv"` on their dedupe-skip emission so dashboards can split DO-routed from KV-routed work.

**v1 limitations** (deferred to v2):
- Only `pr-review` is migrated. The 6 sibling per-PR variants stay KV-routed.
- DO instance GC sweep (`state.storage.deleteAll()` cron) is deferred until Cloudflare's DO `list()` API is stable. v1 instruments `lastActivityAt` on every state mutation so the v2 sweep can rank stale instances.
- Status route is unauth read-only metadata. Per-installation auth and web UI are v2.
- Storage backend is KV-backed DO storage. D1 / SQL backing is v2.

Source: `src/do/` (`pr-review-run.ts`, `consumer-wrapper.ts`, `webhook-enqueue.ts`, `status-route.ts`, `classify-error.ts`, `config.ts`, `types.ts`). End-to-end acceptance scenarios live in `tests/do-pr-review-acceptance.test.ts` (3-replay dedupe, transient-failure recovery, watchdog exhaustion).

## Slash commands (ARC-178 / ARC-179 / ARC-191)

Reviewers can drive Sigilix from any PR comment without pushing a no-op commit. Currently live:

| Command | Effect |
|---|---|
| `/sigilix review` | Re-runs the ensemble review against the PR's current head SHA. Sigilix posts a short ack, clears the per-(PR, headSha) dedupe lock, then the regular sticky review comment updates when the run completes. |
| `/sigilix improve` | Single-shot LLM pass (NOT the ensemble) that produces apply-able GitHub suggested-change comments. Each suggestion is anchored to a changed line in the diff and rendered as a `\`\`\`suggestion` block, apply-able from the GitHub UI's "Commit suggestion" button. Suggestions are advisory (event = `COMMENT`, never `REQUEST_CHANGES`); scope is intentionally narrow — naming / clarity / dead-code / docs / light error-handling polish. Correctness or security findings stay on `/sigilix review`. When nothing is patch-worthy, Sigilix posts a brief "no high-confidence patches" comment. |
| `/sigilix describe [pr\|internal\|external]` | Single-shot LLM draft of a PR description (`pr`, default) or internal / external changelog. Posted as a top-level comment with `<!-- sigilix:describe:<mode>:start/end -->` markers around the draft body and a hidden `<!-- sigilix-meta: {...} -->` line for future apply-verb parsing. The PR body itself is **never** auto-edited by v1; copy the section between markers manually. Per-repo opt-OUT via `sigilix.json` (`describe.enabled: false`). External-mode disclosure is prompt-level best-effort, NOT a security control — disable for repos that need hard guarantees. |
| `/sigilix help` | Posts an inline list of supported commands. No model call, no diff fetch — just an authenticated comment post. |

Recognition rules:

- Must be at the **start of a line** (after leading whitespace). Quoted/inline references like `> /sigilix review` or `Hey /sigilix review please` don't trigger.
- Case-insensitive on both the prefix and the command word (`/Sigilix REVIEW` works).
- Distinct from `@sigilix` mentions — those still flow through the existing Q&A reply path.
- Code-fenced or blockquoted invocations are stripped before parsing, so commands inside `\`\`\`` blocks or `>` quotes are ignored.

Authorization:

- Commenter must be `OWNER`, `MEMBER`, or `COLLABORATOR` on the repo (per GitHub's `author_association` field). `CONTRIBUTOR` is intentionally excluded — anyone whose PR has merged is permanently `CONTRIBUTOR`, which is too broad a circle for a privileged channel.
- Untrusted authors get a 403 (silent to the user — no comment posted). Decision is logged via the `slash-command-rejected` telemetry event for ops review.

Burst behavior:

- Concurrent invocations of the same slash command on the same PR are coalesced for 60s via a per-`(cmd, PR)` KV lock (`slash-cmd:<cmd>:<owner>/<repo>#<n>`). The first invocation enqueues the job; subsequent invocations within the window log `slash-command-coalesced` and return 202 silently. The key includes the command name so different commands on the same PR don't accidentally suppress each other.

Visible ack:

- The bot posts a 👀 reaction on the source comment within ~1s of webhook delivery (immediately after ACL + coalesce gates pass) so reviewers see Sigilix received the command before the queue-side LLM run completes (~30-90s typical). Best-effort — a reaction-API failure is logged and the actual command still runs.

Unsupported subcommands (`/sigilix ask`) are reserved for follow-up issues. Until they ship, those invocations fall silently through to the @-mention pipeline.

## CI / auto-deploy

Deploys are owned by **Cloudflare Workers Builds** — the GitHub integration on the worker's CF dashboard auto-deploys on every push, including PR pushes.

**Build command (test+typecheck gate):** the dashboard's build command is `npm run build`, and `npm run build` is wired to `tsc --noEmit && vitest run` — so a failing typecheck OR a failing vitest run aborts the build before `wrangler deploy` ever runs. A broken commit can never produce a production deploy.

**Deploy command:** `npx wrangler deploy` (NOT `npx wrangler versions upload`). DO migrations require a non-versioned deployment, so gradual deployments would fail with CF error 10211. See <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/#gradual-deployments-for-durable-objects>.

`.github/workflows/ci.yml` ALSO runs typecheck + tests on every PR for fast in-PR feedback (separate from the dashboard-side gate; the dashboard's gate is the load-bearing pre-deploy check).

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in your dev secrets
npm run dev                       # starts wrangler dev on http://localhost:8787
```

Use `ngrok` or `cloudflared tunnel` to expose `localhost:8787` to Linear if you want to test webhooks locally.

## Files

```
Sigilix/
├── README.md                              # this file
├── package.json
├── tsconfig.json
├── wrangler.toml                          # Cloudflare config + KV/Vectorize bindings + secrets list
├── .dev.vars.example                      # local secret template (.dev.vars is gitignored)
├── .github/workflows/ci.yml               # PR typecheck + tests (deploys are owned by Cloudflare Workers Builds)
├── scripts/phase3-bakeoff.mjs             # Phase 3 bake-off — replay agent-loop runs through single-shot
├── scripts/phase4-bakeoff.mjs             # Phase 4 bake-off — paired ensemble vs Phase 3 review comparison
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
- **Incremental indexing**: re-embed only changed files on each push (the Worker indexer currently processes the repo tree in sharded jobs).

## Security

- HMAC verification on every webhook delivery — invalid signatures return 401. Linear: raw hex digest in `linear-signature`. GitHub: `sha256=<hex>` in `X-Hub-Signature-256`.
- All secrets live in Cloudflare's secret store, encrypted at rest, never logged.
- The Worker has no filesystem; the GitHub App private key path that historically lived on the Windows box is gone.
- Linear API token is workspace-scoped; the Worker can't write outside the Sigilix workspace.
- GitHub App installation tokens are scoped to whatever the App is installed on. Tokens last ~1 hour and are KV-cached per-installation; the App's master private key is the only sensitive credential.
- Manual trigger route requires a Bearer token equal to `LINEAR_API_KEY`. Random clients can't fire triages.

## Troubleshooting

**Webhook returns 401**: signing secret mismatch. Re-check that `LINEAR_WEBHOOK_SECRET` (step 5) matches the secret shown in Linear's webhook config (step 7).

**Webhook returns 200 but no comment appears**: check Worker logs (`npx wrangler tail`). Common causes — Ollama Turbo timeout (>5 min), KV namespace ID still set to `REPLACE_WITH_KV_NAMESPACE_ID`, or model name typo.

**Triage comment is wrong / hallucinated**: the model output didn't parse cleanly and got fabricated content. Check the raw response in logs, then iterate on the prompt at `src/prompts/issue-triage.ts`.

**Same comment posted twice**: KV is empty (cold cache) and the comment-body marker scan also missed the existing one. Check that the `<!-- sigilix:issue-triage -->` marker (or its legacy `<!-- openclaw:issue-triage -->` form on pre-rebrand comments) appears in your existing triage comments.
