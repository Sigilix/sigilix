// SIG-44 — multi-corpus retrieval (merged PRs + Linear issues) unit tests.

import { describe, it, expect, vi } from "vitest"
import {
  prNamespace,
  issueNamespace,
  buildPrCorpusText,
  buildIssueCorpusText,
  prDocId,
  issueDocId,
  upsertPrDoc,
  upsertIssueDoc,
  retrieveMultiCorpus,
  formatMultiCorpusForPrompt,
  multiCorpusEnabled,
  deriveVerdictLabel,
  type MultiCorpusEnv,
  type MultiCorpusResult,
} from "@/lib/multi-corpus"

describe("multiCorpusEnabled", () => {
  it("is on only for flag === 'on'", () => {
    expect(multiCorpusEnabled({ OPENCLAW_MULTICORPUS_RETRIEVAL: "on" })).toBe(true)
    expect(multiCorpusEnabled({ OPENCLAW_MULTICORPUS_RETRIEVAL: " ON" })).toBe(true)
    expect(multiCorpusEnabled({ OPENCLAW_MULTICORPUS_RETRIEVAL: "shadow" })).toBe(false)
    expect(multiCorpusEnabled({})).toBe(false)
  })
})

describe("deriveVerdictLabel", () => {
  it("maps manifest findings (score-only) to coarse corpus buckets", () => {
    // The persisted manifest has no `category`, so this approximates the live
    // (category-aware) verdict by the score floor: any score>=4 → changes_required.
    expect(deriveVerdictLabel([{ score: 4 }, { score: 1 }])).toBe("changes_required")
    expect(deriveVerdictLabel([{ score: 2 }, { score: 3 }])).toBe("commented")
    expect(deriveVerdictLabel([])).toBe("approved")
  })
  it("returns undefined when there was no review (no manifest)", () => {
    expect(deriveVerdictLabel(undefined)).toBeUndefined()
  })
})

const EMBED_DIMS = 768
const fakeVec = () => Array(EMBED_DIMS).fill(0.1)

function makeEnv(matchesByNamespace: Record<string, { id: string; score: number; metadata: Record<string, unknown> }[]>): {
  env: MultiCorpusEnv
  upserts: { namespace: string; id: string; metadata: Record<string, unknown> }[]
} {
  const upserts: { namespace: string; id: string; metadata: Record<string, unknown> }[] = []
  const env = {
    AI: { run: vi.fn(async () => ({ data: [fakeVec()] })) },
    OPENCLAW_CODE_INDEX: {
      query: vi.fn(async (_v: number[], o: { namespace?: string }) => ({
        matches: matchesByNamespace[o.namespace ?? ""] ?? [],
      })),
      upsert: vi.fn(async (records: { namespace: string; id: string; metadata: Record<string, unknown> }[]) => {
        upserts.push(...records)
        return {}
      }),
    },
  } as unknown as MultiCorpusEnv
  return { env, upserts }
}

describe("namespaces", () => {
  it("prefixes the code namespace", () => {
    expect(prNamespace("Acme", "Widgets")).toBe("pr:acme/widgets")
    expect(issueNamespace("Acme", "Widgets")).toBe("issue:acme/widgets")
  })
})

describe("embed-text builders", () => {
  it("leads with PR number + title, then body, then verdict", () => {
    const t = buildPrCorpusText({ owner: "a", repo: "b", number: 234, title: "Fix retry", body: "use backoff", verdict: "changes_required" })
    expect(t).toBe("PR #234: Fix retry\nuse backoff\nVerdict: changes_required")
  })
  it("omits empty body/verdict", () => {
    expect(buildPrCorpusText({ owner: "a", repo: "b", number: 1, title: "T", body: "  " })).toBe("PR #1: T")
  })
  it("builds issue text and ids", () => {
    expect(buildIssueCorpusText({ owner: "a", repo: "b", identifier: "ARC-42", title: "Bug", description: "desc" }))
      .toBe("ARC-42: Bug\ndesc")
    expect(prDocId({ number: 234 })).toBe("pr-234")
    expect(issueDocId({ identifier: "ARC-42" })).toBe("issue-arc-42")
  })
})

describe("upsert write path", () => {
  it("embeds and upserts a PR doc to the pr: namespace with metadata", async () => {
    const { env, upserts } = makeEnv({})
    const ok = await upsertPrDoc(env, { owner: "a", repo: "b", number: 234, title: "Fix retry", body: "x", verdict: "approved" })
    expect(ok).toBe(true)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]!.namespace).toBe("pr:a/b")
    expect(upserts[0]!.id).toBe("pr-234")
    expect(upserts[0]!.metadata.kind).toBe("pr")
    expect(upserts[0]!.metadata.ref).toBe("#234")
    expect(upserts[0]!.metadata.verdict).toBe("approved")
  })
  it("soft-fails (returns false) when the upsert throws", async () => {
    const env = {
      AI: { run: async () => ({ data: [fakeVec()] }) },
      OPENCLAW_CODE_INDEX: { query: async () => ({ matches: [] }), upsert: async () => { throw new Error("boom") } },
    } as unknown as MultiCorpusEnv
    expect(await upsertIssueDoc(env, { owner: "a", repo: "b", identifier: "ARC-1", title: "T", description: "d" })).toBe(false)
  })
})

describe("retrieveMultiCorpus", () => {
  it("queries pr: and issue: namespaces in parallel and maps hits", async () => {
    const { env } = makeEnv({
      "pr:a/b": [{ id: "pr-234", score: 0.8, metadata: { kind: "pr", ref: "#234", verdict: "changes_required", content: "Fix retry backoff" } }],
      "issue:a/b": [{ id: "issue-arc-42", score: 0.7, metadata: { kind: "issue", ref: "ARC-42", status: "Done", content: "Retry storm bug" } }],
    })
    const res = await retrieveMultiCorpus(env, "a", "b", "retry backoff")
    expect(res.pr.map((h) => h.ref)).toEqual(["#234"])
    expect(res.pr[0]!.label).toBe("changes_required")
    expect(res.issue[0]!.ref).toBe("ARC-42")
    expect(res.issue[0]!.label).toBe("Done")
  })
  it("returns empty corpora on empty query without calling Vectorize", async () => {
    const { env } = makeEnv({})
    const res = await retrieveMultiCorpus(env, "a", "b", "   ")
    expect(res).toEqual({ pr: [], issue: [] })
    expect(env.OPENCLAW_CODE_INDEX.query).not.toHaveBeenCalled()
  })
  it("drops matches missing required metadata", async () => {
    const { env } = makeEnv({
      "pr:a/b": [{ id: "x", score: 0.5, metadata: { kind: "pr" /* no ref/content */ } }],
    })
    const res = await retrieveMultiCorpus(env, "a", "b", "q")
    expect(res.pr).toHaveLength(0)
  })
})

describe("formatMultiCorpusForPrompt", () => {
  it("renders labeled PR and issue blocks", () => {
    const result: MultiCorpusResult = {
      pr: [{ kind: "pr", ref: "#234", label: "changes_required", content: "Fix retry", score: 0.8 }],
      issue: [{ kind: "issue", ref: "ARC-42", label: "Done", content: "Retry storm", score: 0.7 }],
    }
    const out = formatMultiCorpusForPrompt(result)!
    expect(out).toContain("--- past PR #234 (verdict: changes_required) ---")
    expect(out).toContain("Fix retry")
    expect(out).toContain("--- Linear issue ARC-42 (status: Done) ---")
  })
  it("returns null when there are no hits", () => {
    expect(formatMultiCorpusForPrompt({ pr: [], issue: [] })).toBeNull()
  })
  it("omits the parenthetical when label is empty", () => {
    const out = formatMultiCorpusForPrompt({ pr: [{ kind: "pr", ref: "#9", label: "", content: "c", score: 1 }], issue: [] })!
    expect(out).toContain("--- past PR #9 ---")
  })
})
