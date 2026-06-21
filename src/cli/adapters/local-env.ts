// SIG-304 (review CLI) — a local `Env` factory for running the review engine headless
// in Node, with NO Cloudflare bindings. The review hot path is fetch-only; every
// binding is best-effort-on-write or flag-gated-off, so the engine degrades to a
// diff-only review when they are inert (no Vectorize/graph retrieval, no DO state).
//
// What this provides:
//   - OPENCLAW_STATE: a real IN-MEMORY KVNamespace (a Map). KV writes in the engine
//     are post-decision + must-not-bubble, but reads expect a working shape, so we
//     back it with a live Map rather than a throwing stub.
//   - the DO namespaces + Vectorize + AI + Queue: present-but-no-op stubs (they must
//     be PRESENT to satisfy `Env`, but the diff-only path never drives them).
//   - secrets/model keys + flags: read from `process.env` (BYO models); ensemble
//     flags are left unset so `parseEnsembleConfig` yields all-default (retrieval/
//     graph/multibatch off) — the proven zero-binding regime.
//
// This is a deliberate binding-stub adapter, hence the single `as unknown as Env` at
// the end (the same shape the DO tests use); every field the engine reads on the
// diff-only path is backed by a working impl above it.

import type { Env } from "@/src/shared/types/env"

/** A minimal in-memory KVNamespace over a Map — enough for the engine's best-effort
 *  reads/writes (review-memory, retrieval-cache, daily-budget). TTL/metadata are
 *  accepted and ignored; `list` returns a flat key set. */
function inMemoryKv(store: Map<string, string> = new Map()): KVNamespace {
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

/** A present-but-inert DurableObjectNamespace: `idFromName`/`newUniqueId` return a
 *  marker id and `get` returns a stub whose `fetch` resolves to an empty 200 — the
 *  engine's DO calls are all best-effort and never read a meaningful body in the
 *  diff-only regime. */
function noopDurableObject(): DurableObjectNamespace {
  const stub = {
    fetch: async () => new Response(null, { status: 200 }),
  } as unknown as DurableObjectStub
  return {
    idFromName: (name: string) => ({ toString: () => name, equals: () => false }) as unknown as DurableObjectId,
    idFromString: (id: string) => ({ toString: () => id, equals: () => false }) as unknown as DurableObjectId,
    newUniqueId: () => ({ toString: () => "local", equals: () => false }) as unknown as DurableObjectId,
    get: () => stub,
  } as unknown as DurableObjectNamespace
}

export interface LocalEnvOptions {
  /** Source for secrets + model keys + flag overrides. Defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>
  /** Optional backing store for the in-memory KV (e.g. a JSON-file-backed Map). */
  kvStore?: Map<string, string>
}

/**
 * Build an `Env` for a headless/CLI review run. NO real Cloudflare bindings — the
 * engine runs diff-only. Secrets + model keys come from `process.env` (BYO models);
 * ensemble flags are left unset (all-default). Use with `handlePrReviewEnsemble`'s
 * `dryRun: true` + an injected `githubClient` so nothing is posted.
 */
export function createLocalEnv(options: LocalEnvOptions = {}): Env {
  const src = options.processEnv ?? process.env
  const dobj = noopDurableObject()
  return {
    ...src,
    OPENCLAW_STATE: inMemoryKv(options.kvStore),
    OPENCLAW_CODE_INDEX: {
      query: async () => ({ matches: [] }),
      insert: async () => undefined,
      upsert: async () => undefined,
    } as unknown as Env["OPENCLAW_CODE_INDEX"],
    AI: {
      run: async () => {
        throw new Error("local-env: AI binding is not available (diff-only review)")
      },
    } as unknown as Env["AI"],
    OPENCLAW_JOBS: { send: async () => undefined, sendBatch: async () => undefined } as unknown as Env["OPENCLAW_JOBS"],
    PR_REVIEW_RUN: dobj,
    REPO_GRAPH_DO: dobj,
    VALIDATION_METRICS_DO: dobj,
    GRAPH_METRICS_DO: dobj,
    RUNNER_EVIDENCE_METRICS_DO: dobj,
    RUNNER_TOOL_METRICS_DO: dobj,
    VERIFICATION_METRICS_DO: dobj,
    GRAPH_EXPANSION_METRICS_DO: dobj,
    RUNNER_RECEIPT_DO: dobj,
  } as unknown as Env
}
