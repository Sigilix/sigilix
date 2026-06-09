// KV / Vectorize keyspace tokens for the per-branch index namespace.
//
// `BRANCH_STATE_SEGMENT` is the literal segment that marks a branch-scoped
// index namespace: `<owner>/<repo>/__branch__/<encodedBranch>`. It lives in a
// pure shared/domain leaf so the canonical keyspace builder
// (`src/lib/index-branch.ts`) and the GitHub installation adapter
// (`src/shared/adapters/github/github-installation.ts`) read ONE source of
// truth. The clean-arch dependency rule forbids the adapter importing from
// `lib`, and a silently-drifting inline copy of a production keyspace token is
// exactly the cross-layer hazard this layer exists to remove.
//
// Leaf module: zero imports. Keep it that way.

/** Keyspace segment marking a branch-scoped index namespace. */
export const BRANCH_STATE_SEGMENT = "__branch__"
