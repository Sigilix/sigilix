// Shared fixtures for the dynamic-dispatcher.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).
//
// NB: the per-file `vi.hoisted`/`vi.mock("…/ollama-chat")` factory +
// `beforeEach`/`afterEach` are NOT here — vitest hoists `vi.mock` per
// file and mock state does not cross files, so the LLM-orchestration
// sibling declares them inline.

import type { ClassifiedDiffFile } from "@/lib/diff-file-classify"
import type { SigilixConfig } from "@/lib/sigilix-config"
import type { Env } from "@/shared/types/env"

export const EMPTY_CONFIG: SigilixConfig = {}

export type DispatcherEnv = Pick<
  Env,
  "OLLAMA_API_KEY" | "OLLAMA_CHAT_ENABLE" | "OPENCLAW_DYNAMIC_DISPATCHER_MODE"
>

export function envOff(): DispatcherEnv {
  // `OPENCLAW_DYNAMIC_DISPATCHER_MODE` intentionally omitted — that's
  // the "off" path (default mode is absent / not "shadow"|"enforce").
  return {
    OLLAMA_API_KEY: "fake-key",
    OLLAMA_CHAT_ENABLE: "on",
  }
}

export function envShadow(overrides: Partial<DispatcherEnv> = {}): DispatcherEnv {
  return {
    OLLAMA_API_KEY: "fake-key",
    OLLAMA_CHAT_ENABLE: "on",
    OPENCLAW_DYNAMIC_DISPATCHER_MODE: "shadow",
    ...overrides,
  }
}

export function classifiedFor(paths: string[]): ClassifiedDiffFile[] {
  return paths.map((p) => ({
    path: p,
    kind: p.endsWith(".md") ? "docs" : p.endsWith(".css") ? "other" : "source",
    testsSibling: null,
    sourceSibling: null,
  }))
}
