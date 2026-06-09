# SIG-381 / P1b — model layer → `shared/ports` + `shared/adapters/model` (LOCAL/uncommitted)

**Goal:** introduce the model-provider seam (the Ollama→OpenRouter 1-adapter swap point), **zero behavior change**.

## Current surface (researched, sig-381-model-port worktree off merged main)
- `src/lib/ollama.ts` (242L): `generate({model,prompt,apiKey,temperature?,timeoutMs?,format?,signal?}): Promise<GenerateResult>` — Ollama Turbo `/api/generate`, streaming NDJSON. Exports `LlmUsage`, `GenerateResult`, `generate`; `GenerateArgs` is internal.
- `src/lib/ollama-chat.ts` (311L): `chat(args: ChatArgs): Promise<ChatResult>` — Ollama `/api/chat`, tools/multi-turn, streaming + `ChatDisabledError`/`isChatDisabledError`. Exports `ChatMessage, ToolCall, ChatToolDef, ChatArgs, ChatResult`. Imports `LlmUsage` from `./ollama`.
- `src/lib/embeddings.ts` (81L): `embedText(ai,text)`, `embedTexts(ai,texts)` — **Cloudflare Workers AI** (`@cf/baai/bge-base-en-v1.5`, the `ai` binding), + `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`. **Different provider from Ollama.**
- Consumers: `generate` 9 src + 1 test; `chat` 3 src + 3 test; `embed` 5 src + 4 test (~25 files).

## Design — TWO ports (provider-aligned)
**`src/shared/ports/model.ts`** (pure leaf, type-only):
- contract types: `LlmUsage`, `GenerateResult`, `GenerateArgs`, `ChatMessage`, `ToolCall`, `ChatToolDef`, `ChatArgs`, `ChatResult`
- `export interface ModelProviderPort { generate(args: GenerateArgs): Promise<GenerateResult>; chat(args: ChatArgs): Promise<ChatResult> }`

**`src/shared/ports/embedding.ts`** (pure leaf, type-only):
- `export interface EmbeddingPort { embedText(ai: AiBinding, text: string): Promise<number[]>; embedTexts(ai: AiBinding, texts: ReadonlyArray<string>): Promise<number[][]> }` + `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` + the `AiBinding` type.

**Why two ports, not one:** `generate`/`chat` are Ollama; `embed` is Cloudflare Workers AI. A single `ModelProviderPort` with `embed` would force the Ollama adapter to implement a method for a provider it isn't (and vice-versa). The OpenRouter swap touches only `ModelProviderPort`; embeddings stay Cloudflare (or swap independently). This is a (minor) deviation from the issue's literal "ModelProviderPort exposing chat/embed" shorthand — flagged for sign-off.

**`src/shared/adapters/model/`** (the IO impls):
- `ollama.ts` (rename of `lib/ollama.ts`): `generate` impl; imports contract types from `../../ports/model`.
- `ollama-chat.ts` (rename): `chat` + `ChatDisabledError` + `isChatDisabledError`; types from `../../ports/model`.
- `embeddings.ts` (rename): `embedText`/`embedTexts`; types from `../../ports/embedding`.
- `index.ts` barrel = **the swap seam**: re-exports the active call surface (`generate`, `chat`, `ChatDisabledError`, `isChatDisabledError`, `embedText`, `embedTexts`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) **and** `export const ollamaModelProvider: ModelProviderPort = { generate, chat }` so SIG-362 can consume the **interface**. (Tomorrow: add `openrouter.ts`, flip the barrel — consumers untouched.)
- `ChatDisabledError` (runtime class) stays in the adapter — ports are type-only.

## Consumers (~25) — repoint, NO call-site logic change
- TYPES (`ChatMessage`, `ChatArgs`, `GenerateResult`, `LlmUsage`, …) → import from `shared/ports/model` (or `shared/ports/embedding`).
- FUNCTIONS (`generate`, `chat`, `embedText`, …) → import from the `shared/adapters/model` barrel.
- Atomic move + repoint in one PR (like P1a) → **no transitional shim left, no old-path imports remain** (satisfies "Done when").
- This does NOT force every call site onto the provider object (`ollamaModelProvider.generate`) — that DI conversion is the consumers' own future work (e.g. the ensemble via SIG-362). The object exists + the interface is defined, so SIG-362 can consume the port now. Keeps churn = import-path-only (minimal, zero-behavior).

## Zero-behavior proof
- All 3 impls move byte-identical (R-renames); type moves are `import type` (tsc-erased). The provider object is a thin `{ generate, chat }` literal over the same fns. Barrel re-exports identical symbols. Verify: `npm run build` green (tsc+eslint+vitest 6578) + golden-output parity + `tests/ollama.test.ts`, `tests/ollama-chat.test.ts`, embedding-consumer tests green.
- **P1a lesson:** tsc `include` is `src/**` only — test-file import repoints aren't typechecked, so grep every test for old paths + DTO-type-through-wrong-module before claiming done.

## Acceptance mapping (SIG-381)
interface in `shared/ports` ✓ (two) · files moved to `shared/adapters/model` ✓ · consumers repoint to port (types) + adapter barrel (impl) ✓ · zero behavior ✓ · no old-path imports remain ✓ · SIG-362 consumes `ollamaModelProvider`/`ModelProviderPort` ✓ · ADR updated (in-PR note) ✓.
