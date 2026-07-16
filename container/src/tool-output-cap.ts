/**
 * Tool-output cap (agent-runner hygiene) — pure logic.
 *
 * List-style search tools (grep/glob) dump every match. On a broad query that
 * can be tens of thousands of chars, which then rides along in EVERY subsequent
 * model call and balloons cost (observed: one `grep` returned 100 matches /
 * ~24k chars and dominated a run's token spend — under the CLI's own 50KB native
 * bound, so it was never trimmed). Capping the result the model sees bounds that
 * blast radius.
 *
 * We keep the FIRST and LAST portions (head + tail), not just the head, so a
 * needed match at the END of a large result isn't silently lost — mirroring the
 * CLI's own native output bound, which also samples both ends. Only the middle
 * is elided, and the notice tells the model to narrow the search.
 *
 * Capped tools = the list-style search tools ONLY: `grep` and `glob`. `read` is
 * left alone (it has offset/limit pagination, a large read is often deliberate,
 * and directory listing in this CLI fork goes through `read` too). The plugin
 * shell (tool-output-cap-plugin.ts) applies this in an opencode
 * `tool.execute.after` hook; all logic lives here so it is unit-tested alone.
 */

/** Tools whose output is a match/entry LIST a broad query can blow up. In this
 *  CLI fork the built-in list-style search tools are `grep` and `glob` (there is
 *  no `list` tool — directory listing goes through `read`, which we don't cap). */
export const CAPPED_TOOLS: ReadonlySet<string> = new Set(["grep", "glob"]);

/** Char budget for a single capped tool result. ~8k chars ≈ a couple thousand
 *  tokens — enough to show many matches, small enough that carrying it across a
 *  multi-step run doesn't dominate the budget. */
export const DEFAULT_TOOL_OUTPUT_CAP = 8000;

/** Chars reserved for the truncation notice so head+tail content stays within
 *  the cap. The notice is bounded well under this. */
const NOTICE_RESERVE = 320;

export interface CapOptions {
  /** Char budget for the whole result (default DEFAULT_TOOL_OUTPUT_CAP). */
  cap?: number;
  /** Whether `retrieve_codebase` is available this run (grounding active). Only
   *  then does the notice suggest it — on an ungrounded run the tool doesn't
   *  exist, so pointing the model at it would waste a turn. */
  suggestRetrieval?: boolean;
}

/**
 * Cap a single tool result. Returns `output` unchanged for uncapped tools, for
 * non-string output, or when it already fits. Otherwise keeps the first ~70% and
 * last ~30% of the char budget with the middle elided and a one-line notice on
 * how to get a tighter result.
 */
export function capToolOutput(tool: string, output: unknown, opts: CapOptions = {}): unknown {
  const cap = opts.cap ?? DEFAULT_TOOL_OUTPUT_CAP;
  if (!CAPPED_TOOLS.has(tool)) return output;
  if (typeof output !== "string" || output.length <= cap) return output;

  const room = Math.max(0, cap - NOTICE_RESERVE);
  const head = Math.ceil(room * 0.7);
  const tail = room - head;
  const elided = output.length - head - tail;
  const retrievalHint = opts.suggestRetrieval ? " or call retrieve_codebase for a ranked, targeted result" : "";
  const notice =
    `\n\n[Sigilix: ${tool} output truncated to save context — ${elided} chars elided from the middle ` +
    `(kept the first ${head} + last ${tail} of ${output.length}). Narrow the search with a path or a ` +
    `more specific pattern${retrievalHint}.]\n\n`;
  return output.slice(0, head) + notice + (tail > 0 ? output.slice(output.length - tail) : "");
}
