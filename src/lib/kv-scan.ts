// Shared KV-scan helpers for the on-request /metrics/* readers that page the
// `OPENCLAW_STATE` keyspace (fp-rate, graph-expansion A/B). Extracted so the
// generic pagination + bounded-concurrency fetch live in ONE place rather than
// being copied per route.

import type { Env } from "@/src/shared/types/env"

export const KV_LIST_PAGE = 1000
/** Concurrency cap for the per-key KV gets (wall-clock; doesn't change the total). */
export const FETCH_CONCURRENCY = 25

/** List keys for a prefix via the KV binding, paginated up to `cap` keys. */
export async function listKeys(env: Env, prefix: string, cap: number): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  while (names.length < cap) {
    const opts: KVNamespaceListOptions = cursor
      ? { prefix, limit: KV_LIST_PAGE, cursor }
      : { prefix, limit: KV_LIST_PAGE }
    const page = await env.OPENCLAW_STATE.list(opts)
    for (const k of page.keys) names.push(k.name)
    if (page.list_complete || !page.cursor) break
    cursor = page.cursor
  }
  return names.slice(0, cap)
}

/** Map `items` through `fn` in batches of `limit` concurrent calls. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}
