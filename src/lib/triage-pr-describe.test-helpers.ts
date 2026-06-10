// Shared fixtures for the triage-pr-describe.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).
//
// NB: the per-file `vi.mock` factories + mock fns + `beforeEach` are NOT
// here — vitest hoists `vi.mock` per file and mock state does not cross
// files, so each sibling declares them inline.

import type { Env } from "@/shared/types/env"

export interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  deletes: string[]
}

export function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const deletes: string[] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      deletes.push(key)
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, deletes }
}

export function makeEnv(kv: Env["OPENCLAW_STATE"], overrides?: Partial<Env>): Env {
  return {
    OPENCLAW_STATE: kv,
    OLLAMA_API_KEY: "fake-ollama",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_MODEL: undefined,
    OPENCLAW_SENSITIVE_REPOS: undefined,
    ...overrides,
  } as unknown as Env
}
