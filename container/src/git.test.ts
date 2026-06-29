import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures mockExecFile is created before vi.mock hoists the factory.
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { cloneRepo, commitAll, createBranch, pushBranch, redactToken } from "./git.js";

// ── helpers ──────────────────────────────────────────────────────────────────

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

/** Queue a successful execFile call that returns the given stdout. */
function ok(stdout = ""): void {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], cb: ExecCb) => cb(null, stdout, ""),
  );
}

/** Queue a failing execFile call whose error message contains `message`. */
function fail(message: string): void {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], cb: ExecCb) => cb(new Error(message), "", ""),
  );
}

/** Return the args array from the nth mock call (0-indexed). */
function callArgs(n: number): string[] {
  return (mockExecFile.mock.calls[n] as [string, string[]])[1];
}

// ── redactToken unit ──────────────────────────────────────────────────────────

describe("redactToken", () => {
  it("replaces every occurrence of the token", () => {
    expect(redactToken("tok123 and tok123", "tok123")).toBe("*** and ***");
  });

  it("returns the string unchanged when token is empty", () => {
    expect(redactToken("some string", "")).toBe("some string");
  });
});

// ── cloneRepo ─────────────────────────────────────────────────────────────────

describe("cloneRepo", () => {
  beforeEach(() => mockExecFile.mockReset());

  it("calls git clone with shallow flag, branch, authed URL, and target dir", async () => {
    ok();
    await cloneRepo({
      url: "https://github.com/owner/repo.git",
      token: "tok123",
      dir: "/workspace/repo",
      branch: "main",
    });

    expect(mockExecFile).toHaveBeenCalledOnce();
    const args = callArgs(0);
    expect(args).toContain("clone");
    expect(args).toContain("--depth=1");
    expect(args).toContain("--branch");
    expect(args).toContain("main");
    expect(args).toContain("/workspace/repo");

    const authedUrl = args.find((a) => a.includes("x-access-token"));
    expect(authedUrl).toBeDefined();
    expect(authedUrl).toContain("x-access-token:tok123@");
    expect(authedUrl).toContain("github.com/owner/repo.git");
  });

  it("redacts the token from a rethrown git error", async () => {
    fail("fatal: repository 'https://x-access-token:tok123@github.com/owner/repo.git' not found");

    let caughtMsg = "";
    try {
      await cloneRepo({
        url: "https://github.com/owner/repo.git",
        token: "tok123",
        dir: "/workspace/repo",
        branch: "main",
      });
    } catch (e) {
      caughtMsg = e instanceof Error ? e.message : String(e);
    }

    expect(caughtMsg).not.toContain("tok123");
    expect(caughtMsg).toContain("***");
    expect(caughtMsg).toContain("not found");
  });

  it("does not throw when git clone succeeds", async () => {
    ok();
    await expect(
      cloneRepo({ url: "https://github.com/owner/repo.git", token: "t", dir: "/d", branch: "main" }),
    ).resolves.toBeUndefined();
  });
});

// ── createBranch ──────────────────────────────────────────────────────────────

describe("createBranch", () => {
  beforeEach(() => mockExecFile.mockReset());

  it("calls git -C <dir> checkout -b <name>", async () => {
    ok();
    await createBranch("/workspace/repo", "sigilix/SIG-123");

    expect(mockExecFile).toHaveBeenCalledOnce();
    expect(callArgs(0)).toEqual(["-C", "/workspace/repo", "checkout", "-b", "sigilix/SIG-123"]);
  });
});

// ── commitAll ─────────────────────────────────────────────────────────────────

describe("commitAll", () => {
  beforeEach(() => mockExecFile.mockReset());

  it("returns { committed: true } and commits when staged changes exist", async () => {
    ok(); // git add -A
    ok("file.ts\nanother.ts\n"); // git diff --cached --name-only
    ok(); // git commit

    const result = await commitAll("/repo", "feat: something", {
      name: "Sigilix",
      email: "agent@sigilix.ai",
    });

    expect(result).toEqual({ committed: true });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("returns { committed: false } and skips commit when nothing is staged", async () => {
    ok(); // git add -A
    ok(""); // git diff --cached --name-only → empty

    const result = await commitAll("/repo", "feat: something", {
      name: "Sigilix",
      email: "agent@sigilix.ai",
    });

    expect(result).toEqual({ committed: false });
    // Only 2 calls: add + diff; no commit
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("also returns { committed: false } for whitespace-only diff output", async () => {
    ok(); // git add -A
    ok("   \n  \n"); // only whitespace

    const result = await commitAll("/repo", "msg", { name: "Bot", email: "bot@x.com" });
    expect(result).toEqual({ committed: false });
  });

  it("passes -c user.name and -c user.email to the commit call", async () => {
    ok(); // git add -A
    ok("changed.ts\n"); // diff
    ok(); // commit

    await commitAll("/repo", "fix: thing", { name: "Bot Name", email: "bot@example.com" });

    const commitArgs = callArgs(2);
    expect(commitArgs).toContain("-c");
    expect(commitArgs).toContain("user.name=Bot Name");
    expect(commitArgs).toContain("user.email=bot@example.com");
    expect(commitArgs).toContain("commit");
    expect(commitArgs).toContain("-m");
    expect(commitArgs).toContain("fix: thing");
  });

  it("includes -C <dir> in all three git calls", async () => {
    ok();
    ok("f.ts\n");
    ok();

    await commitAll("/my-repo", "msg", { name: "A", email: "a@b.com" });

    for (let i = 0; i < 3; i++) {
      const args = callArgs(i);
      expect(args).toContain("-C");
      expect(args).toContain("/my-repo");
    }
  });
});

// ── pushBranch ────────────────────────────────────────────────────────────────

describe("pushBranch", () => {
  beforeEach(() => mockExecFile.mockReset());

  it("calls git push with authed URL and branch name", async () => {
    ok();
    await pushBranch({
      dir: "/workspace/repo",
      name: "sigilix/SIG-123",
      token: "tok456",
      url: "https://github.com/owner/repo.git",
    });

    expect(mockExecFile).toHaveBeenCalledOnce();
    const args = callArgs(0);
    expect(args).toContain("push");
    expect(args).toContain("sigilix/SIG-123");

    const authedUrl = args.find((a) => a.includes("x-access-token"));
    expect(authedUrl).toBeDefined();
    expect(authedUrl).toContain("x-access-token:tok456@");
    expect(authedUrl).toContain("github.com/owner/repo.git");
  });

  it("redacts the token from a rethrown push error", async () => {
    fail("error: tok456 rejected (forbidden)");

    let caughtMsg = "";
    try {
      await pushBranch({
        dir: "/workspace/repo",
        name: "sigilix/SIG-123",
        token: "tok456",
        url: "https://github.com/owner/repo.git",
      });
    } catch (e) {
      caughtMsg = e instanceof Error ? e.message : String(e);
    }

    expect(caughtMsg).not.toContain("tok456");
    expect(caughtMsg).toContain("***");
  });

  it("does not throw when git push succeeds", async () => {
    ok();
    await expect(
      pushBranch({
        dir: "/d",
        name: "sigilix/X",
        token: "t",
        url: "https://github.com/o/r.git",
      }),
    ).resolves.toBeUndefined();
  });
});
