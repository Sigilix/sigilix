import { describe, expect, it } from "vitest"
import {
  MAX_APP_MEMORY_CONTEXT_CANDIDATES_PER_SCOPE,
  resolveAppMemoryCliMode,
  selectAppMemoryContext,
  type AppMemoryContextCandidate,
} from "./context"

function candidate(id: string, content: string, createdAtMs: number): AppMemoryContextCandidate {
  return { id, content, createdAtMs }
}

describe("managed CLI app-memory mode", () => {
  it("defaults missing, blank, false-like, and unknown values to off", () => {
    expect(resolveAppMemoryCliMode({})).toBe("off")
    expect(
      resolveAppMemoryCliMode({ OPENCLAW_APP_MEMORY_CLI_MODE: null } as unknown as Parameters<
        typeof resolveAppMemoryCliMode
      >[0]),
    ).toBe("off")
    for (const raw of ["", " ", "0", "false", "unknown"]) {
      expect(resolveAppMemoryCliMode({ OPENCLAW_APP_MEMORY_CLI_MODE: raw })).toBe("off")
    }
  })

  it("accepts shadow/on case-insensitively", () => {
    expect(resolveAppMemoryCliMode({ OPENCLAW_APP_MEMORY_CLI_MODE: " SHADOW " })).toBe("shadow")
    expect(resolveAppMemoryCliMode({ OPENCLAW_APP_MEMORY_CLI_MODE: "On" })).toBe("on")
  })
})

describe("managed CLI app-memory selection", () => {
  it("keeps personal context first and lets it win canonical case/whitespace duplicates", () => {
    const selection = selectAppMemoryContext({
      personal: [
        candidate("personal-old", "shared rule", 100),
        candidate("personal-new", "  Shared\n\tRULE  ", 200),
        candidate("personal-other", "Personal only", 150),
      ],
      organization: [candidate("org-duplicate", "SHARED   rule", 400), candidate("org-only", "Organization only", 300)],
    })

    expect(selection.memories).toEqual([
      {
        id: "personal-new",
        scope: "personal",
        content: "  Shared\n\tRULE  ",
        source: "managed-app",
      },
      {
        id: "personal-other",
        scope: "personal",
        content: "Personal only",
        source: "managed-app",
      },
      {
        id: "org-only",
        scope: "organization",
        content: "Organization only",
        source: "managed-app",
      },
    ])
    expect(selection.stats.personal).toEqual({
      candidateCount: 3,
      selectedCount: 2,
      selectedChars: "  Shared\n\tRULE  ".length + "Personal only".length,
      truncated: true,
    })
    expect(selection.stats.organization).toEqual({
      candidateCount: 2,
      selectedCount: 1,
      selectedChars: "Organization only".length,
      truncated: true,
    })
  })

  it("bounds each scope independently, keeps whole entries, and backfills after skips", () => {
    const personal = [
      candidate("p-new", "personal-new", 900),
      candidate("p-2000", "p".repeat(2_000), 800),
      candidate("p-too-large-for-remainder", "x".repeat(1_500), 700),
      candidate("p-backfill", "b".repeat(900), 600),
      candidate("p-fourth", "personal-fourth", 500),
      candidate("p-fifth", "personal-fifth", 400),
      candidate("p-sixth", "personal-sixth", 300),
      candidate("p-seventh", "personal-seventh", 200),
      candidate("p-beyond-candidates", "must-not-be-a-candidate", 100),
    ]
    const organization = [
      candidate("o-new", "org-new", 900),
      candidate("o-2000", "o".repeat(2_000), 800),
      candidate("o-too-large-for-remainder", "y".repeat(1_500), 700),
      candidate("o-backfill", "c".repeat(900), 600),
      candidate("o-fourth", "org-fourth", 500),
    ]

    const selection = selectAppMemoryContext({ personal, organization })

    expect(selection.memories.map((memory) => memory.id)).toEqual([
      "p-new",
      "p-2000",
      "p-backfill",
      "p-fourth",
      "o-new",
      "o-2000",
      "o-backfill",
      "o-fourth",
    ])
    expect(selection.stats.personal.candidateCount).toBe(MAX_APP_MEMORY_CONTEXT_CANDIDATES_PER_SCOPE)
    expect(selection.stats.personal.selectedCount).toBe(4)
    expect(selection.stats.personal.selectedChars).toBeLessThanOrEqual(3_000)
    expect(selection.stats.personal.truncated).toBe(true)
    expect(selection.stats.organization.selectedCount).toBe(4)
    expect(selection.stats.organization.selectedChars).toBeLessThanOrEqual(3_000)
    expect(selection.memories.some((memory) => memory.content.length === 1_500)).toBe(false)
  })

  it("orders timestamp ties by id descending", () => {
    const selection = selectAppMemoryContext({
      personal: [candidate("appmem_a", "A", 100), candidate("appmem_z", "Z", 100)],
      organization: [],
    })
    expect(selection.memories.map((memory) => memory.id)).toEqual(["appmem_z", "appmem_a"])
  })
})
