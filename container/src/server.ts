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
import { runCliAgent } from "./cli-agent.js";
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
    /**
     * OpenAI-compatible chat-completions base URL. Defaults to OpenRouter in
     * the edit loop; set to "https://ollama.com/v1" to run on Ollama Turbo.
     */
    baseUrl?: string;
  };
  caps: {
    maxModelCalls: number;
    maxTokens: number;
    timeoutMs: number;
  };
  /**
   * Which engine implements the task (SIG-545 B2). "minimal" (default) = the
   * bounded 5-tool edit loop; "full" = the Sigilix CLI agent run headless.
   */
  engine?: "minimal" | "full";
  /**
   * Grounding endpoint for the full CLI agent's sigilix-grounding plugin.
   * Ignored by the minimal engine. Keys NEVER logged.
   */
  sigilix?: {
    endpoint?: string;
    apiKey?: string;
    repoSlug?: string;
  };
  /**
   * Live-events sink for the portal diff pane. When present, the minimal loop
   * POSTs each file-edit diff to `url` with `secret` (x-sigilix-run-secret).
   * Absent → no streaming. `secret` NEVER logged.
   */
  events?: {
    url: string;
    secret: string;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Replace every non-empty secret value in `text` with "***".
 * Iterates all provided secrets so a single call covers every sensitive field.
 */
function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join("***");
    }
  }
  return result;
}

// ── Orchestration (unit-testable without a live HTTP server) ──────────────────

export async function runTask(packet: TaskPacket): Promise<RunResult> {
  const { runId, repo, ticket, grounding, model, caps } = packet;

  // Declared outside try so the finally block can guard on it.
  let tmpDir: string | undefined;
  let modelCalls = 0;
  let tokens = 0;
  // Default to "error" — updated once the edit loop completes.
  let loopStoppedReason: StoppedReason = "error";

  try {
    // Create the temp dir inside try so an mkdtemp failure returns
    // { status: "error" } instead of propagating a raw throw out of runTask.
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigilix-run-"));

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

    // 3. Run the selected engine: the minimal 5-tool GLM loop (default), or the
    //    full Sigilix CLI agent when packet.engine === "full" (SIG-545 B2).
    //    Both return the same EditLoopResult contract.
    const editArgs = {
      dir: tmpDir,
      ticket: {
        identifier: ticket.identifier,
        title: ticket.title,
        body: ticket.body,
      },
      // exactOptionalPropertyTypes: only include grounding when it has a value.
      ...(grounding !== undefined ? { grounding } : {}),
      // Live-events sink (portal diff pane); only the minimal loop reads it.
      ...(packet.events !== undefined ? { events: packet.events } : {}),
      model,
      caps,
    };
    const loopResult =
      packet.engine === "full"
        ? await runCliAgent({
            ...editArgs,
            ...(packet.sigilix !== undefined ? { sigilix: packet.sigilix } : {}),
          })
        : await runEditLoop(editArgs);

    modelCalls = loopResult.modelCalls;
    tokens = loopResult.tokens;
    loopStoppedReason = loopResult.stoppedReason;

    // For the full CLI agent, only open a PR on a clean completion. A SIGKILLed
    // (timeout) or errored run can leave a half-applied edit in the tree, so a
    // non-"done" stop must NOT become a PR from incomplete/broken work. The
    // minimal loop's writes are discrete and model-driven, so it keeps the
    // changed-based behavior (a partial-but-valid edit is still mergeable).
    if (packet.engine === "full" && loopResult.stoppedReason !== "done") {
      return {
        runId,
        status: "no-change",
        modelCalls,
        tokens,
        stoppedReason: loopResult.stoppedReason,
      };
    }

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
    const { committed } = await commitAll(tmpDir, commitMsg, { name: "Sigilix", email: "agent@sigilix.ai" });

    if (!committed) {
      // The loop reported changed=true (e.g. a byte-identical write) but the
      // working tree was actually clean — skip push and PR to avoid a GitHub 422.
      return {
        runId,
        status: "no-change",
        modelCalls,
        tokens,
        stoppedReason: loopResult.stoppedReason,
      };
    }

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
    // Redact all secrets from any surfaced error message.
    const safeMsg = redactSecrets(rawMsg, [repo.installationToken, model.key]);

    return {
      runId,
      status: "error",
      error: safeMsg,
      modelCalls,
      tokens,
      stoppedReason: loopStoppedReason,
    };
  } finally {
    // Clean up the temp dir only if it was successfully created.
    if (tmpDir !== undefined) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

/** Maximum accepted request-body size. Prevents memory exhaustion from huge payloads. */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

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
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += (chunk as Buffer).length;
      if (totalBytes > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large" }));
        return;
      }
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
