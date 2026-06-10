// ARC-182: Unit tests for the pure stack-detection module.
//
// Codex review (2026-05-11) added cases:
//   - cross-fork branch-name collision (must not false-match)
//   - same-author preference beating recency
//   - cycle/cap degradation clears the chain rather than partial-rendering
//   - upstack fork hasUpstackFork flag

import { describe, it, expect, vi } from "vitest"
import {
  detectStack,
  computeFileOverlap,
  type OpenPrInput,
  type CurrentPrInput,
} from "@/src/lib/pr-stack"

const REPO = "Sigilix/sigilix"

function pr(
  n: number,
  headRef: string,
  baseRef: string,
  opts: {
    user?: string | null
    title?: string
    headRepo?: string
    baseRepo?: string
    updated_at?: string | null
  } = {},
): OpenPrInput {
  const headRepo = opts.headRepo ?? REPO
  const baseRepo = opts.baseRepo ?? REPO
  return {
    number: n,
    title: opts.title ?? `PR ${n}`,
    user: opts.user === null ? null : { login: opts.user ?? "daniel" },
    head: { ref: headRef, repo: { full_name: headRepo } },
    base: { ref: baseRef, repo: { full_name: baseRepo } },
    updated_at: opts.updated_at ?? null,
  }
}

function current(
  n: number,
  headRef: string,
  baseRef: string,
  opts: {
    author?: string | null
    headRepo?: string
    baseRepo?: string
    updatedAt?: string | null
  } = {},
): CurrentPrInput {
  return {
    number: n,
    title: `PR ${n}`,
    headRef,
    baseRef,
    headRepo: opts.headRepo ?? REPO,
    baseRepo: opts.baseRepo ?? REPO,
    author: opts.author === undefined ? "daniel" : opts.author,
    updatedAt: opts.updatedAt ?? null,
  }
}

describe("detectStack", () => {
  it("returns no-stack when openPrs is empty", () => {
    const ctx = detectStack({
      currentPr: current(42, "feature/x", "main"),
      openPrs: [],
    })
    expect(ctx.isStacked).toBe(false)
    expect(ctx.position).toBe(1)
    expect(ctx.depth).toBe(1)
    expect(ctx.parent).toBeNull()
    expect(ctx.ancestors).toEqual([])
    expect(ctx.children).toEqual([])
    expect(ctx.root).toBeNull()
    expect(ctx.cycleDetected).toBe(false)
    expect(ctx.stackWalkCapped).toBe(false)
    expect(ctx.hasUpstackFork).toBe(false)
  })

  it("returns no-stack when no peer has matching head or base ref", () => {
    const ctx = detectStack({
      currentPr: current(42, "feature/x", "main"),
      openPrs: [pr(50, "unrelated/y", "main"), pr(51, "other/z", "main")],
    })
    expect(ctx.isStacked).toBe(false)
  })

  it("filters out the current PR itself when included in openPrs", () => {
    const ctx = detectStack({
      currentPr: current(42, "feature/x", "main"),
      openPrs: [pr(42, "feature/x", "main")],
    })
    expect(ctx.isStacked).toBe(false)
  })

  it("detects a 2-PR stack with current at top (parent, no children)", () => {
    const ctx = detectStack({
      currentPr: current(43, "user-routes", "user-model"),
      openPrs: [pr(42, "user-model", "main")],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.position).toBe(2)
    expect(ctx.depth).toBe(2)
    expect(ctx.parent?.number).toBe(42)
    expect(ctx.ancestors.map((a) => a.number)).toEqual([42])
    expect(ctx.children).toEqual([])
    expect(ctx.root?.number).toBe(42)
  })

  it("detects a 2-PR stack with current at bottom (no parent, has child)", () => {
    const ctx = detectStack({
      currentPr: current(42, "user-model", "main"),
      openPrs: [pr(43, "user-routes", "user-model")],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.position).toBe(1)
    expect(ctx.depth).toBe(2)
    expect(ctx.parent).toBeNull()
    expect(ctx.ancestors).toEqual([])
    expect(ctx.children.map((c) => c.number)).toEqual([43])
    expect(ctx.root).toBeNull()
  })

  it("detects a 3-PR stack with current in the middle", () => {
    const ctx = detectStack({
      currentPr: current(43, "user-routes", "user-model"),
      openPrs: [
        pr(42, "user-model", "main"),
        pr(44, "user-handlers", "user-routes"),
      ],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.position).toBe(2)
    expect(ctx.depth).toBe(3)
    expect(ctx.parent?.number).toBe(42)
    expect(ctx.ancestors.map((a) => a.number)).toEqual([42])
    expect(ctx.children.map((c) => c.number)).toEqual([44])
    expect(ctx.root?.number).toBe(42)
  })

  // CodeRabbit PR #72: regression test for multi-hop linear upstack
  // depth. Pre-fix, depth was computed as `ancestors + 1 + (children
  // ? 1 : 0)` which undercounts the chain when current PR is at the
  // bottom of a multi-hop linear stack.
  it("counts depth correctly for a multi-hop linear upstack from the stack root", () => {
    const ctx = detectStack({
      currentPr: current(42, "user-model", "main"),
      openPrs: [
        pr(43, "user-routes", "user-model"),
        pr(44, "user-handlers", "user-routes"),
      ],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.position).toBe(1)
    expect(ctx.depth).toBe(3) // #42 + #43 + #44
    expect(ctx.children.map((c) => c.number)).toEqual([43])
    expect(ctx.hasUpstackFork).toBe(false)
  })

  it("walks a deeper downstack chain (4 PRs)", () => {
    const ctx = detectStack({
      currentPr: current(45, "user-validation", "user-handlers"),
      openPrs: [
        pr(42, "user-model", "main"),
        pr(43, "user-routes", "user-model"),
        pr(44, "user-handlers", "user-routes"),
      ],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.position).toBe(4)
    expect(ctx.depth).toBe(4)
    expect(ctx.parent?.number).toBe(44)
    expect(ctx.ancestors.map((a) => a.number)).toEqual([42, 43, 44])
    expect(ctx.root?.number).toBe(42)
  })

  it("ancestors are ordered root → ... → parent (human reading order)", () => {
    const ctx = detectStack({
      currentPr: current(45, "user-validation", "user-handlers"),
      openPrs: [
        pr(42, "user-model", "main"),
        pr(43, "user-routes", "user-model"),
        pr(44, "user-handlers", "user-routes"),
      ],
    })
    expect(ctx.ancestors.map((a) => a.number)).toEqual([42, 43, 44])
    expect(ctx.root?.number).toBe(42)
    expect(ctx.parent?.number).toBe(44)
  })

  // ── Codex review: tiebreaking ─────────────────────────────────

  it("prefers same-author over most-recent for downstack ambiguity", () => {
    // Two PRs both have head==user-model. The cross-author PR is more
    // recent but the same-author parent wins.
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model", { author: "daniel" }),
      openPrs: [
        pr(50, "user-model", "main", { user: "other", updated_at: "2026-05-10T12:00:00Z" }),
        pr(42, "user-model", "main", { user: "daniel", updated_at: "2026-05-08T12:00:00Z" }),
      ],
    })
    expect(ctx.parent?.number).toBe(42)
  })

  it("uses most-recent updated_at when both candidates are same-author", () => {
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model", { author: "daniel" }),
      openPrs: [
        pr(50, "user-model", "main", { user: "daniel", updated_at: "2026-05-10T12:00:00Z" }),
        pr(42, "user-model", "main", { user: "daniel", updated_at: "2026-05-08T12:00:00Z" }),
      ],
    })
    // #50 is more recent → wins.
    expect(ctx.parent?.number).toBe(50)
  })

  it("falls back to lowest PR number when authors and updated_at all equal", () => {
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model"),
      openPrs: [
        pr(50, "user-model", "main"),
        pr(42, "user-model", "main"),
      ],
    })
    expect(ctx.parent?.number).toBe(42)
  })

  it("orders children: same-author → recency → PR number", () => {
    const ctx = detectStack({
      currentPr: current(42, "user-model", "main", { author: "daniel" }),
      openPrs: [
        pr(45, "user-routes-b", "user-model", { user: "someone-else", updated_at: "2026-05-10T12:00:00Z" }),
        pr(44, "user-routes-c", "user-model", { user: "daniel", updated_at: "2026-05-09T12:00:00Z" }),
        pr(43, "user-routes-a", "user-model", { user: "daniel", updated_at: "2026-05-10T12:00:00Z" }),
      ],
    })
    expect(ctx.children.map((c) => c.number)).toEqual([43, 44, 45])
  })

  // ── Codex review: repo-qualified matching (critical) ─────────

  it("does NOT match a cross-fork PR with the same branch name (head)", () => {
    // Cross-fork: a PR from fork-user/sigilix with head ref "user-model"
    // and base ref "main" (same name as ours but different repo).
    // Should NOT be the parent because the head repo differs from our
    // base repo.
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model", { baseRepo: REPO }),
      openPrs: [
        pr(50, "user-model", "main", { headRepo: "fork-user/sigilix", baseRepo: REPO }),
      ],
    })
    // The fork PR has head in a different repo from our base, so
    // it's not a parent. No other peers → no-stack.
    expect(ctx.isStacked).toBe(false)
  })

  it("does NOT match a cross-fork child PR (base in different repo)", () => {
    const ctx = detectStack({
      currentPr: current(42, "user-model", "main"),
      openPrs: [
        pr(43, "user-routes", "user-model", { headRepo: REPO, baseRepo: "fork-user/sigilix" }),
      ],
    })
    // The candidate child's base is in a different repo from our
    // head, so it's not a child.
    expect(ctx.isStacked).toBe(false)
  })

  it("preserves repo-qualified disambiguation when both fork + upstream have same branch", () => {
    // Two PRs both have head ref "user-model" but in different repos.
    // Only the upstream one matches our base.
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model", { baseRepo: REPO }),
      openPrs: [
        pr(50, "user-model", "main", { headRepo: "fork-user/sigilix", baseRepo: REPO }),
        pr(42, "user-model", "main", { headRepo: REPO, baseRepo: REPO }),
      ],
    })
    expect(ctx.parent?.number).toBe(42)
    expect(ctx.parent?.headRepo).toBe(REPO)
  })

  // ── Codex review: cycle/cap degradation ──────────────────────

  it("degrades downstack to no-parent when a cycle is detected (self-referential)", () => {
    // Self-cycle: PR 50 has head and base on the same branch.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model"),
      openPrs: [pr(50, "user-model", "user-model")],
    })
    expect(ctx.cycleDetected).toBe(true)
    expect(ctx.parent).toBeNull()
    expect(ctx.ancestors).toEqual([])
    expect(ctx.root).toBeNull()
    // CodeRabbit PR #72 major: a degraded downstack walk that
    // matched a peer must remain isStacked=true so the renderer's
    // "Parent: unknown (downstack walk degraded)" branch is
    // reachable. Pre-fix this returned isStacked=false and the
    // signal was lost entirely.
    expect(ctx.isStacked).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("degrades downstack on a 2-PR cycle (A.base = B.head AND B.base = A.head)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "branch-a"),
      openPrs: [
        pr(50, "branch-a", "branch-b"),
        pr(51, "branch-b", "branch-a"),
      ],
    })
    expect(ctx.cycleDetected).toBe(true)
    expect(ctx.ancestors).toEqual([])
    warnSpy.mockRestore()
  })

  // Sigilix self-review (PR #72): when the downstack walk degrades
  // AND children exist, the renderer must signal "parent unknown"
  // rather than "this PR is the stack root."
  it("preserves cycleDetected flag when children exist alongside degraded downstack", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model"),
      openPrs: [
        // self-cycle that degrades the downstack walk
        pr(50, "user-model", "user-model"),
        // child that uses current PR's head as its base
        pr(70, "user-handlers", "user-routes"),
      ],
    })
    // isStacked because there's a child; cycleDetected because the
    // downstack walk hit a cycle and was degraded.
    expect(ctx.isStacked).toBe(true)
    expect(ctx.cycleDetected).toBe(true)
    expect(ctx.parent).toBeNull()
    expect(ctx.ancestors).toEqual([])
    expect(ctx.children.map((c) => c.number)).toEqual([70])
    warnSpy.mockRestore()
  })

  // CodeRabbit PR #72: dedicated test for the degraded-no-children
  // case. Distinct from the "children exist alongside degraded
  // downstack" test above — here we verify the renderer-reachability
  // path: isStacked stays true even though there's neither a
  // resolved parent nor any children, so the renderer can emit
  // "Parent: unknown (walk degraded)" instead of falling back to
  // NO_STACK (which the prior behavior produced, losing the signal).
  it("keeps isStacked=true when downstack walk degraded and no children exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ctx = detectStack({
      currentPr: current(60, "user-routes", "user-model"),
      openPrs: [pr(50, "user-model", "user-model")],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.cycleDetected).toBe(true)
    expect(ctx.parent).toBeNull()
    expect(ctx.ancestors).toEqual([])
    expect(ctx.children).toEqual([])
    warnSpy.mockRestore()
  })

  it("emits 'pr-stack-down-walk-degraded' telemetry on cycle", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    detectStack({
      currentPr: current(60, "user-routes", "user-model"),
      openPrs: [pr(50, "user-model", "user-model")],
    })
    const events = warnSpy.mock.calls.map((c) => c[0]).filter((s) => typeof s === "string")
    expect(events.some((s) => (s as string).includes("pr-stack-down-walk-degraded"))).toBe(true)
    expect(events.some((s) => (s as string).includes("cycleDetected"))).toBe(true)
    warnSpy.mockRestore()
  })

  // ── Codex review: upstack fork flag ──────────────────────────

  it("flags hasUpstackFork when there are 2+ immediate children", () => {
    const ctx = detectStack({
      currentPr: current(42, "user-model", "main"),
      openPrs: [
        pr(43, "user-routes-a", "user-model"),
        pr(44, "user-routes-b", "user-model"),
        pr(45, "user-routes-c", "user-model"),
      ],
    })
    expect(ctx.isStacked).toBe(true)
    expect(ctx.children).toHaveLength(3)
    expect(ctx.hasUpstackFork).toBe(true)
    // depth is a lower bound (ancestors + 1 + 1)
    expect(ctx.depth).toBe(2)
  })

  it("does NOT flag hasUpstackFork when there is exactly 1 child", () => {
    const ctx = detectStack({
      currentPr: current(42, "user-model", "main"),
      openPrs: [pr(43, "user-routes", "user-model")],
    })
    expect(ctx.hasUpstackFork).toBe(false)
  })

  it("returns no-stack when peers have empty refs (defensive)", () => {
    const ctx = detectStack({
      currentPr: current(42, "feature/x", "main"),
      openPrs: [
        {
          number: 50, title: "bad", user: null,
          head: { ref: "" }, base: { ref: "" },
        } as OpenPrInput,
      ],
    })
    expect(ctx.isStacked).toBe(false)
  })
})

describe("computeFileOverlap", () => {
  it("handles empty inputs", () => {
    const o = computeFileOverlap({ currentFiles: [], parentFiles: [] })
    expect(o.sharedCount).toBe(0)
    expect(o.parentOnlyCount).toBe(0)
    expect(o.currentOnlyCount).toBe(0)
    expect(o.sharedFiles).toEqual([])
  })

  it("handles no overlap", () => {
    const o = computeFileOverlap({
      currentFiles: ["a.ts", "b.ts"],
      parentFiles: ["c.ts", "d.ts"],
    })
    expect(o.sharedCount).toBe(0)
    expect(o.parentOnlyCount).toBe(2)
    expect(o.currentOnlyCount).toBe(2)
    expect(o.sharedFiles).toEqual([])
  })

  it("handles full overlap", () => {
    const o = computeFileOverlap({
      currentFiles: ["a.ts", "b.ts"],
      parentFiles: ["a.ts", "b.ts"],
    })
    expect(o.sharedCount).toBe(2)
    expect(o.parentOnlyCount).toBe(0)
    expect(o.currentOnlyCount).toBe(0)
    expect(o.sharedFiles).toEqual(["a.ts", "b.ts"])
  })

  it("handles partial overlap", () => {
    const o = computeFileOverlap({
      currentFiles: ["a.ts", "b.ts", "c.ts"],
      parentFiles: ["b.ts", "c.ts", "d.ts"],
    })
    expect(o.sharedCount).toBe(2)
    expect(o.parentOnlyCount).toBe(1)
    expect(o.currentOnlyCount).toBe(1)
    expect(o.sharedFiles).toEqual(["b.ts", "c.ts"])
  })

  it("caps sharedFiles preview at 5 entries", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]
    const o = computeFileOverlap({ currentFiles: files, parentFiles: files })
    expect(o.sharedCount).toBe(7)
    expect(o.sharedFiles).toHaveLength(5)
    expect(o.sharedFiles).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])
  })

  it("dedupes within each side (set-based)", () => {
    const o = computeFileOverlap({
      currentFiles: ["a.ts", "a.ts", "b.ts"],
      parentFiles: ["a.ts", "c.ts"],
    })
    expect(o.sharedCount).toBe(1)
    expect(o.currentOnlyCount).toBe(1)
    expect(o.parentOnlyCount).toBe(1)
  })
})
