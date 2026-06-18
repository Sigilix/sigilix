# GEMINI.md

This repo's agent + engineering standard lives in [`AGENTS.md`](./AGENTS.md) — **read it; it
applies to you.** It routes to:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how a change gets made, including how to handle a
  review finding: **apply** the fix; for a false positive on an _intentional_ pattern, **reply
  explaining why** (Sigilix's Learnings remembers it, so it won't re-flag); otherwise dismiss —
  but **never teach away a real bug or a P0/P1 / security-or-logic finding.**
- [`COMPLIANCE.md`](./COMPLIANCE.md) — the machine-enforced structure rules (dependency rule,
  barrel-only imports, `@/` imports, file-size budget). A violation is a red build.
- [`ENGINEERING.md`](./ENGINEERING.md) — how the system is built and where code goes.

The one-line gate: research + plan → `npm run build` green → an end-to-end test for the new
behavior → independent review pass → focused PR → all bots + CI pass → respond to every bot
comment → the repo owner merges. No self-merge, no force-push, no `Co-Authored-By` trailers.
