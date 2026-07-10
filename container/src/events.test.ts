import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execMock = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execMock.execFile }));

import { countChanges, emitFileEdit } from "./events.js";

describe("countChanges", () => {
  it("counts +/- lines and ignores the +++/--- headers", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,3 @@",
      " ctx",
      "-old",
      "+new1",
      "+new2",
    ].join("\n");
    expect(countChanges(patch)).toEqual({ additions: 2, deletions: 1 });
  });

  it("is zero for an empty patch", () => {
    expect(countChanges("")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("emitFileEdit", () => {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }),
  );

  beforeEach(() => {
    execMock.execFile.mockReset();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("no-ops (no git, no fetch) when events are unconfigured", async () => {
    await emitFileEdit(undefined, "/tmp/repo", "a.ts");
    expect(execMock.execFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the file's diff with the run secret when configured", async () => {
    // add --intent-to-add → "", diff → a patch.
    execMock.execFile.mockImplementation((_file, args, _opts, cb) => {
      const out = (args as string[]).includes("diff")
        ? "@@ -1 +1 @@\n-old\n+new\n"
        : "";
      cb(null, out, "");
    });
    await emitFileEdit(
      { url: "https://api.x/internal/agent-runs/r/events", secret: "s3cr3t" },
      "/tmp/repo",
      "a.ts",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.x/internal/agent-runs/r/events");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-sigilix-run-secret"]).toBe(
      "s3cr3t",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      type: "file-edit",
      path: "a.ts",
      additions: 1,
      deletions: 1,
    });
    expect(body.patch).toContain("+new");
  });

  it("does not POST when the diff is empty (no real change)", async () => {
    execMock.execFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, "", ""),
    );
    await emitFileEdit({ url: "https://api.x/e", secret: "s" }, "/tmp/repo", "a.ts");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
