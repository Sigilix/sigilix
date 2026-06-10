import { describe, expect, it } from "vitest"
import { arcInThreadAbove } from "@/src/lib/mention"

interface TestComment {
  id: number
  in_reply_to_id?: number
  user: { login: string } | null
}

const arc = (id: number, parent?: number): TestComment => ({
  id,
  user: { login: "arc-copilot[bot]" },
  ...(parent !== undefined ? { in_reply_to_id: parent } : {}),
})
const human = (id: number, parent?: number): TestComment => ({
  id,
  user: { login: "danny" },
  ...(parent !== undefined ? { in_reply_to_id: parent } : {}),
})

describe("arcInThreadAbove", () => {
  it("returns false on a fresh top-level comment (no in_reply_to_id, no chain)", () => {
    const comments = [human(1)]
    expect(arcInThreadAbove(comments, 1)).toBe(false)
  })

  it("returns true when the immediate parent is Arc (most common case)", () => {
    const comments = [arc(1), human(2, 1)]
    expect(arcInThreadAbove(comments, 2)).toBe(true)
  })

  it("returns true when Arc is two levels up the chain (arc → human → human-reply)", () => {
    const comments = [arc(1), human(2, 1), human(3, 2)]
    expect(arcInThreadAbove(comments, 3)).toBe(true)
  })

  it("returns false when the chain is human-only (no Arc above)", () => {
    const comments = [human(1), human(2, 1), human(3, 2)]
    expect(arcInThreadAbove(comments, 3)).toBe(false)
  })

  it("returns false when source comment is missing from list", () => {
    const comments = [arc(1)]
    expect(arcInThreadAbove(comments, 999)).toBe(false)
  })

  it("returns true for sigilix[bot] and every legacy alias (handle variants)", () => {
    const variants = [
      "sigilix",
      "sigilix[bot]",
      "Sigilix[bot]",
      "arc",
      "arc[bot]",
      "Arc[bot]",
      "arc-copilot[bot]",
      "openclaw[bot]",
    ]
    for (const login of variants) {
      const parent = { id: 1, user: { login } }
      const comments = [parent as TestComment, human(2, 1)]
      expect(arcInThreadAbove(comments, 2)).toBe(true)
    }
  })

  it("does NOT match coderabbit or other bots", () => {
    const cr = { id: 1, user: { login: "coderabbitai[bot]" } } as TestComment
    const comments = [cr, human(2, 1)]
    expect(arcInThreadAbove(comments, 2)).toBe(false)
  })

  it("returns false when parent id points to a missing comment (broken chain)", () => {
    const comments = [human(2, 999)]  // parent 999 doesn't exist
    expect(arcInThreadAbove(comments, 2)).toBe(false)
  })

  it("does not infinite-loop on a self-referential chain (cycle detection)", () => {
    // Pathological: comment 1 says it replies to itself.
    const comments = [{ id: 1, in_reply_to_id: 1, user: { login: "danny" } }] as TestComment[]
    expect(arcInThreadAbove(comments, 1)).toBe(false)
  })

  it("does not infinite-loop on a multi-comment cycle (1 → 2 → 1)", () => {
    const comments = [
      { id: 1, in_reply_to_id: 2, user: { login: "danny" } },
      { id: 2, in_reply_to_id: 1, user: { login: "danny" } },
    ] as TestComment[]
    expect(arcInThreadAbove(comments, 1)).toBe(false)
  })

  it("still finds Arc when the chain exceeds the legacy 32-iter cap", () => {
    // Build a 100-deep chain of humans with Arc at the very top.
    // The old fixed cap would return false here even though Arc IS
    // above; the visited-set fix correctly walks the whole chain.
    const comments: TestComment[] = [arc(0)]
    for (let i = 1; i <= 100; i++) {
      comments.push(human(i, i - 1))
    }
    expect(arcInThreadAbove(comments, 100)).toBe(true)
  })

  it("handles comments with null user (deleted accounts)", () => {
    const orphan = { id: 1, user: null } as TestComment
    const comments = [orphan, human(2, 1)]
    expect(arcInThreadAbove(comments, 2)).toBe(false)
  })
})
