# ARC-185 — Implementation plan

**Status:** v3 — fully dual-signed-off (Codex + Kimi APPROVE-WITH-CHANGES, all blocking + major findings addressed)
**Spec:** `docs/superpowers/specs/2026-05-06-arc-185-per-command-config-design.md` (v3, fully signed off)
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
  - **`commands` as array → `{ok: false, reason: /commands must be an object/}`** (Codex MAJOR #3: v3 §5.1 contract)
  - **`commands` as non-object/non-array (string) → `{ok: false, reason: /commands must be an object/}`**
  - unknown command name (`commands.reviews`) → `{ok: false, reason: /unknown command/}`
  - addendum > 4000 code points → `{ok: false, reason: /addendum.*length/}`
  - addendum exactly 4000 code points → ok
  - whitespace-only model.primary → `{ok: false, reason: /model.primary/}`
  - non-array fallbacks → `{ok: false, reason: /fallbacks must be array/}`
  - >4 fallback entries → `{ok: false, reason: /fallbacks.*4 entries/}`
  - unknown model name (not in registry) → `{ok: false, reason: /unknown model/}`
  - Existing `parseSigilixConfig(raw)` still returns `null` on the same bad inputs (back-compat invariant)
- [ ] **Step 2: implementation.** Add `SigilixCommandName`, `SigilixCommandConfig`, etc. types. Add `KNOWN_MODELS = new Set([...])` registry — populate from `triage-pr-review-ensemble.ts` lineup + the single-shot defaults. **`parseSigilixConfigDetailed` is the new primary parser; the legacy `parseSigilixConfig(raw): SigilixConfig | null` becomes a thin wrapper that calls `parseSigilixConfigDetailed` and discards the reason on failure** (Kimi NIT #5: clarified direction of the wrapping).
- [ ] Tests also assert `command-config-model-unknown` telemetry event is emittable with `{owner, repo, prNumber, command, model}` fields (Kimi MINOR #4) — actual emission happens at the handler call site (Task 7), but the parse-error reason string MUST be machine-extractable so the caller can decide which event to emit.
- [ ] **Step 3:** tsc clean, tests pass.
- [ ] Commit: `feat(arc-185): sigilix-config — commands schema + parseSigilixConfigDetailed`

---

## Task 2: `resolveCommandConfig` helper with tagged fallback override (TDD)

**Files:** `src/lib/sigilix-config.ts`, `tests/sigilix-config.test.ts`

Codex plan catch (BLOCKING #1): the resolver MUST distinguish "use existing defaults" from "explicit empty fallback list". Per spec v3 §5.1, missing `fallbacks` AND explicit `fallbacks: []` both mean "use defaults" — but we still need the *resolver shape* to make this unambiguous to consumers.

- [ ] **Step 1: tests.**
  - `resolveCommandConfig(null, "improve")` → `{promptAddendum: null, modelPrimary: null, modelFallbacks: { override: false }}`
  - `resolveCommandConfig({commands:{improve:{}}}, "improve")` → same (override: false; no commands.improve.model)
  - `resolveCommandConfig({commands:{improve:{model:{fallbacks:[]}}}}, "improve")` → `{modelFallbacks: { override: false }}` (explicit empty = use defaults, per spec v3 §5.1)
  - `resolveCommandConfig({commands:{improve:{model:{fallbacks:["a","b"]}}}}, "improve")` → `{modelFallbacks: { override: true, models: ["a","b"] }}`
  - addendum cases: missing → null, set → string
  - modelPrimary cases: missing → null, set → string
- [ ] **Step 2: implementation.** Pure function. Resolver shape:
  ```ts
  {
    promptAddendum: string | null,
    modelPrimary: string | null,
    modelFallbacks: { override: false } | { override: true, models: string[] }
  }
  ```
  Consumers branch on `modelFallbacks.override` to decide whether to replace the existing chain or keep it.
- [ ] Commit: `feat(arc-185): resolveCommandConfig with tagged fallback-override semantics`

---

## Task 3: wire `improve` to consume per-command config

**Files:** `src/lib/triage-pr-improve.ts`, `tests/triage-pr-improve.test.ts` (or new focused test)

- [ ] **Step 1: tests.** Verify the model used is `commands.improve.model.primary` when set; that `commands.improve.prompt.addendum` appends to the system prompt; that fallback chain is honored on first-call rejection.
- [ ] **Step 2: implementation.** Inside `handlePrImprove`, after the existing `loadSigilixConfig` call, run `resolveCommandConfig(config, "improve")`. Append addendum to the prompt. Use `modelPrimary ?? DEFAULT_MODEL`; on call failure, retry with each entry in `modelFallbacks` before giving up.
- [ ] **Telemetry assertions** (Codex MINOR #6):
  - `command-config-resolved` fires once per invocation when any field is set; assert fields `{command, hasPromptAddendum, modelPrimary, modelFallbacksCount}`
  - `command-config-model-unknown` fires when `model.primary` references an unknown model (caught earlier at parse but tested at handler too if reachable)
- [ ] Commit: `feat(arc-185): wire /sigilix improve to per-command sigilix.json config`

---

## Task 4: wire `describe` (mirror of Task 3)

**Files:** `src/lib/triage-pr-describe.ts`, `tests/triage-pr-describe.test.ts`

- [ ] Same TDD shape as Task 3. Single-shot model swap + addendum + fallbacks.
- [ ] Commit: `feat(arc-185): wire /sigilix describe to per-command sigilix.json config`

---

## Task 5: wire `review` synthesizer addendum + model.primary + model.fallbacks

**Files:** `src/lib/triage-pr-review-ensemble.ts`, `tests/triage-pr-review-ensemble.test.ts`

Codex plan catch (MAJOR #2): default-fallback-preservation must be tested explicitly.

- [ ] **Step 1: tests.**
  - Synth call uses `commands.review.model.primary` when set
  - Addendum is appended to the synth prompt
  - v3.1 LOCKED specialist lineup is **untouched** (specialist tests still pass)
  - **Missing `commands.review.model.fallbacks` → existing synth fallback chain preserved** (Codex MAJOR #2)
  - **Explicit `commands.review.model.fallbacks: []` → existing synth fallback chain preserved** (per spec v3 §5.1)
  - Explicit `commands.review.model.fallbacks: ["custom"]` → REPLACES the existing chain with `["custom"]`
  - Telemetry: `command-config-resolved` fires with the right `command: "review"` field
- [ ] **Step 2: implementation.** In the synth runner (`runSynthesizer`), thread `resolveCommandConfig(config, "review")` through. Append addendum. Branch on `modelFallbacks.override`: when `false`, keep existing chain; when `true`, replace with `models`. Specialist code path is left alone.
- [ ] Add a regression test: a sigilix.json with `commands.review.model.primary` set does NOT change the specialist models.
- [ ] Commit: `feat(arc-185): wire /sigilix review synth to commands.review (addendum + model.primary + fallbacks with default preservation)`

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

## Task 7: invoke parse-error posting from slash-command dispatch (scope clarification)

**Files:** `src/index.ts`

Codex plan catch (MINOR #5): scope explicitly limited to slash-command dispatch path. Other webhook paths (pr-review, pr-overview, ci-triage) that already silently fall back on bad config keep that behavior in v1 — adding parse-error comments on every webhook would spam reviewers when the bot's auto-firing on opened/synchronize.

### Step 1 (Kimi MINOR #3): thread raw `sigilix.json` text into the dispatch layer

The current dispatch path only consumes the parsed result from `loadSigilixConfig`. To call `parseSigilixConfigDetailed` (which needs the raw string for the parse-error PR-comment snippet), thread `loadSigilixConfigRaw(client, owner, repo, ref): Promise<string | null>` through. Add this helper alongside `loadSigilixConfig`. Returns null on missing/empty file. Both call sites can then read raw + parse.

### Step 2: dispatch wiring with TDD coverage (Kimi MAJOR #1)

In the **slash-command webhook path** (where the user's intent to use Sigilix is explicit):
- [ ] **Tests first** — assert all branches of the degraded-mode contract from spec §2:
  - Happy path (config valid): no comment posted, queue job enqueued normally.
  - Parse error: `postConfigErrorComment` invoked with the right reason; queue job is STILL enqueued (degraded mode); the dispatch layer does not throw if the comment poster fails (try/catch swallows).
  - `command-config-parse-error` telemetry fires with `{owner, repo, prNumber, reason}`.
  - `command-config-error-comment-posted` telemetry fires when the comment lands.
  - `command-config-error-comment-suppressed-dedupe` telemetry fires when KV/GH-search dedupe hits.
- [ ] **Implementation** — load raw via `loadSigilixConfigRaw`, parse via `parseSigilixConfigDetailed`. On `ok: false`, fire-and-forget `postConfigErrorComment` (try/catch swallowed); proceed to enqueue using `EMPTY_CONFIG`.
- [ ] Auto-fired webhook paths (pr-review, pr-overview, ci-triage) keep silent fallback behavior in v1. Future: extend to those paths if user feedback says it's needed.
- [ ] Commit: `feat(arc-185): post config-error PR comment on slash-command dispatch (scope: slash only) + degraded-mode continuation tests`

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

## Sign-off summary

### Codex (v1 → v2)

| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** Resolver `fallbacks: []` ambiguous | Task 2 returns tagged `{override: true, models}` vs `{override: false}`; explicit empty maps to "use defaults" per spec v3 §5.1. |
| **[MAJOR]** Default-fallback preservation untested | Task 5 now has explicit "missing → preserved" + "explicit empty → preserved" + "non-empty → replaces" assertions. |
| **[MAJOR]** Task 1 missing `commands` non-object/array rejection | Task 1 step-1 tests now cover both. |
| **[MAJOR]** Plan referenced spec v2; sign-off was v3 | Header updated to "Spec v3, fully signed off". |
| **[MINOR]** Task 7 scope unclear vs auto-fired webhooks | Task 7 explicitly scopes to slash-command dispatch; auto-fired webhooks keep silent fallback. |
| **[MINOR]** Telemetry coverage thin | Tasks 3 + 5 now assert specific events + fields. |

### Kimi (v2 → v3)

| Kimi finding | v3 change |
|---|---|
| **[MAJOR]** Task 7 missing TDD coverage for degraded-mode | Task 7 step-1 lists explicit branch-coverage tests (happy / parse-error → comment + enqueue / poster-fails-but-doesn't-throw / telemetry on every branch). |
| **[MAJOR]** Telemetry under-specified | Task 7 lists every telemetry event with field shape; Tasks 3 + 5 already updated in v2. |
| **[MINOR]** Raw config not currently threaded into dispatch | Task 7 step-1 adds `loadSigilixConfigRaw` helper before the dispatch wiring. |
| **[MINOR]** Task 1 missing `command-config-model-unknown` assertion | Task 1 step-2 now requires the parse-error reason string be machine-extractable so the caller can map to the right telemetry event. |
| **[NIT]** Task 1 wrapper-direction wording ambiguous | Task 1 step-2 explicit: `parseSigilixConfigDetailed` is primary; legacy `parseSigilixConfig` is the thin wrapper. |

## Self-review checklist (before sign-off)

- [ ] **Spec coverage:** every numbered section in v3 spec maps to ≥1 task.
- [ ] **Type names** consistent: `SigilixCommandName`, `SigilixCommandConfig`, `SigilixCommandPromptConfig`, `SigilixCommandModelConfig`, `parseSigilixConfigDetailed`, `resolveCommandConfig`, `postConfigErrorComment`, `KNOWN_MODELS`.
- [ ] **Back-compat invariant:** existing `parseSigilixConfig(raw): SigilixConfig | null` is unchanged. Tests covering existing call sites must still pass without modification.
- [ ] **No specialist-level model changes** — Task 5 leaves the v3.1 LOCKED ensemble lineup untouched.
- [ ] **No Node-only API.**
- [ ] **No new dependency.**
