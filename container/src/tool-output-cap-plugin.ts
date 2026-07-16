/**
 * Tool-output cap plugin (agent-runner hygiene).
 *
 * An opencode plugin (the CLI is an opencode fork) that truncates oversized
 * list-style tool results in a `tool.execute.after` hook, so a broad grep/glob/
 * list can't dump tens of thousands of chars that then ride along in every
 * subsequent model call. Verified against the real @sigilix/cli 1.17.14 binary:
 * mutating `output.output` in this hook DOES change what the model sees.
 *
 * Unlike the grounding plugin this is ALWAYS provisioned (cli-agent.ts adds it to
 * the opencode config's `plugin` array unconditionally) — the bloat is worst on
 * UNGROUNDED runs, where a blind model greps the most, which is exactly when the
 * grounding plugin is absent. Pure capping logic lives in tool-output-cap.ts;
 * this file is the thin hook shell.
 */

import { type Plugin } from "@opencode-ai/plugin";

import { CAPPED_TOOLS, capToolOutput } from "./tool-output-cap.js";

/** Grounding is active this run iff buildCliEnv injected the full retrieve_codebase
 *  wiring — only then does the `retrieve_codebase` tool exist, so only then should
 *  the truncation notice suggest it (see cli-agent buildCliEnv / isGroundingActive). */
function groundingActive(): boolean {
  return !!(process.env.SIGILIX_ENDPOINT && process.env.SIGILIX_API_KEY && process.env.SIGILIX_REPO_SLUG);
}

export const SigilixToolOutputCap: Plugin = async () => {
  console.error("[sigilix-toolcap] plugin loaded");
  const suggestRetrieval = groundingActive();
  return {
    "tool.execute.after": async (input: { tool: string }, output: { output: string }) => {
      if (!CAPPED_TOOLS.has(input.tool)) return;
      const before = output.output;
      const capped = capToolOutput(input.tool, before, { suggestRetrieval });
      if (typeof capped === "string" && capped !== before) {
        output.output = capped;
        // No secrets in a grep/glob result path; length-only marker aids the
        // run-diagnostics stderr tail without leaking content.
        console.error(`[sigilix-toolcap] ${input.tool} ${before.length}->${capped.length}`);
      }
    },
  };
};
