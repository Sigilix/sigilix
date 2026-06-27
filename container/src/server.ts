/**
 * Entry-point HTTP server for the Sigilix agent-runner container.
 *
 * POST /  — receives a task packet, orchestrates the full clone→edit→PR
 *            pipeline, and returns the run result as JSON.
 * GET /health — returns 200 "ok" (container readiness probe).
 *
 * TOKEN SAFETY: installationToken and model.key are NEVER logged or
 * surfaced in error output.  All errors are redacted before returning.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { cloneRepo, createBranch, commitAll, pushBranch } from "./git.js";
import { runEditLoop } from "./agent-loop.js";
import type { StoppedReason } from "./agent-loop.js";
import { openPullRequest } from "./github-pr.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface TaskPacket {
  runId: string;
  repo: {
    owner: string;
    name: string;
    /** Short-lived GitHub App installation token — never logged. */
    installationToken: string;
    baseBranch: string;
  };
  ticket: {
    identifier: string;
    title: string;
    body: string;
    url: string;
  };
  /** Optional grounding context string assembled from /v1/context. */
  grounding?: string;
  model: {
    provider?: string;
    id: string;
    /** Model API key — never logged. */
    key: string;
  };
  caps: {
    maxModelCalls: number;
    maxTokens: number;
    timeoutMs: number;
  };
}

export interface RunResult {
  runId: string;
  status: "opened" | "no-change" | "error";
  prUrl?: string;
  error?: string;
  modelCalls: number;
  tokens: number;
  stoppedReason: StoppedReason;
}

// ── Orchestration (unit-testable without a live HTTP server) ──────────────────

export async function runTask(packet: TaskPacket): Promise<RunResult> {
  const { runId, repo, ticket, grounding, model, caps } = packet;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigilix-run-"));

  let modelCalls = 0;
  let tokens = 0;
  // Default to "error" — updated once the edit loop completes.
  let loopStoppedReason: StoppedReason = "error";

  try {
    const repoUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
    const branchName = `sigilix/${ticket.identifier}`;

    // 1. Clone the base branch (shallow).
    await cloneRepo({
      url: repoUrl,
      token: repo.installationToken,
      dir: tmpDir,
      branch: repo.baseBranch,
    });

    // 2. Check out the feature branch.
    await createBranch(tmpDir, branchName);

    // 3. Run the minimal GLM edit loop.
    const loopResult = await runEditLoop({
      dir: tmpDir,
      ticket: {
        identifier: ticket.identifier,
        title: ticket.title,
        body: ticket.body,
      },
      // exactOptionalPropertyTypes: only include grounding when it has a value.
      ...(grounding !== undefined ? { grounding } : {}),
      model,
      caps,
    });

    modelCalls = loopResult.modelCalls;
    tokens = loopResult.tokens;
    loopStoppedReason = loopResult.stoppedReason;

    if (!loopResult.changed) {
      // No files were modified — don't open a spurious PR.
      return {
        runId,
        status: "no-change",
        modelCalls,
        tokens,
        stoppedReason: loopResult.stoppedReason,
      };
    }

    // 4. Commit all changes.
    const commitMsg = `${ticket.identifier}: ${ticket.title}\n\nImplemented by Sigilix from ${ticket.url}`;
    await commitAll(tmpDir, commitMsg, { name: "Sigilix", email: "agent@sigilix.ai" });

    // 5. Push the feature branch.
    await pushBranch({
      dir: tmpDir,
      name: branchName,
      token: repo.installationToken,
      url: repoUrl,
    });

    // 6. Open the PR.
    const prBody = [
      `Implements ${ticket.identifier}: ${ticket.title}`,
      "",
      `Implemented by Sigilix from ${ticket.url}`,
      "",
      `Closes ${ticket.url}`,
    ].join("\n");

    const pr = await openPullRequest({
      owner: repo.owner,
      repo: repo.name,
      token: repo.installationToken,
      head: branchName,
      base: repo.baseBranch,
      title: `${ticket.identifier}: ${ticket.title}`,
      body: prBody,
    });

    return {
      runId,
      status: "opened",
      prUrl: pr.url,
      modelCalls,
      tokens,
      stoppedReason: loopResult.stoppedReason,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Redact the installation token from any surfaced error message.
    const safeMsg = repo.installationToken
      ? rawMsg.split(repo.installationToken).join("***")
      : rawMsg;

    return {
      runId,
      status: "error",
      error: safeMsg,
      modelCalls,
      tokens,
      stoppedReason: loopStoppedReason,
    };
  } finally {
    // Always clean up the temp dir, success or failure.
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Readiness probe
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // Task dispatch
  if (req.method === "POST" && req.url === "/") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");

    let packet: TaskPacket;
    try {
      packet = JSON.parse(rawBody) as TaskPacket;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }

    const result = await runTask(packet);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((err: unknown) => {
    // Log errors without secrets (no packet values reach here)
    console.error(
      "[server] unhandled error:",
      err instanceof Error ? err.message : String(err),
    );
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error" }));
    }
  });
});

server.listen(8080, () => {
  console.log("[server] listening on :8080");
});
