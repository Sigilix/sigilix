// SIG-361 (PR 9): the canonical Sigilix bot identity, hoisted to a pure
// shared/domain leaf so the verdict domain (ensemble/domain/verdict) can
// reference it without importing the IO `dismiss-prior-reviews` module (which
// would invert the dependency rule). `dismiss-prior-reviews` re-exports it, so
// every existing importer (src/index.ts, github-mention.ts,
// pr-lifecycle-commands.ts) is unchanged.
//
// Leaf module: imports nothing.

/** The bot login under which the Sigilix App posts reviews. Pair
 *  with the body marker to defend against any review whose body
 *  happens to contain the marker but was authored by a human or
 *  another bot. If the App's slug ever changes, update here.
 *
 *  SIG-37: exported so the approval-gate helpers in `triage-pr-review.ts`
 *  can reference the same canonical login when filtering open items
 *  (review comments / threads / blocking findings) down to the
 *  Sigilix-authored subset. Sigilix's APPROVE decision must only
 *  consider its own findings — entries from CodeRabbit / Greptile /
 *  other bots / human reviewers must NOT influence the gate. */
export const SIGILIX_BOT_LOGIN = "sigilix[bot]"
