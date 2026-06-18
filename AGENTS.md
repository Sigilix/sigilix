# AGENTS.md

The engineering standard for this repo lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
It applies to AI agents too — read it.

**Before you touch code, also read [`COMPLIANCE.md`](./COMPLIANCE.md)** — the structural rules
CI enforces (the dependency rule, barrel-only imports, `@/` imports, the file-size budget) — and
tell your point of contact (the engineer running you) that you have. Read
[`ENGINEERING.md`](./ENGINEERING.md) to learn how the system is built and where code goes.

If you're **Claude Code**, also read [`CLAUDE.md`](./CLAUDE.md) for the agent-specific
operating rules (an internal code-review pass before the PR, and the bot-response gate).

The gate for any change, in one line:

> research + plan first (if Codex is available, have it sign off on the plan) →
> validate (`npm run build` green) → an end-to-end test covering the new behavior →
> independent code-review pass → focused PR → all bots + CI pass (**Sigilix**,
> **CodeRabbit**, `lint`, `evidence / scan`, `Workers Builds`) → **respond to every bot
> comment** (apply the fix; for a false positive on an *intentional* pattern, reply explaining
> why — Sigilix's Learnings will remember it; otherwise dismiss — but never teach away a real
> bug) → the repo owner merges.

No self-merging. No pushing to `main` or force-pushing. No `Co-Authored-By` trailers.
Never hide a real high-severity (P0/P1) finding to make a check go green.

**Model-eval tests** (running a real review specialist through a live model, e.g.
`npm run logic-recall-eval`) need a Turbo-entitled `OLLAMA_API_KEY` in your gitignored
`.dev.vars`; they SKIP without it so CI stays green. See `CLAUDE.md` → "Model-eval testing".
