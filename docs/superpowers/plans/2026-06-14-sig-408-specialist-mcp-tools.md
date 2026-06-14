# SIG-408 Specialist MCP Tool Adapters

## Goal

Give approved PR-review specialists a small MCP-style tool surface during their model run, with strict per-specialist budgets and structured tool results injected back into the conversation before the final schema-constrained review verdict.

## External Pattern

Shippie loads MCP tool providers from config, namespaces tool definitions, and merges them into the LLM tool list at run time. Sigilix should keep the same extension-point shape but implement a Worker-safe internal adapter: no subprocess transports, deterministic in-process tools, and per-specialist permission filtering.

## Design

1. Add a pure shared MCP tool catalog:
   - tool ids: `file_grep`, `docs_fetch`, `observability_lookup`, `browser_check`
   - defaults: max 2 tool calls per specialist, 5000ms per tool call
2. Add `sigilix.json` / YAML config parsing for:
   - `mcp.enabled`
   - `mcp.tools.<tool>.enabled`
   - `mcp.specialists.<role>.tools`
3. Add a resolver that returns the allowed tool ids for a role.
   - missing config means no tool surface
   - global disabled tool entries remove that tool from every role
   - unknown roles/tools are dropped fail-open
4. Add a specialist tool adapter layer:
   - converts allowed internal tools into `ChatToolDef[]`
   - exposes one tool-call turn only, with at most two calls in that turn
   - executes tool calls with a per-invocation budget
   - injects tool results as `role:"tool"` messages
   - returns structured `{ok:false,error:{code,...}}` tool messages for invalid args, unknown tools, disabled tools, budget overage, and timeout
   - every successful tool result carries `status: "complete" | "truncated" | "empty" | "unavailable" | "error"`
   - final prompt tells the model not to treat `truncated`, `empty`, `unavailable`, or `error` as exhaustive proof of absence
   - URL-fetch tools require runtime-owned allowlists/endpoints; PR-controlled repo config can grant tool ids but cannot authorize arbitrary fetch hosts
5. Thread the adapter through `runSpecialist` only.
   - tool-call turns omit structured `format`
   - final answer turn uses `PR_REVIEW_SCHEMA`
   - unapproved specialists receive no `tools` array and keep the existing single-shot path
6. Keep large files compliant:
   - new logic lives in new files
   - `model-provider.ts` is kept under 1000 lines by moving attempt-chat helpers out
   - `ensemble/app/specialists.ts` is kept under 1000 lines by moving `appendRoleRule` out if needed

## Tools

- `file_grep`: searches the specialist review corpus with optional path filtering and returns bounded matches with line numbers. Truncation is explicit and never presented as exhaustive.
- `docs_fetch`: fetches a bounded text snapshot from a runtime-allowlisted URL, otherwise returns `unavailable`.
- `observability_lookup`: queries a configured metrics/logs URL or returns a structured unavailable result when no endpoint is configured.
- `browser_check`: performs a bounded HTTP page fetch/status/title check for runtime-allowlisted hosts. It does not execute JavaScript or render a page.

## Tests

1. Config parser accepts valid MCP permissions and drops invalid roles/tools.
2. Resolver hides the tool surface when unconfigured or disabled.
3. Tool loop enforces one tool turn, max 2 calls, 5000ms timeout, invalid-args errors, over-budget structured errors, and final schema call.
4. Security E2E: security specialist with `file_grep` permission calls the tool, receives grep evidence, and final verdict is produced from the injected tool result.
5. Negative tests cover unapproved specialists, role/tool mismatches, and non-exhaustive/truncated result status.

## Validation

- targeted vitest for config/tool-loop/security E2E
- `npm run build`
- reviewer model sign-off before PR
