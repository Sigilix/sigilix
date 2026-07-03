// Cross-repo retrieval — folding sibling-repo chunks into retrieveChunks when
// the caller supplies isolation-filtered `crossRepoNamespaces`. The Vectorize /
// Workers AI bindings are stubbed; the stub RECORDS every namespace queried so
// the isolation test can assert retrieval never reaches beyond the PR repo +
// the explicitly-provided siblings.

import { describe, it, expect } from "vitest"
import { retrieveChunks, formatChunksForPrompt, type RetrievalEnv } from "@/src/lib/retrieval"

const EMBED_DIMS = 768

function match(id: string, path: string, content: string, score: number) {
  return { id, score, metadata: { path, lineStart: 1, lineEnd: 10, content } }
}

/**
 * Env whose Vectorize stub returns a per-namespace match list and records the
 * namespaces it was queried with. Unknown namespaces return no matches.
 */
function makeEnv(matchesByNamespace: Record<string, ReturnType<typeof match>[]>) {
  const queried: string[] = []
  const env = {
    AI: { run: async () => ({ data: [Array(EMBED_DIMS).fill(0.1)], shape: [1, EMBED_DIMS] }) },
    OPENCLAW_CODE_INDEX: {
      query: async (_v: number[], opts: { namespace?: string }) => {
        const ns = opts.namespace ?? ""
        queried.push(ns)
        return { matches: matchesByNamespace[ns] ?? [] }
      },
    },
  } as unknown as RetrievalEnv
  return { env, queried }
}

describe("retrieveChunks — cross-repo OFF (unchanged single-repo)", () => {
  it("returns only the PR repo's chunks and queries only its namespace", async () => {
    const { env, queried } = makeEnv({
      "acme/widgets": [match("w1", "src/a.ts", "alpha", 0.9)],
      "acme/gadgets": [match("g1", "src/b.ts", "beta", 0.95)],
    })
    const out = await retrieveChunks({ text: "alpha", teamKey: "acme/widgets", env })
    expect(out.map((c) => c.id)).toEqual(["w1"])
    expect(out[0]!.repo).toBeUndefined()
    expect(queried).toEqual(["acme/widgets"])
  })

  it("empty crossRepoNamespaces is identical to OFF", async () => {
    const { env, queried } = makeEnv({ "acme/widgets": [match("w1", "src/a.ts", "alpha", 0.9)] })
    const out = await retrieveChunks({ text: "alpha", teamKey: "acme/widgets", env, crossRepoNamespaces: [] })
    expect(out.map((c) => c.id)).toEqual(["w1"])
    expect(queried).toEqual(["acme/widgets"])
  })
})

describe("retrieveChunks — cross-repo ON", () => {
  it("fuses sibling chunks, tags their origin repo, and keeps the PR repo weighted highest", async () => {
    const { env } = makeEnv({
      "acme/widgets": [match("w1", "src/a.ts", "alpha", 0.7)],
      // Sibling has a HIGHER raw score than the PR repo hit — but the
      // down-weight must still rank the PR repo's chunk first.
      "acme/gadgets": [match("g1", "src/b.ts", "beta", 0.9)],
    })
    const out = await retrieveChunks({
      text: "alpha",
      teamKey: "acme/widgets",
      env,
      crossRepoNamespaces: ["acme/gadgets"],
    })
    const byId = new Map(out.map((c) => [c.id, c]))
    expect(byId.has("w1")).toBe(true)
    expect(byId.has("g1")).toBe(true)
    // PR repo chunk has no repo tag; sibling is tagged with its namespace.
    expect(byId.get("w1")!.repo).toBeUndefined()
    expect(byId.get("g1")!.repo).toBe("acme/gadgets")
    // Down-weighted sibling score (0.9 * 0.6 = 0.54) < PR repo score (0.7).
    expect(byId.get("g1")!.score).toBeCloseTo(0.54, 5)
    // The prompt orders the PR repo's chunk before the sibling.
    const prompt = formatChunksForPrompt(out)!
    expect(prompt.indexOf("src/a.ts")).toBeLessThan(prompt.indexOf("src/b.ts"))
    expect(prompt).toContain("[repo=acme/gadgets]")
  })

  it("orders the PR repo FIRST even when a down-weighted sibling still outscores it", async () => {
    // Primary scores low (0.3); sibling raw 0.99 → down-weighted 0.594, which is
    // STILL higher than the primary. The structural primary-first guarantee must
    // order the PR repo's chunk before the sibling regardless, so the code under
    // review can never be evicted by reference context under the char budget.
    const { env } = makeEnv({
      "acme/widgets": [match("w1", "src/a.ts", "alpha", 0.3)],
      "acme/gadgets": [match("g1", "src/b.ts", "beta", 0.99)],
    })
    const out = await retrieveChunks({
      text: "alpha",
      teamKey: "acme/widgets",
      env,
      crossRepoNamespaces: ["acme/gadgets"],
    })
    const prompt = formatChunksForPrompt(out)!
    expect(prompt.indexOf("src/a.ts")).toBeLessThan(prompt.indexOf("src/b.ts"))
  })

  it("ONLY queries the PR repo + the provided siblings (tenant isolation)", async () => {
    const { env, queried } = makeEnv({
      "acme/widgets": [match("w1", "src/a.ts", "alpha", 0.8)],
      "acme/gadgets": [match("g1", "src/b.ts", "beta", 0.5)],
      // Present in the index store but NOT provided as a sibling — must never
      // be queried. (In prod this is another tenant / uninstalled repo.)
      "evilcorp/secrets": [match("x1", "src/secret.ts", "leak", 0.99)],
    })
    const out = await retrieveChunks({
      text: "alpha",
      teamKey: "acme/widgets",
      env,
      crossRepoNamespaces: ["acme/gadgets"],
    })
    expect(queried.sort()).toEqual(["acme/gadgets", "acme/widgets"])
    expect(queried).not.toContain("evilcorp/secrets")
    expect(out.some((c) => c.id === "x1")).toBe(false)
  })

  it("hard-caps the folded cross-repo chunk count regardless of sibling matches", async () => {
    const siblingMatches = Array.from({ length: 10 }, (_, i) =>
      match(`s${i}`, `src/s${i}.ts`, `hit ${i}`, 0.9 - i * 0.01),
    )
    const { env } = makeEnv({
      "acme/widgets": [match("w1", "src/a.ts", "alpha", 0.8)],
      "acme/a": siblingMatches.slice(0, 5),
      "acme/b": siblingMatches.slice(5),
    })
    const out = await retrieveChunks({
      text: "alpha",
      teamKey: "acme/widgets",
      env,
      crossRepoNamespaces: ["acme/a", "acme/b"],
    })
    const crossRepoCount = out.filter((c) => c.repo !== undefined).length
    // MAX_CROSS_REPO_CHUNKS === 3.
    expect(crossRepoCount).toBe(3)
    // The PR repo's own chunk is always retained.
    expect(out.some((c) => c.id === "w1" && c.repo === undefined)).toBe(true)
  })

  it("soft-fails a sibling query error to the PR repo's chunks alone", async () => {
    const env = {
      AI: { run: async () => ({ data: [Array(EMBED_DIMS).fill(0.1)] }) },
      OPENCLAW_CODE_INDEX: {
        query: async (_v: number[], opts: { namespace?: string }) => {
          if (opts.namespace === "acme/gadgets") throw new Error("sibling index down")
          return { matches: [match("w1", "src/a.ts", "alpha", 0.8)] }
        },
      },
    } as unknown as RetrievalEnv
    const out = await retrieveChunks({
      text: "alpha",
      teamKey: "acme/widgets",
      env,
      crossRepoNamespaces: ["acme/gadgets"],
    })
    expect(out.map((c) => c.id)).toEqual(["w1"])
  })
})
