# ARC-185 — Per-command prompt + model config in `sigilix.json` — design spec

**Status:** v3 — fully dual-signed-off (Codex APPROVE-WITH-CHANGES + Kimi APPROVE-WITH-CHANGES, all blocking + major findings addressed)
**Linear:** [ARC-185](https://linear.app/arc-and-anchor/issue/ARC-185/per-command-prompt-model-config-in-sigilixjson-commandsreview-etc)
**Reference:** PR-Agent's `pr_agent/config_loader.py:14-43`, `pr_agent/settings/configuration.toml:79-278`

---

## 1. Problem

Today every Sigilix command runs against the same ensemble configuration (single-agent for `/sigilix improve` and `/sigilix describe`; the v3.1 LOCKED 4-specialist+synth lineup for `/sigilix review`). Teams want different cost/quality knobs per command — `/sigilix ask` cheap and fast; `/sigilix review` thorough; `/sigilix improve` somewhere in between. PR-Agent solved this with per-command config keys; ARC-185 ports the pattern.

## 2. Acceptance criteria (from Linear, refined for v1)

- Each command can declare its own `prompt.addendum` (text appended to the system prompt) AND `model.primary` (override of the default model) in `sigilix.json`.
- **`model.fallbacks` is wired for `improve`, `describe`, and the `review` synthesizer in v1.** For commands that have an existing fallback chain (synth: kimi-k2.6:cloud), the `fallbacks` array replaces it. For single-shot commands without a chain, `fallbacks` adds one. Per-command independence is preserved. (Specialist-level fallbacks for `review` remain on the v3.1 LOCKED lineup; deferred per §4.)
- Invalid `sigilix.json` → the **first** webhook arriving for that PR posts a top-level PR comment with the parse error AND the rest of the system continues to operate with default config (does not crash, does not skip the PR). Subsequent webhooks for the same PR + same head SHA do not re-post.
- When `commands` key is absent or a specific command is unconfigured, behavior matches current defaults exactly.

## 3. Schema

```json
{
  "commands": {
    "review": {
      "prompt": { "addendum": "..." },
      "model":  { "primary": "...", "fallbacks": ["...", "..."] }
    },
    "improve": {
      "prompt": { "addendum": "..." },
      "model":  { "primary": "...", "fallbacks": ["...", "..."] }
    },
    "describe": {
      "prompt": { "addendum": "..." },
      "model":  { "primary": "...", "fallbacks": ["...", "..."] }
    },
    "ask": {
      "prompt": { "addendum": "..." },
      "model":  { "primary": "...", "fallbacks": ["...", "..."] }
    }
  }
}
```

Every key is **optional** at every level. Missing `commands` → no per-command override. Missing `prompt` → no addendum. Missing `model.primary` → use the command's existing default. Missing `model.fallbacks` → use the command's existing fallback chain (or none).

## 4. v1 surface vs deferred

v1 wires the override into the **single-shot commands** (`improve`, `describe`) where it's a single-line code change. v1 also wires `prompt.addendum` into the ensemble `synthesizer` prompt for `/sigilix review` (not the specialists — they have their own config-rule injection per ARC-174).

**Deferred to v2 (out of v1 scope):**
- Specialist-level model overrides for `/sigilix review`. The 4 specialists run on a v3.1 LOCKED lineup with cross-provider fallbacks per role (`triage-pr-review-ensemble.ts:170-200`). Replacing that requires a deep redesign of the ensemble's retry orchestration; the cost/risk doesn't fit a 4-point ticket.
- `/sigilix ask` integration. The slash command is reserved but the handler doesn't exist yet; ARC-185 defines the schema slot and the validator accepts the key, but no runtime path consumes it until `ask` ships.
- `commands.<cmd>.routing` — directing different commands to different deployments. Defer; requires deployment-side work.

## 5. Architecture

### 5.1 Validator surface

Extend `src/lib/sigilix-config.ts`:

```ts
export interface SigilixCommandModelConfig {
  primary?: string
  fallbacks?: string[]
}
export interface SigilixCommandPromptConfig {
  addendum?: string
}
export interface SigilixCommandConfig {
  prompt?: SigilixCommandPromptConfig
  model?: SigilixCommandModelConfig
}
export type SigilixCommandName = "review" | "improve" | "describe" | "ask"
export interface SigilixConfig {
  // ... existing fields ...
  commands?: Partial<Record<SigilixCommandName, SigilixCommandConfig>>
}
```

**Back-compatible API split** (Codex MAJOR #2 — changing the existing `parseSigilixConfig` return type would break every TS caller):

- `parseSigilixConfig(raw): SigilixConfig | null` — **unchanged signature.** Existing callers (`loadSigilixConfig`, ensemble runner) keep working. Returns `null` on any malformation; old behavior preserved.
- `parseSigilixConfigDetailed(raw): ParseResult` — **new entry point** for the parse-error reporting path. Same parse logic but returns a tagged result so the caller can post a PR comment with the reason:
  ```ts
  type ParseResult =
    | { ok: true; config: SigilixConfig }
    | { ok: false; reason: string; raw: string }
  ```
  Internally `parseSigilixConfig` becomes a thin wrapper: `parseSigilixConfigDetailed(raw).ok ? out : null`. Single source of truth for validation rules.

Validation rules (apply to both entry points):
- `commands` MUST be an object (rejected if array or non-object).
- Each `commands.<key>` MUST be a known command name (`review` / `improve` / `describe` / `ask`). **Unknown command keys → parse error** (Codex MINOR #5: forgiving silent-drop hides typos like `"reviews"` from the user).
- `commands.<cmd>.prompt.addendum` MUST be a string (≤ 4000 **Unicode code points**, measured via `[...str].length` to avoid surrogate-pair miscounting; longer → parse error).
- `commands.<cmd>.model.primary` MUST be a non-empty string after `.trim()`. Whitespace-only is rejected; values are stored normalized via trim (Codex MINOR #6).
- `commands.<cmd>.model.fallbacks` MUST be an array of non-empty (post-trim) strings (≤ 4 entries). The cap of 4 mirrors the existing `runWithRetryAndFallback` retry budget shape (one primary + up to four fallbacks = up to 5 total attempts before declaring failure). Kimi MINOR #4: rationale documented here; cap exists to bound worst-case wall-clock per call.
- **Explicit empty `fallbacks: []` is treated as "use defaults"** (Kimi NIT #5). Indistinguishable from a missing `fallbacks` key in v1 — semantics aligned for simplicity. If a future user wants to disable defaults explicitly, we'll add a separate `useDefaultFallbacks: false` flag (defer until requested).

### 5.2 Resolver

A new helper `resolveCommandConfig(config, command)` returns the resolved per-command shape:

```ts
export function resolveCommandConfig(
  config: SigilixConfig | null,
  command: SigilixCommandName,
): {
  promptAddendum: string | null
  modelPrimary: string | null
  modelFallbacks: string[]
} {
  // ...
}
```

Single source of truth for read-paths. Defaults to `null`/empty when the config or sub-keys are missing.

### 5.3 Wiring per command

| Command | Path that consumes the resolved config |
|---|---|
| `improve` | `triage-pr-improve.ts` — append addendum to system prompt; if `modelPrimary` set, swap; if `modelFallbacks` set, retry on failure |
| `describe` | `triage-pr-describe.ts` — same shape |
| `review` (ensemble) | `triage-pr-review-ensemble.ts` synthesizer — append addendum to synth prompt; if `modelPrimary` set, swap synth model. **Specialists are not touched in v1.** |
| `ask` | (deferred — schema slot reserved, no runtime path yet) |

### 5.4 Parse-error PR comment

When a slash command arrives AND `parseSigilixConfigDetailed` returns `{ok: false, reason}`, the dispatch layer posts a **top-level PR comment** (Codex MAJOR #4: top-level not inline; the file/line that caused the parse error may not be in the diff):

```markdown
<!-- openclaw:config-error:<headSha7> -->

⚠️ **Sigilix config parse error**

Your repo's `sigilix.json` couldn't be parsed: `<reason>`. Sigilix is running with default config — fix the file at the PR head and the next push will pick it up.

<details>
<summary>Raw config (first 500 chars)</summary>

```
<raw config snippet>
```

</details>
```

**Idempotency** (Codex MAJOR #3 — bake the head SHA into the visible marker so GitHub-comment-search remains authoritative after KV expiry):

1. **Marker contains the head SHA** — `<!-- openclaw:config-error:<headSha7> -->`. A new head SHA produces a different marker; same head SHA produces the same marker.
2. **KV fast-path dedupe**: `config-error-posted:<owner>/<repo>#<n>:<headSha>` (1-day TTL). On a fast hit, the dispatch layer logs `command-config-error-comment-suppressed-dedupe` and skips the post entirely.
3. **GitHub-side authoritative dedupe**: when KV doesn't have the record (TTL expired, KV cold edge), the comment-poster lists existing PR issue comments and looks for the `<!-- openclaw:config-error:<headSha7> -->` substring. Found → no new comment.

This combo handles the three failure modes Codex flagged: KV expiry doesn't lead to spam (GitHub-side check); concurrent webhooks within KV propagation window don't double-post (KV check happens first); a head-SHA change correctly produces a new comment.

## 5.5 Sign-off summary

### Codex (v1 → v2)



| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** `review.model.fallbacks` not wired | §2 + §5.3 explicitly state synth-level fallback override is wired in v1; specialist-level remains deferred. |
| **[MAJOR]** Parse-result migration breaks TS callers | §5.1 keeps `parseSigilixConfig` signature unchanged; new `parseSigilixConfigDetailed` for the parse-error-comment path. Internal logic shared. |
| **[MAJOR]** Idempotency marker missing head SHA | §5.4 marker is `<!-- openclaw:config-error:<headSha7> -->`. KV fast-path + GitHub-side authoritative search both honor it. |
| **[MAJOR]** Inline vs top-level conflict | §5.4 explicitly top-level. |
| **[MINOR]** Silent unknown-key drop hides typos | §5.1 unknown command keys → parse error. |
| **[MINOR]** model.primary trim/whitespace handling | §5.1 strict-trim + reject empty. |
| **[NIT]** Telemetry model-name privacy | §7 note — model names are user-visible in source; safe to emit. Truncate to 64 chars. |
| **§8.1** addendum on synth only | Resolved → §8.1 |
| **§8.2** 4000 chars OK | Resolved → 4000 code points |
| **§8.3** No ack/dismiss UI | Resolved → §8.3 |
| **§8.4** Unknown model → config error not silent | Resolved → §8.4 + §5.1 + new telemetry event |

### Kimi (v2 → v3)

| Kimi finding | v3 change |
|---|---|
| **[BLOCKING]** ParseResult breaks back-compat | Already addressed in v2 — `parseSigilixConfig` signature unchanged; `parseSigilixConfigDetailed` is new. |
| **[MAJOR]** Inline vs top-level | Already addressed in v2 — explicit top-level. |
| **[MINOR]** Silent unknown-key drop | Already addressed in v2 — parse error. |
| **[MINOR]** Fallback-cap rationale missing | §5.1 now documents the cap-of-4 mirrors `runWithRetryAndFallback` retry budget. |
| **[NIT]** Explicit `fallbacks: []` semantics | §5.1 now documents: empty array = use defaults; future `useDefaultFallbacks: false` flag deferred. |
| **§8.1** synth-only addendum | Aligned with Codex (v2). |
| **§8.2** 4000 char cap (Kimi: UTF-16 code unit; Codex: code points) | Spec stays code points (`[...str].length`) — friendlier to non-ASCII guidance prose; difference is ≤2× for surrogate-pair-heavy text. Documented divergence. |
| **§8.3** No dismiss UI | Aligned with Codex (v2). |
| **§8.4** Unknown model behavior | **Disagreement with Codex.** Codex recommended parse-error comment (transparency for user errors); Kimi recommended silent fallback + telemetry (treats routing-table as operator data). v3 sticks with Codex's recommendation (parse-error comment) — user-config errors are common, operator-side rotations are rare. v3 softens the comment copy: "this model isn't in our routing table — check the spelling, or contact ops if it should be supported." |

## 6. Constraints / non-goals

- **No deployment changes.** The schema is read at the PR head SHA via the existing `getFileContents` helper; no env-var plumbing.
- **No breaking changes.** Existing `sigilix.json` files with no `commands` key continue to behave identically. The integration tests for `parseSigilixConfig` are extended, not rewritten.
- **No dynamic prompt reloading mid-PR.** The PR head SHA at webhook time is the source of truth; the resolved config is computed once per handler invocation.

## 7. Telemetry

**Privacy note** (Codex NIT #7): operator-routed model names *are* user-visible in the `sigilix.json` source, so emitting them in resolved/unknown telemetry is fine — they're not secrets. Strings are kept under 64 chars (telemetry sampling friendliness), longer values truncated.

| Event | When |
|---|---|
| `command-config-resolved` | Handler invocation when at least one of `prompt.addendum` / `model.primary` / `model.fallbacks` is set. Fields: `{owner, repo, prNumber, command, hasPromptAddendum, modelPrimary, modelFallbacksCount}`. |
| `command-config-parse-error` | Validator rejected the config. Fields: `{owner, repo, prNumber, reason}`. |
| `command-config-error-comment-posted` | Inline parse-error comment landed on the PR. Fields: `{owner, repo, prNumber, headSha}`. |
| `command-config-error-comment-suppressed-dedupe` | KV dedupe OR GitHub-comment-search dedupe fired; no new comment. |
| `command-config-model-unknown` | `model.primary` references an unknown model; treated as parse error. Fields: `{owner, repo, prNumber, command, model}`. |

## 8. Decisions on prior open questions (resolved during sign-off)

1. **`prompt.addendum` for `/sigilix review` is applied to the synthesizer only.** Specialists already have ARC-174's `rules.<role>` for targeted injection; appending to every specialist would multiply token spend 4-5× for marginal value. (Codex confirmed.)
2. **`prompt.addendum` length cap: 4000 Unicode code points** (measured via `[...str].length`, not byte length — UTF-8 multi-byte characters shouldn't penalize legitimate non-ASCII guidance prose). Documented in the validator.
3. **No ack/dismiss UI in v1.** Fire-and-forget; the head-SHA-keyed marker means a fixed config on the next push is the natural dismissal path. (Codex confirmed.)
4. **Unknown `model.primary` is treated as a config error**, posting the same parse-error comment (Codex MAJOR-flavored — Codex recommended option (b) over silent fallback). The model-routing table lookup happens *inside the validator*, not the handler — keeps validation centralized. Telemetry: `command-config-model-unknown { command, model }`.
