import { describe, expect, it } from "vitest";

import { CAPPED_TOOLS, DEFAULT_TOOL_OUTPUT_CAP, capToolOutput } from "./tool-output-cap.js";

describe("capToolOutput", () => {
  it("passes through tools that are not list-style search tools (read is never capped)", () => {
    const big = "x".repeat(DEFAULT_TOOL_OUTPUT_CAP * 2);
    expect(capToolOutput("read", big)).toBe(big);
    expect(capToolOutput("edit", big)).toBe(big);
    expect(capToolOutput("retrieve_codebase", big)).toBe(big);
  });

  it("caps only grep and glob (this CLI fork has no `list` tool — listing goes through read)", () => {
    expect(new Set(CAPPED_TOOLS)).toEqual(new Set(["grep", "glob"]));
  });

  it("passes through a capped tool whose output already fits", () => {
    const small = "Found 2 matches\na.ts:1\nb.ts:2";
    expect(capToolOutput("grep", small)).toBe(small);
    // Exactly at the cap is still fine (only strictly-over is truncated).
    const exact = "y".repeat(DEFAULT_TOOL_OUTPUT_CAP);
    expect(capToolOutput("grep", exact)).toBe(exact);
  });

  it("keeps BOTH the head and the tail of an oversized result (recall-safe — a match at the end survives)", () => {
    const head = "H".repeat(20000);
    const middle = "M".repeat(20000);
    const tail = "T".repeat(20000);
    const out = capToolOutput("grep", head + middle + tail) as string;
    // First and last portions are preserved; the middle is elided.
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toContain("HHHH");
    expect(out).toContain("TTTT");
    expect(out).toContain("elided from the middle");
    // Bounded to ≈ the cap (content + a small notice), far below the 60k input.
    expect(out.length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_CAP + 400);
    expect(out.length).toBeLessThan(60000);
  });

  it("suggests retrieve_codebase ONLY when grounding is active for the run", () => {
    const huge = "m".repeat(DEFAULT_TOOL_OUTPUT_CAP + 5000);
    const grounded = capToolOutput("grep", huge, { suggestRetrieval: true }) as string;
    expect(grounded).toContain("retrieve_codebase");
    // Ungrounded (default) → no mention of a tool that doesn't exist that run.
    const bare = capToolOutput("grep", huge) as string;
    expect(bare).not.toContain("retrieve_codebase");
    // Both still give the always-valid advice.
    expect(bare).toContain("Narrow the search");
  });

  it("honors a custom cap", () => {
    const out = capToolOutput("glob", "z".repeat(5000), { cap: 1000 }) as string;
    expect(out.length).toBeLessThanOrEqual(1000 + 400);
    expect(out).toContain("elided from the middle");
  });

  it("passes through non-string output untouched (never coerces)", () => {
    const obj = { matches: 100 };
    expect(capToolOutput("grep", obj)).toBe(obj);
    expect(capToolOutput("grep", undefined)).toBe(undefined);
  });
});
