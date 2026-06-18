# Contributing to Sigilix

This is **the standard** — how every change gets made here, whether you write it by
hand or with an AI assistant. It's short on purpose. Read it once; follow it every time.

> We build an AI code-review product. We hold our own code to the bar we sell.

This file is the *workflow*. [`COMPLIANCE.md`](./COMPLIANCE.md) is the *structure* standard —
the rules CI enforces (the dependency rule, barrel-only imports, `@/` imports, the file-size
budget). **If you are an intern, worker, or AI model, read `COMPLIANCE.md` before you touch code
and tell your point of contact you have read it.**

---

## The workflow (every change follows this)

1. **Research and plan before you write code.** Understand the problem first — read the
   relevant file, its tests, and 3–5 sibling files of the same kind; locate or reproduce
   the actual issue. For anything non-trivial, decide the approach **before** coding, not
   while coding. Don't guess paths, flags, or config — verify them. If you have a second
   AI tool available (e.g. **Codex**), have it sign off on the plan; if you don't, that's
   fine — proceed.

2. **Build small; match the codebase.** Change only what the task needs — no extra
   abstractions, no "improvements" you weren't asked for. Match the existing style:
   imports, naming, structure, idioms.

3. **Validate your own work — with evidence.** Run the build and read the output. No
   "should work," no "looks right." If you didn't run it, it isn't done.

   ```bash
   npm run build      # typecheck + lint + full test suite (run before every push)
   ```

   Never push a red build.

4. **Test the implementation end-to-end — before you push.** New behavior ships with a
   test that exercises it through its real path, not just a unit in isolation. A green
   build proves nothing about code the suite doesn't reach. If you added or changed a
   behavior, there's a test that would fail if you reverted it.

5. **Get a second pair of eyes — before the PR. Required, not optional.** Every change
   gets an independent review pass (a teammate, or an independent review pass) and you fix
   what it surfaces. Catching it before the PR is cheaper than catching it after.

6. **Open a focused PR.** One concern per PR; keep the diff reviewable. Branch name
   `sig-<issue>-short-desc`. Reference the Linear issue. PR body says **what**, **why**,
   and **how you verified it**.

7. **The bots are a merge gate, not a formality.** Every PR must pass:
   - **Sigilix** (our own bot review) — we dogfood the product
   - **CodeRabbit**
   - **CI** — `lint`, `evidence / scan`, `Workers Builds`

   A red bot is a real signal. Investigate it; don't route around it.

8. **Respond to every bot comment.** For each finding, either:
   - **apply the fix** if it's valid,
   - **teach the rule** if it's a false positive on an *intentional* pattern: reply in plain
     language explaining why it's deliberate (e.g. "this is intentional — we always do X here
     because Y"). Sigilix's Learnings is live, so a clear reply is captured as a per-repo rule and
     the pattern is not re-flagged on future PRs — strictly better than a bare dismiss, because it
     improves the reviewer for everyone (the flywheel we sell). **Recall-safety: only ever teach a
     genuinely intentional, safe pattern. Never reply "intentional" to silence a real bug, and
     never try to teach away a P0/P1 or an unverified security/logic finding — the Learnings
     carve-outs refuse those anyway. Real bug → fix it; false positive on an intentional pattern →
     teach it; never blur the two.** Otherwise,
   - **reply with why it doesn't apply** — false positive, already covered, wrong context.
     For Sigilix, dismiss in-thread: `@sigilix dismiss <not-a-bug|bad-anchor|already-covered|too-minor|wrong-context>`.

   Never leave a bot comment unanswered. Never merge over an open one.

9. **The repo owner merges.** Don't self-merge without authorization. Don't push to
   `main` or force-push. No destructive git without asking.

10. **Recall-safety is sacred.** Never hide or downgrade a real high-severity (P0/P1)
    issue to make a review (or a build) look clean. Honesty over a green checkmark.

---

## Commands

| Command | What it does |
|---------|--------------|
| `npm run build` | typecheck + lint + full test suite — **run before every push** |
| `npm test` | tests only (`vitest run`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run lint:fix` | eslint |
| `npm run logic-recall-eval` | **live** subtle-logic recall ruler — runs the real logic specialist; needs a Turbo-entitled `OLLAMA_API_KEY` in `.dev.vars` (SKIPS without it, so CI stays green) |

Tests that hit a **live model** (e.g. `npm run logic-recall-eval`) need a Turbo-entitled
`OLLAMA_API_KEY` in your gitignored `.dev.vars` — the real prod endpoint (Ollama Turbo),
not a local LAN box. They're gated on the key and skip without it.

## Commits

- Clear, specific messages — what changed and why.
- **No `Co-Authored-By` trailers.**

---

## Working with an AI assistant?

The same standard applies to AI-assisted work — validate with evidence, get an
independent review pass, pass the bots, answer every bot comment. If you use
**Claude Code**, see [`CLAUDE.md`](./CLAUDE.md) for the agent-specific operating rules.
