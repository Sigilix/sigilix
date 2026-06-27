# Agent Runner (CF Container) — deploy & go-live (SIG-545 B1)

The **B1 foundation** of the "assign-to-Sigilix → implement + open a PR" flagship: a Cloudflare Container that, given a task packet, clones a repo, runs a minimal GLM-5.2 edit-loop, and opens a PR. It **ships dark** behind `OPENCLAW_AGENT_RUNNER_MODE` — nothing runs until you deploy the container and flip the flag.

> B1 proves the *substrate* (container → clone → GLM-5.2 → PR). The full `Sigilix/agent` engine (B2), the Linear assignee trigger (B3), and per-org caps / portal BYO-key (B4) are later sub-projects. B1's in-container loop is intentionally minimal.

## Architecture

- `src/do/agent-runner-container.ts` — `AgentRunnerContainer extends Container` (DO-backed; holds the run record in SQLite).
- `container/` — the in-container Node task-runner (clone → GLM-5.2 edit-loop → commit/push → open PR), built from `container/Dockerfile`.
- `src/lib/agent-runner/dispatch.ts` — `dispatchAgentRun(env, input)` mints a short-lived GitHub App installation token and hands the task packet to the container; `getAgentRunStatus(env, runId)` reads the run record.

## Prerequisites

1. **Workers Paid plan** — Cloudflare Containers require it (you already run DOs/Queues, which also need Paid, so this is almost certainly already true — just confirm).
2. **Docker available** (locally, or rely on Cloudflare's image build) so `wrangler deploy` can build + push the `container/Dockerfile` image (`linux/amd64`).
3. **An OpenRouter key with `z-ai/glm-5.2` access + credits** — confirm `OPENROUTER_API_KEY` can call `z-ai/glm-5.2` (1M context, ~$0.95/M in, ~$3/M out). This is the hosted-default model key; a portal BYO-key (B4) overrides it per task.
4. **GitHub App** — `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` already exist; the App must be installed on any repo a run targets (the dispatch mints a single-repo, ~1h installation token per run).

## Deploy steps

1. `npm install` (pulls `@cloudflare/containers`).
2. **One-time, non-versioned deploy for the new Durable Object migration** (the CF error 10211 gotcha — a `versions upload` / Workers Build cannot apply a new-`new_sqlite_classes` migration):
   ```
   npx wrangler deploy
   ```
   This applies the `sig-545-agent-runner-v1` migration (`new_sqlite_classes = ["AgentRunnerContainer"]`) and builds + pushes the container image. Subsequent deploys can go through the normal pipeline.
3. Keep the flag **off** for now: `OPENCLAW_AGENT_RUNNER_MODE` unset (or `"off"`) → `dispatchAgentRun` is inert (mints nothing, touches no container).

## Live smoke (prove the substrate)

1. Set `OPENCLAW_AGENT_RUNNER_MODE = "on"` (a `[vars]` entry) + ensure the OpenRouter key is set.
2. From a trusted internal caller, `dispatchAgentRun(env, { runId, owner, repo, baseBranch, installationId, ticket, model: { id: "z-ai/glm-5.2", key }, caps })` against a **throwaway repo** (the GitHub App installed) with a small, well-scoped ticket.
3. Confirm: a `sigilix/<ticket-id>` branch + a PR appear on the throwaway repo. `getAgentRunStatus(env, runId)` returns `{ status: "opened", prUrl, ... }`. A no-op ticket → `no-change` (no PR). A failure → `error` (honest, token-redacted).

## Cost (reference)

CF Container compute ≈ **~1¢/task** (`standard-1`, ~10 min); the first ~35 tasks/month are within the Workers-Paid free allotment. The real cost is GLM-5.2 inference (~$0.45–$1.25/task), gated by B4's per-org caps + the BYO-key path. See `docs/superpowers/specs/2026-06-27-linear-assign-implement-design.md` for the full cost/tiering model.

## Safety properties (built in)

- **Dark by default** — `off` ⇒ no token minted, no container touched.
- **Short-lived, single-repo token** per run; the container holds no long-lived creds; the token + the model key are **never logged** (redacted from any error).
- **Recall-safe statuses** — `error`/`no-change` never masquerade as `opened`; a no-op makes no PR.
- **Caps enforced in the container** (model-call / token / wall-clock) as defense-in-depth; org-level caps + a global ceiling + a kill-switch land in B4 before broad use.
