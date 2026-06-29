import { afterEach, describe, expect, it, vi } from "vitest";

import { openPullRequest } from "./github-pr.js";

// ── helpers ───────────────────────────────────────────────────────────────────

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function stubFetch(resp: FakeResponse): void {
  vi.stubGlobal(
    "fetch",
    async (): Promise<FakeResponse> => resp,
  );
}

const DEFAULT_ARGS = {
  owner: "acme",
  repo: "my-service",
  token: "ghp_super_secret",
  head: "sigilix/SIG-123",
  base: "main",
  title: "SIG-123: fix the thing",
  body: "Closes https://linear.app/acme/issue/SIG-123",
};

// ── tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openPullRequest", () => {
  it("POSTs to the correct GitHub API URL", async () => {
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string | URL): Promise<FakeResponse> => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/my-service/pull/7", number: 7 }),
        text: async () => "",
      };
    });

    await openPullRequest(DEFAULT_ARGS);

    expect(capturedUrl).toBe("https://api.github.com/repos/acme/my-service/pulls");
  });

  it("sends the required GitHub headers and body", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      async (_url: string | URL, init?: RequestInit): Promise<FakeResponse> => {
        capturedInit = init;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: "https://github.com/acme/my-service/pull/7",
            number: 7,
          }),
          text: async () => "",
        };
      },
    );

    await openPullRequest(DEFAULT_ARGS);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["Authorization"]).toBe("Bearer ghp_super_secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toMatch(/sigilix/i);

    const sentBody = JSON.parse(capturedInit?.body as string) as {
      title: string;
      head: string;
      base: string;
      body: string;
    };
    expect(sentBody.title).toBe(DEFAULT_ARGS.title);
    expect(sentBody.head).toBe("sigilix/SIG-123");
    expect(sentBody.base).toBe("main");
    expect(sentBody.body).toBe(DEFAULT_ARGS.body);
  });

  it("parses html_url and number from the GitHub response", async () => {
    stubFetch({
      ok: true,
      status: 201,
      json: async () => ({
        html_url: "https://github.com/acme/my-service/pull/42",
        number: 42,
        // extra fields ignored
        id: 99999,
      }),
      text: async () => "",
    });

    const result = await openPullRequest(DEFAULT_ARGS);

    expect(result.url).toBe("https://github.com/acme/my-service/pull/42");
    expect(result.number).toBe(42);
  });

  it("throws on a non-2xx response with the status code in the message", async () => {
    stubFetch({
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () => "Validation Failed: head does not exist",
    });

    let caught = "";
    try {
      await openPullRequest(DEFAULT_ARGS);
    } catch (e) {
      caught = e instanceof Error ? e.message : String(e);
    }

    expect(caught).toContain("422");
    expect(caught).toContain("Validation Failed");
  });

  it("never includes the token in a thrown error message", async () => {
    const SECRET = "ghp_super_secret";
    stubFetch({
      ok: false,
      status: 401,
      json: async () => ({}),
      // Simulate a response body that echoes the token (defensive test)
      text: async () => `Bad credentials: ${SECRET} is invalid`,
    });

    let caught = "";
    try {
      await openPullRequest({ ...DEFAULT_ARGS, token: SECRET });
    } catch (e) {
      caught = e instanceof Error ? e.message : String(e);
    }

    expect(caught).not.toContain(SECRET);
    // The token should be redacted
    expect(caught).toContain("***");
    expect(caught).toContain("401");
  });
});
