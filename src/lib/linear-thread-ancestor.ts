// SIG-225 — Linear in-thread-reply trigger.
//
// Linear's webhook handler currently only enqueues a `linear-mention`
// job when the comment body explicitly @-mentions Sigilix. That breaks
// the natural-conversation expectation: once Sigilix has commented in
// a thread, every subsequent reply from a participant should activate
// it without forcing the founder to re-type `@sigilix` each turn.
//
// This module is the pure helper the webhook calls when a comment
// arrives WITHOUT an @-mention but WITH a `parentId` (i.e. it's a
// thread reply). The helper walks the parent chain via a pre-fetched
// snapshot of the issue's comments and returns true iff any ancestor
// in the chain was authored by Sigilix (any of its bot aliases). The
// webhook treats that as an implicit mention and enqueues normally.
//
// Pure function: no IO, no env access. The caller fetches the issue's
// comments via LinearClient.getIssueWithCommentsAndAuthors and passes
// the snapshot in.

import { isBotHandle } from "./mention"

export interface LinearThreadComment {
  id: string
  /** Parent comment id; absent on top-level comments. */
  parentId?: string | null
  /** Author display + name; either field may be null on Linear's side. */
  user?: { name?: string | null; displayName?: string | null } | null
}

/**
 * Walk up the parent chain from `startParentId` through the provided
 * `comments` snapshot. Return true iff any visited ancestor was
 * authored by a Sigilix bot account (per `isBotHandle`).
 *
 * `startParentId` is the IMMEDIATE parent of the new (just-arrived)
 * comment — the new comment itself is NOT included in the walk
 * because we already know its author (the founder/user who triggered
 * the webhook), and we're looking for whether Sigilix is upstream of
 * that author in the same thread.
 *
 * Cycle defense: a `seen` set bounds the walk so a self-referencing
 * chain (malformed Linear data) can't infinite-loop. The walk also
 * stops at the first missing-from-snapshot id — if the parent isn't
 * in our snapshot, the snapshot was too small and we fail closed
 * (return false → no implicit trigger).
 */
export function commentHasSigilixAncestor(args: {
  startParentId: string | null | undefined
  comments: ReadonlyArray<LinearThreadComment>
}): boolean {
  if (!args.startParentId) return false

  const byId = new Map<string, LinearThreadComment>()
  for (const c of args.comments) byId.set(c.id, c)

  const seen = new Set<string>()
  let curId: string | null | undefined = args.startParentId
  while (typeof curId === "string" && curId.length > 0 && !seen.has(curId)) {
    seen.add(curId)
    const cur = byId.get(curId)
    if (!cur) return false // walked past our snapshot — fail closed
    const login = cur.user?.displayName ?? cur.user?.name ?? null
    if (isBotHandle(login)) return true
    curId = cur.parentId ?? null
  }
  return false
}
