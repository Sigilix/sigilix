// ARC-182: Graphite-style PR stack detection (pure).
//
// A "stack" is a chain of open PRs where each PR's base branch is the
// previous PR's head branch:
//
//     #41 main          → branch user-model       (base: main, head: user-model)
//     #42 user-model    → branch user-routes      (base: user-model, head: user-routes)
//     #43 user-routes   → branch user-handlers    (base: user-routes, head: user-handlers)
//
// Each PR reviewed in isolation surfaces false-positive findings ("this
// code assumes X") when X is established earlier in the stack. The
// detector here produces a `StackContext` that the prompt builder uses
// to:
//
//   - inject stack metadata into the review prompt (position, parent,
//     children, file overlap)
//   - tag findings with `stackOrigin` so the model distinguishes
//     issues this PR introduced from issues already present in
//     downstack PRs
//
// Pure module — no I/O, no async. Caller (handlePrReview /
// handlePrReviewEnsemble) is responsible for fetching the open-PRs
// list via GitHubClient.listOpenPullRequests.
//
// Codex review (2026-05-11) corrections applied:
//   - Repo-qualified branch matching (cross-fork branch-name reuse
//     no longer false-matches a parent)
//   - Same-author → updated_at → PR number tiebreaking for downstack
//     ambiguity
//   - Cycle / cap fully degrades to "ambiguous downstack" with
//     cycleDetected flag (no partial chain rendered)
//   - hasUpstackFork flag for forked upstack so depth is documented
//     as a lower bound
//   - Telemetry shape includes openPrCount, openPrsTruncated,
//     cycleDetected, stackWalkCapped, hasUpstackFork
//
// Spec: docs/superpowers/specs/2026-05-11-arc-182-stack-aware-review-design.md

/** A single PR in the stack. Repo-qualified so cross-fork branch-name
 * reuse (e.g., both `main-fork-A/user-model` and `main-fork-B/user-model`)
 * does not produce false parent/child matches. */
export interface StackPr {
  number: number
  title: string
  headRef: string
  baseRef: string
  /** Repo `full_name` (e.g., "Arc-and-Anchor/sigilix" or "fork/sigilix")
   * where the head branch lives. Used to disambiguate same-named
   * branches across forks. */
  headRepo: string
  /** Repo `full_name` of the base branch. For typical open PRs this is
   * the upstream repo; for cross-fork PRs the head may differ from base. */
  baseRepo: string
  author: string | null
  /** ISO 8601 timestamp from GitHub's `updated_at`. Used for
   * deterministic tiebreaking when multiple peer PRs match the same
   * branch ref. */
  updatedAt: string | null
}

/** Stack context for the current PR. Always defined; when the PR is
 * not stacked, `isStacked` is `false` and the other fields take
 * no-stack defaults. */
export interface StackContext {
  isStacked: boolean
  /** 1-indexed position in the stack. 1 = root of stack. For unstacked
   * PRs, position is 1 and depth is 1. */
  position: number
  /** Total PRs in this stack, including the current PR. **Lower bound**
   * when `hasUpstackFork` is true — the detector reports immediate
   * children only and does not walk multiple upstack branches. */
  depth: number
  /** Immediate downstack parent (current PR's base == parent's head, in
   * the SAME repo), or null if this PR is the stack root, unstacked,
   * or the downstack walk degraded to ambiguous. */
  parent: StackPr | null
  /** Full downstack chain from root → ... → parent. Empty when this
   * PR is at the bottom of the stack, unstacked, or the walk degraded. */
  ancestors: StackPr[]
  /** Immediate upstack children (their base == current PR's head, in
   * the SAME repo). */
  children: StackPr[]
  /** Bottom of the stack — the deepest downstack PR. Null when the
   * current PR is the root, unstacked, or the walk degraded. */
  root: StackPr | null
  /** Set when the downstack walk encountered a cycle. When true, the
   * detector has cleared `parent` / `ancestors` / `root` to avoid
   * presenting a misleading partial chain. */
  cycleDetected: boolean
  /** Set when the downstack walk hit `MAX_CHAIN_HOPS` before reaching
   * a non-PR base. Same degradation as `cycleDetected`. */
  stackWalkCapped: boolean
  /** True when there are 2+ immediate children — the upstack is forked
   * and `depth` is a lower bound. */
  hasUpstackFork: boolean
}

/** Shape accepted from GitHub's `GET /repos/.../pulls?state=open`
 * response. Only the fields the detector needs. */
export interface OpenPrInput {
  number: number
  title: string
  user: { login: string } | null
  head: { ref: string; repo?: { full_name: string } | null }
  base: { ref: string; repo?: { full_name: string } | null }
  /** ISO 8601 timestamp; optional for backwards-compat with simpler
   * test fixtures. Treated as `null` when absent — chains relying on
   * recency-based tiebreaking fall through to PR-number ordering. */
  updated_at?: string | null
}

/** Shape for the currently-reviewed PR. */
export interface CurrentPrInput {
  number: number
  title: string
  headRef: string
  baseRef: string
  headRepo: string
  baseRepo: string
  author: string | null
  /** ISO 8601 timestamp; optional. */
  updatedAt?: string | null
}

/** Maximum chain length the walker will follow before giving up.
 * Defensive against pathological inputs (cycles, fork-graphs with
 * thousands of PRs). 16 is well beyond any reasonable Graphite stack
 * depth (typical 2-5). */
const MAX_CHAIN_HOPS = 16

const NO_STACK: StackContext = {
  isStacked: false,
  position: 1,
  depth: 1,
  parent: null,
  ancestors: [],
  children: [],
  root: null,
  cycleDetected: false,
  stackWalkCapped: false,
  hasUpstackFork: false,
}

function toStackPr(p: OpenPrInput): StackPr {
  const headRepo = p.head?.repo?.full_name ?? ""
  const baseRepo = p.base?.repo?.full_name ?? ""
  return {
    number: p.number,
    title: p.title,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    headRepo,
    baseRepo,
    author: p.user?.login ?? null,
    updatedAt: p.updated_at ?? null,
  }
}

/** Composite key for repo-qualified branch lookups: `<repo>::<ref>`.
 * Two open PRs whose head branches are both named `feature/foo` but
 * live in different repos (e.g., a fork) produce distinct keys and do
 * not false-match. */
function refKey(repo: string, ref: string): string {
  return `${repo}::${ref}`
}

/** Compare two `updated_at` strings; null sorts last (treated as
 * oldest). Returns negative if `a` is more recent than `b`. */
function compareRecency(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  // ISO 8601 sorts lexicographically as time.
  return b.localeCompare(a)
}

/**
 * Detect Graphite-style stack relationships for `currentPr` given the
 * list of open PRs in the same repo.
 *
 * Stack signal: `currentPr.baseRef == parent.headRef` AND
 * `currentPr.baseRepo == parent.headRepo` (repo-qualified — see
 * Codex review notes).
 *
 * Tiebreaking when multiple peers share the same head ref:
 *   1. Same author as current PR (Graphite stacks are virtually
 *      always single-author chains)
 *   2. Most recently updated (`updated_at` DESC)
 *   3. Lowest PR number (stable fallback)
 *
 * Cycle/cap behavior: if the downstack walk visits the same PR twice
 * or exceeds `MAX_CHAIN_HOPS`, the detector clears `parent` /
 * `ancestors` / `root` and sets `cycleDetected` or `stackWalkCapped`.
 * This avoids presenting a misleading "position 5 of 16" stack from
 * a pathological graph.
 *
 * Upstack: only immediate children are reported. When multiple
 * children exist, `hasUpstackFork` is true and `depth` is a lower
 * bound (depth = ancestors + 1 + 1).
 */
export function detectStack(args: {
  currentPr: CurrentPrInput
  openPrs: ReadonlyArray<OpenPrInput>
}): StackContext {
  const { currentPr, openPrs } = args

  // Filter out the current PR itself (if the caller included it in
  // openPrs) and PRs with empty refs (defensive; GitHub shouldn't
  // emit these but the type allows it).
  const peers: OpenPrInput[] = []
  for (const p of openPrs) {
    if (p.number === currentPr.number) continue
    if (!p.head?.ref || !p.base?.ref) continue
    peers.push(p)
  }

  if (peers.length === 0) {
    return NO_STACK
  }

  // Index for fast lookups during chain walks. Composite key
  // `<repo>::<ref>` so cross-fork branch-name reuse doesn't collide.
  const peersByHeadKey = new Map<string, OpenPrInput[]>()
  const peersByBaseKey = new Map<string, OpenPrInput[]>()
  for (const p of peers) {
    const headRepo = p.head?.repo?.full_name ?? ""
    const baseRepo = p.base?.repo?.full_name ?? ""
    const headKey = refKey(headRepo, p.head.ref)
    const baseKey = refKey(baseRepo, p.base.ref)
    const headBucket = peersByHeadKey.get(headKey) ?? []
    headBucket.push(p)
    peersByHeadKey.set(headKey, headBucket)
    const baseBucket = peersByBaseKey.get(baseKey) ?? []
    baseBucket.push(p)
    peersByBaseKey.set(baseKey, baseBucket)
  }

  // ── Downstack walk: ancestors ────────────────────────────────
  //
  // Start from currentPr's (baseRepo, baseRef). If some peer's
  // (headRepo, headRef) matches, that peer is the parent candidate.
  // Recurse on parent.base. Tiebreaker (when multiple candidates):
  // same-author → most-recent → lowest PR number.
  const ancestors: StackPr[] = []
  const visitedDown = new Set<number>()
  let cursorRepo: string = currentPr.baseRepo
  let cursorRef: string | null = currentPr.baseRef
  let downHops = 0
  let cycleDetectedDown = false
  let cappedDown = false

  while (cursorRef && downHops < MAX_CHAIN_HOPS) {
    const candidates = peersByHeadKey.get(refKey(cursorRepo, cursorRef)) ?? []
    if (candidates.length === 0) {
      // No open PR with head matching cursor → bottom of the chain
      // reached. Successful walk termination.
      break
    }
    // Tiebreak: same-author DESC, then updated_at DESC, then PR
    // number ASC.
    const next = candidates.slice().sort((a, b) => {
      const aSameAuthor = (a.user?.login ?? null) === currentPr.author ? 0 : 1
      const bSameAuthor = (b.user?.login ?? null) === currentPr.author ? 0 : 1
      if (aSameAuthor !== bSameAuthor) return aSameAuthor - bSameAuthor
      const recencyCmp = compareRecency(a.updated_at ?? null, b.updated_at ?? null)
      if (recencyCmp !== 0) return recencyCmp
      return a.number - b.number
    })[0]!
    if (visitedDown.has(next.number)) {
      cycleDetectedDown = true
      break
    }
    visitedDown.add(next.number)
    ancestors.push(toStackPr(next))
    cursorRepo = next.base?.repo?.full_name ?? ""
    cursorRef = next.base.ref
    downHops++
  }
  if (downHops >= MAX_CHAIN_HOPS) {
    cappedDown = true
  }

  // Codex review correction: on cycle or cap, fully degrade the
  // downstack chain. Don't present a misleading "position 5 of 16"
  // partial chain to the model — that confuses more than it helps.
  // The walk's telemetry still fires below so the operator can see
  // what happened.
  if (cycleDetectedDown || cappedDown) {
    // eslint-disable-next-line no-console -- intentional telemetry
    console.warn(
      JSON.stringify({
        event: "pr-stack-down-walk-degraded",
        currentPr: currentPr.number,
        hops: downHops,
        cycleDetected: cycleDetectedDown,
        capped: cappedDown,
        collected: ancestors.length,
      }),
    )
    ancestors.length = 0
  }

  // ancestors[] is in order: parent → grandparent → ... → root.
  // Spec promises ancestors are ordered root → ... → parent (closer
  // to human reading order). Reverse to match.
  ancestors.reverse()

  const parent: StackPr | null =
    ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null

  // ── Upstack walk: immediate children ─────────────────────────
  //
  // Children = open PRs whose (baseRepo, baseRef) matches current PR's
  // (headRepo, headRef). Only immediate children — see Codex review:
  // walking multiple child chains produces ambiguous depth and is
  // deferred to a follow-up. `hasUpstackFork` is reported when there
  // are 2+ children so the caller knows depth is a lower bound.
  const childKey = refKey(currentPr.headRepo, currentPr.headRef)
  const immediateChildren = (peersByBaseKey.get(childKey) ?? []).map(toStackPr)

  // Deterministic ordering: same-author → most-recent → PR number.
  immediateChildren.sort((a, b) => {
    const aSame = a.author === currentPr.author ? 0 : 1
    const bSame = b.author === currentPr.author ? 0 : 1
    if (aSame !== bSame) return aSame - bSame
    const recencyCmp = compareRecency(a.updatedAt, b.updatedAt)
    if (recencyCmp !== 0) return recencyCmp
    return a.number - b.number
  })

  const hasUpstackFork = immediateChildren.length > 1

  // ── Position / depth / root ──────────────────────────────────

  const upstackCount = immediateChildren.length > 0 ? 1 : 0
  const depth = ancestors.length + 1 + upstackCount
  const position = ancestors.length + 1
  const root: StackPr | null = ancestors.length > 0 ? ancestors[0]! : null

  const isStacked = parent !== null || immediateChildren.length > 0

  if (!isStacked) {
    return {
      ...NO_STACK,
      cycleDetected: cycleDetectedDown,
      stackWalkCapped: cappedDown,
    }
  }

  return {
    isStacked: true,
    position,
    depth,
    parent,
    ancestors,
    children: immediateChildren,
    root,
    cycleDetected: cycleDetectedDown,
    stackWalkCapped: cappedDown,
    hasUpstackFork,
  }
}

/** File overlap stats between the current PR's changed-file set and
 * its downstack parent's changed-file set. */
export interface FileOverlap {
  sharedCount: number
  parentOnlyCount: number
  currentOnlyCount: number
  /** Up to 5 shared filenames for prompt context. Sorted ascending. */
  sharedFiles: string[]
}

/** Compute file overlap. Empty parent → all current files are
 * current-only and shared is empty. */
export function computeFileOverlap(args: {
  currentFiles: ReadonlyArray<string>
  parentFiles: ReadonlyArray<string>
}): FileOverlap {
  const parentSet = new Set(args.parentFiles)
  const currentSet = new Set(args.currentFiles)
  const shared: string[] = []
  let currentOnly = 0
  for (const f of currentSet) {
    if (parentSet.has(f)) shared.push(f)
    else currentOnly++
  }
  let parentOnly = 0
  for (const f of parentSet) {
    if (!currentSet.has(f)) parentOnly++
  }
  shared.sort()
  return {
    sharedCount: shared.length,
    parentOnlyCount: parentOnly,
    currentOnlyCount: currentOnly,
    sharedFiles: shared.slice(0, 5),
  }
}
