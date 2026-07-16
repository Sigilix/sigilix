import { describe, it, expect, vi, afterEach } from "vitest";

import { groundingConfigFromEnv, retrieveCodebase, type GroundingConfig } from "./grounding.js";

const OK: GroundingConfig = {
  endpoint: "https://api.sigilix.ai",
  apiKey: "sk-agent-secret",
  repoSlug: "Sigilix/sigilix",
};

afterEach(() => vi.restoreAllMocks());

describe("groundingConfigFromEnv", () => {
  it("reads the SIGILIX_* child-env vars the runner injects", () => {
    expect(
      groundingConfigFromEnv({
        SIGILIX_ENDPOINT: "https://api.sigilix.ai",
        SIGILIX_API_KEY: "k",
        SIGILIX_REPO_SLUG: "o/r",
      } as NodeJS.ProcessEnv),
    ).toEqual({ endpoint: "https://api.sigilix.ai", apiKey: "k", repoSlug: "o/r" });
  });
});

describe("retrieveCodebase", () => {
  it("POSTs /v1/context with the bearer + {owner,repo,query} and returns the grounded context", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ context: "GROUNDED SLICE" }), { status: 200 }));
    const out = await retrieveCodebase(OK, "where export validates input");
    expect(out).toBe("GROUNDED SLICE");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sigilix.ai/v1/context");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-agent-secret" });
    expect(JSON.parse(String(init.body))).toEqual({
      owner: "Sigilix",
      repo: "sigilix",
      query: "where export validates input",
    });
  });

  it("normalizes a trailing slash on the endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ context: "x" }), { status: 200 }));
    await retrieveCodebase({ ...OK, endpoint: "https://api.sigilix.ai/" }, "q");
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[0]).toBe("https://api.sigilix.ai/v1/context");
  });

  it("fails soft (no throw) when grounding config is missing", async () => {
    expect(await retrieveCodebase({}, "q")).toMatch(/not configured/i);
    expect(await retrieveCodebase({ ...OK, repoSlug: "no-slash" }, "q")).toMatch(/misconfigured/i);
  });

  it("fails soft on an empty query without calling the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await retrieveCodebase(OK, "   ")).toMatch(/non-empty query/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails soft on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    expect(await retrieveCodebase(OK, "q")).toMatch(/HTTP 503/);
  });

  it("fails soft (never throws) on a network/timeout error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("aborted"));
    expect(await retrieveCodebase(OK, "q")).toMatch(/timed out or errored/i);
  });

  it("returns a clear message when the index has no match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ context: "" }), { status: 200 }));
    expect(await retrieveCodebase(OK, "q")).toMatch(/no matching code/i);
  });
});
