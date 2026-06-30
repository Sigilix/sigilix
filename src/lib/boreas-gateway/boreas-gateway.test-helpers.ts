// SIG-545 — shared, pure test fixtures for the Boreas-gateway suites. NOT a
// `*.test.ts` file, so vitest doesn't collect it as a suite. Factory functions
// return fresh objects so no state leaks across the sibling test files.

import type { Env } from "@/src/shared/types/env"

/**
 * A valid AES-256 key for OPENCLAW_SESSION_ENCRYPTION_KEY: 43 base64url chars that
 * decode to exactly 32 bytes (all-zero) — what auth-session.ts's importAesKey requires.
 */
export const TEST_ENCRYPTION_KEY = "A".repeat(43)

/** A minimal in-memory KVNamespace over a Map. TTL/metadata are accepted + ignored. */
export function inMemoryKv(store: Map<string, string> = new Map()): KVNamespace {
  return {
    get: (async (key: string) => store.get(key) ?? null) as KVNamespace["get"],
    getWithMetadata: (async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    })) as KVNamespace["getWithMetadata"],
    put: (async (key: string, value: string) => {
      store.set(key, typeof value === "string" ? value : String(value))
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key)
    }) as KVNamespace["delete"],
    list: (async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })) as KVNamespace["list"],
  } as unknown as KVNamespace
}

/** An ExecutionContext that records waitUntil promises so a test can await them. */
export function makeCtx(): { ctx: ExecutionContext; waits: Promise<unknown>[] } {
  const waits: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p)
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { ctx, waits }
}

/** Build an Env with an in-memory OPENCLAW_STATE + a valid at-rest encryption key,
 *  overridable per-field (pass `{ OPENCLAW_SESSION_ENCRYPTION_KEY: undefined }` to
 *  exercise the fail-closed path). */
export function makeEnv(over: Partial<Record<keyof Env, unknown>> = {}, store?: Map<string, string>): Env {
  return {
    OPENCLAW_STATE: inMemoryKv(store),
    OPENCLAW_SESSION_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ...over,
  } as unknown as Env
}
