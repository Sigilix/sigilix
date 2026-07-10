/**
 * Minimal in-container GLM-5.2 edit-loop.
 *
 * Calls a model via an OpenAI-compatible chat-completions endpoint (OpenRouter
 * by default, or Ollama Turbo when model.baseUrl is "https://ollama.com/v1") in
 * a bounded tool-use loop. Tools operate within a sandboxed repo dir; paths that
 * escape are rejected.
 *
 * TOKEN SAFETY: model.key is placed only in the Authorization header and is
 * never written to any log, error message, or tool result.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { emitFileEdit, type EventsConfig } from "./events.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface EditLoopArgs {
  /** Absolute path to the cloned repo working directory. */
  dir: string;
  ticket: { identifier: string; title: string; body: string };
  /** Optional assembled context string (grounding). */
  grounding?: string;
  /** model.id e.g. "z-ai/glm-5.2"; model.key is NEVER logged. */
  model: { id: string; key: string; baseUrl?: string };
  caps: { maxModelCalls: number; maxTokens: number; timeoutMs: number };
  /** Live-events sink: when set, each write streams a file-edit diff to the
   *  Worker for the portal's diff pane. Best-effort; absent → no streaming. */
  events?: EventsConfig;
}

export type StoppedReason =
  | "done"
  | "cap-calls"
  | "cap-tokens"
  | "timeout"
  | "error";

export interface EditLoopResult {
  /** true iff at least one write_file call succeeded. */
  changed: boolean;
  modelCalls: number;
  tokens: number;
  stoppedReason: StoppedReason;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max characters returned by read_file. */
const READ_SIZE_CAP = 32_000;

/** Max characters returned by run_cmd. */
const CMD_OUTPUT_CAP = 8_000;

/**
 * Allow-list for run_cmd.  Key = executable name; value = allowed
 * first-argument (sub-command).  Everything else is rejected.
 */
const ALLOWED_EXECUTABLES: Record<string, Set<string>> = {
  npm: new Set(["test", "run", "build"]),
  pnpm: new Set(["test", "run", "build"]),
};

// ── Internal OpenRouter types ─────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "assistant"; content: string | null }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

interface OpenRouterResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the repo directory (or a sub-path).",
      parameters: {
        type: "object",
        properties: {
          subpath: {
            type: "string",
            description: "Relative sub-path to list (omit for repo root).",
          },
        },
        required: [] as string[],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the repo.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (overwrite) a file in the repo.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
          content: { type: "string", description: "New content of the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_cmd",
      description:
        "Run an allow-listed build/test command (npm or pnpm) in the repo dir. " +
        "No shell expansion — args are passed directly to execFile.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "Executable: npm or pnpm.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              'Arguments (e.g. ["test"] or ["run", "build"]).',
          },
        },
        required: ["cmd", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Signal that you have finished. Call this when the ticket is implemented.",
      parameters: {
        type: "object",
        properties: {},
        required: [] as string[],
      },
    },
  },
];

// ── Path guard ────────────────────────────────────────────────────────────────

/**
 * Lexical path guard (cheap, no I/O): resolve `rel` against `dir` and verify
 * it stays inside `dir`.  Returns the absolute path, or null if it escapes.
 * Used as the first gate by safeResolve.
 */
function guardPath(dir: string, rel: string): string | null {
  const abs = path.resolve(dir, rel);
  const base = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (abs !== dir && !abs.startsWith(base)) return null;
  return abs;
}

/**
 * Realpath-hardened path resolver.
 *
 * First applies a cheap lexical check (guardPath), then verifies that the
 * path — or its nearest existing ancestor — resolves (via fs.realpath) inside
 * the realpath of `dir`.  This prevents symlink traversal escapes.
 *
 * mode "read"  — walks up from `abs` to the nearest existing ancestor and
 *                realpaths it.  Rejects if the ancestor escapes OR if realpath
 *                throws on a dangling symlink (symlink exists but target does
 *                not).
 * mode "write" — walks up from path.dirname(abs) to find the nearest existing
 *                ancestor, verifies it resolves inside the sandbox.  Also
 *                rejects if the final path component already exists as a
 *                symlink that resolves outside.
 *
 * Returns the safe absolute path (lexically resolved) or null on rejection.
 */
async function safeResolve(
  dir: string,
  rel: string,
  mode: "read" | "write" = "read",
): Promise<string | null> {
  // 1. Lexical guard — cheap, no I/O
  const abs = guardPath(dir, rel);
  if (abs === null) return null;

  // 2. Compute the real sandbox root
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return null;
  }
  const realBase = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  const insideSandbox = (p: string): boolean =>
    p === realDir || p.startsWith(realBase);

  /**
   * Walk up from `start`, realpathing each candidate until we find an existing
   * entry.  Returns the realpath of the nearest existing ancestor, or null if
   * a dangling symlink is encountered or we reach the filesystem root.
   */
  async function nearestRealpath(start: string): Promise<string | null> {
    let check = start;
    while (true) {
      try {
        return await fs.realpath(check);
      } catch {
        // Distinguish "dangling symlink" from "path does not exist"
        try {
          await fs.lstat(check);
          // lstat succeeded but realpath failed → dangling symlink → reject
          return null;
        } catch {
          // lstat also failed → path truly does not exist → walk up
          const parent = path.dirname(check);
          if (parent === check) return null; // reached filesystem root
          check = parent;
        }
      }
    }
  }

  if (mode === "write") {
    // Verify the nearest existing ancestor of the parent directory is inside.
    const parentReal = await nearestRealpath(path.dirname(abs));
    if (parentReal === null || !insideSandbox(parentReal)) return null;

    // If the final component already exists as a symlink, verify its target.
    try {
      const lstat = await fs.lstat(abs);
      if (lstat.isSymbolicLink()) {
        try {
          const realFinal = await fs.realpath(abs);
          if (!insideSandbox(realFinal)) return null;
        } catch {
          // Dangling symlink on the write target — reject
          return null;
        }
      }
    } catch {
      // Final component does not exist yet — fine for a new file
    }

    return abs;
  } else {
    // Read mode: verify the nearest existing ancestor of abs is inside.
    const ancestorReal = await nearestRealpath(abs);
    if (ancestorReal === null || !insideSandbox(ancestorReal)) return null;
    return abs;
  }
}

// ── Tool executors ────────────────────────────────────────────────────────────

async function execListFiles(dir: string, subpath: string): Promise<string> {
  const target = await safeResolve(dir, subpath, "read");
  if (target === null) return "error: path escapes repo dir";
  try {
    const entries = await fs.readdir(target);
    return entries.join("\n") || "(empty)";
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function execReadFile(dir: string, filePath: string): Promise<string> {
  const abs = await safeResolve(dir, filePath, "read");
  if (abs === null) return "error: path escapes repo dir";
  try {
    const content = await fs.readFile(abs, "utf8");
    // Content is returned to the model but never logged
    return content.length > READ_SIZE_CAP
      ? content.slice(0, READ_SIZE_CAP) + "\n[...truncated]"
      : content;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function execWriteFile(
  dir: string,
  filePath: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const abs = await safeResolve(dir, filePath, "write");
  if (abs === null) return { ok: false, error: "path escapes repo dir" };
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Content is written to disk but never logged
    await fs.writeFile(abs, content, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function execRunCmd(
  dir: string,
  cmd: string,
  args: string[],
  deadline: number,
): Promise<string> {
  // Fix: use Object.hasOwn to avoid prototype-chain key collisions
  // (e.g. cmd="__proto__" would otherwise look up Object.prototype)
  if (!Object.hasOwn(ALLOWED_EXECUTABLES, cmd)) {
    return `error: executable '${cmd}' is not allow-listed`;
  }
  const allowed = ALLOWED_EXECUTABLES[cmd];

  const subCmd = args[0] ?? "";
  if (!allowed.has(subCmd)) {
    return `error: sub-command '${subCmd}' is not allow-listed for '${cmd}'`;
  }

  // Clamp the per-command timeout so it never exceeds the remaining loop budget
  const remaining = Math.max(0, Math.min(60_000, deadline - Date.now()));
  if (remaining === 0) {
    return "error: timed out";
  }

  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: dir, timeout: remaining }, (err, stdout, stderr) => {
      const combined = (stdout + "\n" + stderr).trim();
      const capped =
        combined.length > CMD_OUTPUT_CAP
          ? combined.slice(0, CMD_OUTPUT_CAP) + "\n[...truncated]"
          : combined;
      if (err) {
        resolve(`exit ${String(err.code ?? 1)}:\n${capped}`);
      } else {
        resolve(capped || "(no output)");
      }
    });
  });
}

// ── OpenRouter call ───────────────────────────────────────────────────────────

async function callModel(
  baseUrl: string,
  modelId: string,
  key: string,
  messages: ChatMessage[],
): Promise<OpenRouterResponse> {
  // key goes only into the Authorization header — never logged
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter HTTP ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<OpenRouterResponse>;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runEditLoop(args: EditLoopArgs): Promise<EditLoopResult> {
  const { dir, ticket, grounding, model, caps } = args;
  const baseUrl = model.baseUrl ?? "https://openrouter.ai/api/v1";

  let changed = false;
  let modelCalls = 0;
  let tokens = 0;

  const deadline = Date.now() + caps.timeoutMs;

  const userContent = [
    `# Ticket: ${ticket.identifier} — ${ticket.title}`,
    "",
    ticket.body,
    ...(grounding != null ? ["", "## Context", grounding] : []),
  ].join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are Sigilix implementing a ticket. Make the minimal change to satisfy the ticket, then call `done`.",
    },
    { role: "user", content: userContent },
  ];

  try {
    while (true) {
      if (Date.now() >= deadline) {
        return { changed, modelCalls, tokens, stoppedReason: "timeout" };
      }
      if (modelCalls >= caps.maxModelCalls) {
        return { changed, modelCalls, tokens, stoppedReason: "cap-calls" };
      }
      if (tokens >= caps.maxTokens) {
        return { changed, modelCalls, tokens, stoppedReason: "cap-tokens" };
      }

      let resp: OpenRouterResponse;
      try {
        resp = await callModel(baseUrl, model.id, model.key, messages);
      } catch {
        // Fatal model / network error — return, never throw out of the loop
        return { changed, modelCalls, tokens, stoppedReason: "error" };
      }

      modelCalls++;
      if (resp.usage) tokens += resp.usage.total_tokens;

      const choice = resp.choices[0];
      if (!choice) {
        return { changed, modelCalls, tokens, stoppedReason: "error" };
      }

      const msg = choice.message;
      const toolCalls = msg.tool_calls;

      // Append the assistant turn to history
      if (toolCalls && toolCalls.length > 0) {
        messages.push({ role: "assistant", content: msg.content, tool_calls: toolCalls });
      } else {
        messages.push({ role: "assistant", content: msg.content });
        // No tool calls — model finished with a text response
        return { changed, modelCalls, tokens, stoppedReason: "done" };
      }

      // Execute each tool call; stop immediately if the model calls `done`
      for (const tc of toolCalls) {
        const name = tc.function.name;

        if (name === "done") {
          return { changed, modelCalls, tokens, stoppedReason: "done" };
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          parsed = {};
        }

        let result: string;

        if (name === "list_files") {
          const sub = typeof parsed.subpath === "string" ? parsed.subpath : "";
          result = await execListFiles(dir, sub);
        } else if (name === "read_file") {
          const fp = typeof parsed.path === "string" ? parsed.path : "";
          result = await execReadFile(dir, fp);
        } else if (name === "write_file") {
          const fp = typeof parsed.path === "string" ? parsed.path : "";
          const content = typeof parsed.content === "string" ? parsed.content : "";
          const outcome = await execWriteFile(dir, fp, content);
          if (outcome.ok) {
            changed = true;
            result = "ok";
            // Stream this edit's diff to the portal (best-effort; never throws).
            await emitFileEdit(args.events, dir, fp);
          } else {
            result = `error: ${outcome.error ?? "unknown"}`;
          }
        } else if (name === "run_cmd") {
          const cmd = typeof parsed.cmd === "string" ? parsed.cmd : "";
          const cmdArgs = Array.isArray(parsed.args)
            ? (parsed.args as unknown[]).map(String)
            : [];
          result = await execRunCmd(dir, cmd, cmdArgs, deadline);
        } else {
          result = `error: unknown tool '${name}'`;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name,
          content: result,
        });
      }
    }
  } catch {
    return { changed, modelCalls, tokens, stoppedReason: "error" };
  }
}
