/**
 * Pure grounding retrieval for the Sigilix grounding plugin (SIG-545 B2).
 *
 * Isolated from the opencode plugin wrapper (grounding-plugin.ts) so the network
 * + parsing logic is unit-testable without the `@opencode-ai/plugin` runtime. The
 * plugin's `retrieve_codebase` tool is a thin shell over `retrieveCodebase`.
 *
 * FAIL-SOFT BY CONSTRUCTION: every path returns a short human-readable string and
 * NEVER throws — a grounding hiccup (missing config, timeout, HTTP error, bad
 * JSON) must degrade to "proceed with your best judgment", never crash the run.
 * The apiKey is used only as the Bearer header and is NEVER logged.
 */

export interface GroundingConfig {
  /** The Worker's public base (e.g. https://api.sigilix.ai). */
  endpoint?: string | undefined;
  /** Shared agent bearer. NEVER logged. */
  apiKey?: string | undefined;
  /** `owner/repo` the run targets. */
  repoSlug?: string | undefined;
}

/** Bound the call so a slow /v1/context can't stall the agent's tool turn. */
const CONTEXT_TIMEOUT_MS = 15_000;
const MAX_QUERY_CHARS = 4_000;

/** Read the grounding config the runner injects into the child env. */
export function groundingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GroundingConfig {
  return {
    endpoint: env.SIGILIX_ENDPOINT,
    apiKey: env.SIGILIX_API_KEY,
    repoSlug: env.SIGILIX_REPO_SLUG,
  };
}

/**
 * Retrieve the most relevant code + team conventions for `query` from the
 * Sigilix-indexed codebase via the Worker's POST /v1/context (hybrid retrieval +
 * memory). Returns the grounded context string, or a short fallback message.
 */
export async function retrieveCodebase(config: GroundingConfig, query: string): Promise<string> {
  const { endpoint, apiKey, repoSlug } = config;
  if (!endpoint || !apiKey || !repoSlug) {
    return "Codebase grounding is not configured for this run.";
  }
  const slash = repoSlug.indexOf("/");
  if (slash <= 0 || slash >= repoSlug.length - 1) {
    return "Codebase grounding is misconfigured (bad repo slug).";
  }
  const owner = repoSlug.slice(0, slash);
  const repo = repoSlug.slice(slash + 1);
  // Honor the "never throws" contract independent of the caller: a non-string
  // query (however the tool runtime hands it over) degrades, it never throws.
  const trimmed = typeof query === "string" ? query.trim().slice(0, MAX_QUERY_CHARS) : "";
  if (trimmed.length === 0) {
    return "Provide a non-empty query describing what to find.";
  }
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/context`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ owner, repo, query: trimmed }),
      signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return `Retrieval failed (HTTP ${res.status}). Proceed with your best judgment.`;
    }
    const json = (await res.json()) as { context?: string | null };
    const context = typeof json.context === "string" ? json.context.trim() : "";
    return context.length > 0 ? context : "No matching code found for that query.";
  } catch {
    // Timeout / network / parse error — never surface the key or throw.
    return "Retrieval timed out or errored. Proceed with your best judgment.";
  }
}
