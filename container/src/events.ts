// Live run-events (step 2 of the portal diff pane). As the minimal edit loop
// writes files, we compute each file's unified diff with `git diff` and POST it
// to the Worker's ingest route, authenticated by the per-run secret from the
// task packet. Entirely BEST-EFFORT: any failure (git, network, timeout) is
// swallowed — streaming must NEVER break or slow a run to a fault.

import { execFile } from "node:child_process";

export interface EventsConfig {
  /** Full ingest URL: {base}/internal/agent-runs/:runId/events */
  url: string;
  /** Per-run secret; sent as x-sigilix-run-secret. NEVER logged. */
  secret: string;
}

function execGit(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? "" : stdout);
      },
    );
  });
}

/** Count added/removed lines in a unified-diff patch (ignores +++/--- headers). */
export function countChanges(patch: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Emit one file-edit event for `relPath` after it was written. Uses
 * `git add --intent-to-add` so a brand-new file also shows as a diff, then
 * `git diff` for the unified patch. No-ops silently when events are unconfigured
 * or the diff is empty; never throws.
 */
export async function emitFileEdit(
  events: EventsConfig | undefined,
  dir: string,
  relPath: string,
): Promise<void> {
  if (!events) return;
  try {
    // intent-to-add makes untracked (new) files appear in `git diff`; harmless
    // for already-tracked files, and the final commit re-adds everything anyway.
    await execGit(dir, ["add", "--intent-to-add", "--", relPath]);
    const patch = await execGit(dir, [
      "diff",
      "--unified=3",
      "--no-color",
      "--",
      relPath,
    ]);
    if (!patch.trim()) return;
    // Cap the patch so a giant file can't exceed the ingest limit (matches the
    // Worker's MAX_EVENT_PATCH_BYTES); an over-large diff is simply skipped.
    if (patch.length > 200_000) return;
    const { additions, deletions } = countChanges(patch);
    await fetch(events.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sigilix-run-secret": events.secret,
      },
      body: JSON.stringify({
        type: "file-edit",
        path: relPath,
        patch,
        additions,
        deletions,
      }),
    });
  } catch {
    // best-effort: never let streaming break the run.
  }
}
