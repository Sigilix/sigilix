/**
 * Sigilix grounding plugin (SIG-545 B2) — the multi-hop half of runner grounding.
 *
 * An opencode plugin (the CLI is an opencode fork) that registers a
 * `retrieve_codebase` tool the agent can call REPEATEDLY as it works, pulling the
 * most relevant code + team conventions from this repo's Sigilix index via the
 * Worker's /v1/context (hybrid retrieval + memory). This is what makes the runner
 * genuinely grounded and multi-hop, versus the single-shot context the worker
 * pre-assembles into the prompt.
 *
 * Provisioned into the image and pointed at by SIGILIX_GROUNDING_PLUGIN
 * (cli-agent.ts adds it to the opencode config's `plugin` array and injects
 * SIGILIX_ENDPOINT / SIGILIX_API_KEY / SIGILIX_REPO_SLUG into the child env only
 * when this plugin is provisioned). All network + parsing lives in the pure,
 * unit-tested `retrieveCodebase` (grounding.ts); this file is the thin API shell.
 */

import { type Plugin, tool } from "@opencode-ai/plugin";

import { groundingConfigFromEnv, retrieveCodebase } from "./grounding.js";

export const SigilixGrounding: Plugin = async () => {
  return {
    tool: {
      retrieve_codebase: tool({
        description:
          "Retrieve the most relevant code, symbols, and team conventions from THIS repository's " +
          "Sigilix index for a natural-language query. Prefer this over reading whole files: it is " +
          "cheaper and more precise. Call it before editing, and again whenever you need more context.",
        args: {
          query: tool.schema
            .string()
            .describe("What to find, in natural language (e.g. 'where the export endpoint validates its input')."),
        },
        async execute(args: { query: string }) {
          return retrieveCodebase(groundingConfigFromEnv(), args.query);
        },
      }),
    },
  };
};
