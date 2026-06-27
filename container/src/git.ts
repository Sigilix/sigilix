/**
 * Thin wrappers over the `git` CLI for use inside the Cloudflare Container
 * task-runner.  Each function calls `execFile("git", ...)` and rejects with
 * a plain Error on non-zero exit.
 *
 * TOKEN SAFETY: installation tokens appear only in authed URLs passed to git.
 * They are never written to stdout/stderr.  Any caught git error whose message
 * contains the raw token has it replaced with `***` before re-throwing.
 */

import { execFile } from "node:child_process";

type ExecResult = { stdout: string; stderr: string };

function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Replace every occurrence of `token` in `s` with `***`. */
export function redactToken(s: string, token: string): string {
  if (!token) return s;
  return s.split(token).join("***");
}

function buildAuthedUrl(url: string, token: string): string {
  return url.replace("https://", `https://x-access-token:${token}@`);
}

function redactedError(err: unknown, token: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(redactToken(raw, token));
}

/**
 * Shallow-clone `branch` of `url` into `dir`, authenticated via `token`.
 * The token is embedded as `x-access-token:<token>@` in the clone URL and
 * is redacted from any rethrown git error message.
 */
export async function cloneRepo(args: {
  url: string;
  token: string;
  dir: string;
  branch: string;
}): Promise<void> {
  const { url, token, dir, branch } = args;
  const authedUrl = buildAuthedUrl(url, token);
  try {
    await exec("git", ["clone", "--depth=1", "--branch", branch, authedUrl, dir]);
  } catch (err) {
    throw redactedError(err, token);
  }
}

/** `git -C <dir> checkout -b <name>` */
export async function createBranch(dir: string, name: string): Promise<void> {
  await exec("git", ["-C", dir, "checkout", "-b", name]);
}

/**
 * Stage all changes (`git add -A`) and commit with the given author.
 * Returns `{ committed: false }` when the working tree is already clean so
 * the caller avoids opening a PR for a no-op run.
 */
export async function commitAll(
  dir: string,
  message: string,
  author: { name: string; email: string }
): Promise<{ committed: boolean }> {
  await exec("git", ["-C", dir, "add", "-A"]);
  const { stdout } = await exec("git", ["-C", dir, "diff", "--cached", "--name-only"]);
  if (!stdout.trim()) {
    return { committed: false };
  }
  await exec("git", [
    "-C",
    dir,
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "-m",
    message,
  ]);
  return { committed: true };
}

/**
 * Push branch `name` to `url` authenticated via `token`.
 * The token is redacted from any rethrown git error message.
 */
export async function pushBranch(args: {
  dir: string;
  name: string;
  token: string;
  url: string;
}): Promise<void> {
  const { dir, name, token, url } = args;
  const authedUrl = buildAuthedUrl(url, token);
  try {
    await exec("git", ["-C", dir, "push", authedUrl, name]);
  } catch (err) {
    throw redactedError(err, token);
  }
}
