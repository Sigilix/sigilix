# CLAUDE.md — working in the Sigilix repo

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first. That's the team standard and it
applies to you. This file adds the operating rules specific to working as an agent here.

---

## The loop — every task

1. **Research and plan before you code.** Read the target file, its tests, and 3–5 sibling
   files of the same kind; locate or reproduce the actual problem. For anything
   non-trivial, form the approach before writing code (use plan mode / write the plan
   out). Don't guess paths, flags, or config — verify them. **If Codex is accessible to
   you, have it sign off on the plan before you start coding; if it isn't, that's fine —
   proceed.**

2. **Make the minimal change.** Only what the task asks. No extra abstractions, no
   drive-by "improvements." Match the surrounding conventions exactly.

3. **Validate with evidence.** Run the build and read the actual output before claiming
   anything is done:

   ```bash
   npm run build      # typecheck + lint + full test suite
   ```

   No completion claims without fresh output in front of you. Never push red.

4. **Add an end-to-end test for the implementation — before you push.** Write a test that
   exercises the new behavior through its real path (not just a unit in isolation), and
   confirm it would fail if the change were reverted. A green build doesn't count as
   coverage of code the suite never reaches.

5. **Run a `code-reviewer` agent internally — before the PR.** This is mandatory, not
   optional. Launch a `code-reviewer` subagent (Task tool) to re-review your own diff as
   an independent pair of eyes. Read its findings, and fix the valid ones before opening
   the PR. (If Codex is accessible, a second sign-off pass on the diff is welcome too.)
   You are not the last line of defense on your own code.

6. **Open the PR — do not merge it.** The repo owner merges. Branch `sig-<issue>-desc`,
   focused diff, body with what / why / how-verified. Never self-merge unless explicitly
   told to in this session.

7. **Make sure the bots fire.** After the PR is up, confirm that **Sigilix**'s bot review,
   **CodeRabbit**, and **CI** (`lint`, `evidence / scan`, `Workers Builds`) actually run.
   If a check is missing or stuck, investigate — don't treat a silent gate as a pass.

8. **Respond to every bot comment.** For each Sigilix and CodeRabbit finding:
   - if the change is **applicable**, apply the fix and reply that you did, or
   - if it's a **false positive / not applicable**, reply explaining why. For Sigilix,
     dismiss in-thread: `@sigilix dismiss <not-a-bug|bad-anchor|already-covered|too-minor|wrong-context>`.

   Never leave a bot comment unanswered. Never merge over an open one.

---

## Hard rules

- `npm run build` **green** before any push — typecheck, lint, and tests all pass.
- Do **not** push to `main`, force-push, or run destructive git without asking.
- No `Co-Authored-By` trailers on commits.
- **Recall-safety:** never suppress or downgrade a real P0/P1 to make output look clean.
- Only change what's asked. Don't over-engineer.

---

## Repo orientation

- A single **Cloudflare Worker** (TypeScript, strict). PR review + Linear triage.
- Four review specialists (logic / security / performance / tests) run in parallel; a
  synthesizer dedupes into one posted review. Most review logic lives under
  `src/lib/` (notably the `triage-pr-review*` files).
- Tests are **vitest**; `npm run build` runs the whole gate. Internal env vars keep the
  legacy `OPENCLAW_*` prefix on purpose — don't rename them.
