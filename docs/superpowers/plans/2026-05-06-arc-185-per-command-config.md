# ARC-185 — Implementation plan

**Status:** DRAFT v1 — pending dual sign-off (Kimi + Codex)
**Spec:** `docs/superpowers/specs/2026-05-06-arc-185-per-command-config-design.md` (v2)
**Branch:** `arc-185-per-command-config`

10 micro-commits. Each ends in tsc-clean + green-test commit so any task is independently reviewable. TDD where it pays.

---

## Task 1: schema types in `sigilix-config.ts` + known-model registry (TDD)

**Files:** `src/lib/sigilix-config.ts`, `tests/sigilix-config.test.ts`

- [ ] **Step 1: tests first.** Add a `describe("parseSigilixConfigDetailed — commands schema")` block:
  - empty config → `{ok: true, config: {}}` (no commands key)
  - `commands.review.prompt.addendum: "..."` → ok with addendum captured
  - `commands.review.model.primary: "qwen3-coder:480b-cloud"` → ok with model captured (after trim)
  - `commands.review.model.fallbacks: ["a", "b"]` → ok with fallbacks
  - unknown command name (`commands.reviews`) → `{ok: false, reason: /unknown command/}`
  - addendum > 4000 code points → `{ok: false, reason: /addendum.*length/}`
  - addendum exactly 4000 code points → ok
  - whitespace-only model.primary → `{ok: false, reason: /model.primary/}`
  - non-array fallbacks → `{ok: false, reason: /fallbacks must be array/}`
  - >4 fallback entries → `{ok: false, reason: /fallbacks.*4 entries/}`
  - unknown model name (not in registry) → `{ok: false, reason: /unknown model/}`
  - Existing `parseSigilixConfig(raw)` still returns `null` on the same bad inputs (back-compat invariant)
- [ ] **Step 2: implementation.** Add `SigilixCommandName`, `SigilixCommandConfig`, etc. types. Add `KNOWN_MODELS = new Set([...])` registry — populate from `triage-pr-review-ensemble.ts` lineup + the single-shot defaults. Add `parseSigilixConfigDetailed`; wrap existing `parseSigilixConfig` to call it and ignore the reason on failure.
- [ ] **Step 3:** tsc clean, tests pass.
- [ ] Commit: `feat(arc-185): sigilix-config — commands schema + parseSigilixConfigDetailed`

---

## Task 2: `resolveCommandConfig` helper (TDD)

**Files:** `src/lib/sigilix-config.ts`, `tests/sigilix-config.test.ts`

- [ ] **Step 1: tests.** `resolveCommandConfig(null, "improve")` → `{promptAddendum: null, modelPrimary: null, modelFallbacks: []}`. `resolveCommandConfig({commands:{improve:{prompt:{addendum:"x"}}}}, "improve")` → addendum="x". Etc.
- [ ] **Step 2: implementation.** Pure function returning the resolved shape. Defaults to nulls/empties.
- [ ] Commit: `feat(arc-185): resolveCommandConfig helper`

---

## Task 3: wire `improve` to consume per-command config

**Files:** `src/lib/triage-pr-improve.ts`, `tests/triage-pr-improve.test.ts` (or new focused test)

- [ ] **Step 1: tests.** Verify the model used is `commands.improve.model.primary` when set; that `commands.improve.prompt.addendum` appends to the system prompt; that fallback chain is honored on first-call rejection.
- [ ] **Step 2: implementation.** Inside `handlePrImprove`, after the existing `loadSigilixConfig` call, run `resolveCommandConfig(config, "improve")`. Append addendum to the prompt. Use `modelPrimary ?? DEFAULT_MODEL`; on call failure, retry with each entry in `modelFallbacks` before giving up.
- [ ] Telemetry: emit `command-config-resolved` once per invocation when any field is set.
- [ ] Commit: `feat(arc-185): wire /sigilix improve to per-command sigilix.json config`

---

## Task 4: wire `describe` (mirror of Task 3)

**Files:** `src/lib/triage-pr-describe.ts`, `tests/triage-pr-describe.test.ts`

- [ ] Same TDD shape as Task 3. Single-shot model swap + addendum + fallbacks.
- [ ] Commit: `feat(arc-185): wire /sigilix describe to per-command sigilix.json config`

---

## Task 5: wire `review` synthesizer addendum + model.primary + model.fallbacks

**Files:** `src/lib/triage-pr-review-ensemble.ts`, `tests/triage-pr-review-ensemble.test.ts`

- [ ] **Step 1: tests.** Verify the synthesizer call uses `commands.review.model.primary` when set; verify addendum is appended to the synth prompt; verify the existing v3.1 LOCKED specialist lineup is **untouched** (specialist tests still pass).
- [ ] **Step 2: implementation.** In the synth runner (`runSynthesizer`), thread `resolveCommandConfig(config, "review")` through. Append addendum. Override the synth model and fallback list when set. Specialist code path is left alone.
- [ ] Add a regression test: a sigilix.json with `commands.review.model.primary` set does NOT change the specialist models.
- [ ] Commit: `feat(arc-185): wire /sigilix review synth to commands.review (addendum + model.primary + fallbacks)`

---

## Task 6: parse-error PR-comment poster (TDD)

**Files:** `src/lib/sigilix-config-error-comment.ts` (new), `tests/sigilix-config-error-comment.test.ts` (new)

- [ ] **Step 1: tests.** Cover:
  - happy path: KV no record + no existing comment → posts new comment; KV record written; telemetry `command-config-error-comment-posted`
  - dedupe via KV: KV record present → no post; telemetry `command-config-error-comment-suppressed-dedupe`
  - dedupe via GitHub-side search: KV cold but existing comment with `<!-- openclaw:config-error:<sha7> -->` substring → no post + KV write to warm the fast path
  - new head SHA, even with prior comment for old SHA → DOES post
  - body shape: includes ⚠️ header, `reason`, raw config snippet (≤500 chars), head-SHA marker
- [ ] **Step 2: implementation.** Pure module with `postConfigErrorComment(env, client, owner, repo, prNumber, headSha, reason, raw)`. Lists existing comments via `client.listIssueComments`, scans for marker substring, posts if needed.
- [ ] Commit: `feat(arc-185): parse-error PR-comment poster (KV + GH-search dedupe)`

---

## Task 7: invoke parse-error posting from slash-command dispatch

**Files:** `src/index.ts`

- [ ] In the slash-command webhook path, before invoking the per-command queue jobs, call `parseSigilixConfigDetailed` on the loaded raw config. If `ok: false`, fire-and-forget `postConfigErrorComment` (try/catch swallowed) and **then** continue to enqueue the job using the default config (do not block the user — degraded mode).
- [ ] Telemetry on every branch.
- [ ] Commit: `feat(arc-185): post config-error PR comment on slash-command dispatch`

---

## Task 8: README updates (`commands.<cmd>.*` reference)

**Files:** `README.md`

- [ ] Add a "Per-command config (ARC-185)" section under the existing `sigilix.json` reference. Include the schema, validation rules, parse-error behavior, and a worked example.
- [ ] Commit: `docs(arc-185): README — per-command sigilix.json reference`

---

## Task 9: dogfood — annotate sigilix's own `sigilix.json` with one `commands` block

**Files:** `sigilix.json`

- [ ] Add `commands.improve.prompt.addendum` with a 1-2 sentence repo-specific guidance for the improve command. Validates the implementation against the live config we use day-to-day.
- [ ] Commit: `chore(arc-185): dogfood per-command config in sigilix.json`

---

## Task 10: final integration pass — typecheck, tests, CodeRabbit, push PR

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm test` clean. Test count delta: ~+30 (schema validation, resolver, three handlers, error-comment poster).
- [ ] `coderabbit review --plain --type committed --base main` — triage findings.
- [ ] `gh pr create` with body that includes `Closes ARC-185`, the per-task summary, and a sample `sigilix.json` snippet for reviewers to copy-paste.

---

## Self-review checklist (before sign-off)

- [ ] **Spec coverage:** every numbered section in v2 spec maps to ≥1 task.
- [ ] **Type names** consistent: `SigilixCommandName`, `SigilixCommandConfig`, `SigilixCommandPromptConfig`, `SigilixCommandModelConfig`, `parseSigilixConfigDetailed`, `resolveCommandConfig`, `postConfigErrorComment`, `KNOWN_MODELS`.
- [ ] **Back-compat invariant:** existing `parseSigilixConfig(raw): SigilixConfig | null` is unchanged. Tests covering existing call sites must still pass without modification.
- [ ] **No specialist-level model changes** — Task 5 leaves the v3.1 LOCKED ensemble lineup untouched.
- [ ] **No Node-only API.**
- [ ] **No new dependency.**
