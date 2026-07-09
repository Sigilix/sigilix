import { describe, it, expect } from "vitest"
import { runResearchLoop, type EngineDeps } from "./engine"
import { resolveResearchConfig } from "./config"
import type { ResearchModelFn } from "./model"
import type { SearchQueryResult } from "./search"
import type { FetchPageResult } from "./fetch-guard"
import type { Env } from "@/src/shared/types/env"
import type { ResearchConfig, ResearchEvent, ResearchModelRole } from "./types"

function baseConfig(over: Partial<ResearchConfig> = {}): ResearchConfig {
  const cfg = resolveResearchConfig({} as Env)
  return { ...cfg, ...over }
}

interface ModelScript {
  stop?: "STOP" | "CONTINUE"
  extract?: string
}

function makeModel(script: ModelScript = {}): ResearchModelFn {
  return async (role: ResearchModelRole) => {
    const text = ((): string => {
      switch (role) {
        case "classify":
          return "factual"
        case "planner":
          return "1. facet one\n2. facet two\nquery alpha\nquery beta"
        case "extract":
          return script.extract ?? "Detailed relevant finding about the topic with concrete version 3.2 specifics."
        case "synthesis":
          return "Consolidated notes about the topic with concrete, sourced detail across facets."
        case "stopCheck":
          return script.stop ?? "CONTINUE"
        case "finalReport":
          return "# Answer\n\nBottom line first [1]."
      }
    })()
    return { text, tokens: 100 }
  }
}

const okSearch = (): Promise<SearchQueryResult> =>
  Promise.resolve({
    ok: true,
    provider: "tavily",
    hits: [{ url: "https://example.com/a", title: "A", snippet: "snip" }],
  })

const emptySearch = (): Promise<SearchQueryResult> => Promise.resolve({ ok: true, provider: "tavily", hits: [] })

const okFetch = (url: string): Promise<FetchPageResult> =>
  Promise.resolve({ ok: true, page: { url, title: "A", domain: "example.com", text: "page body text here" } })

function makeDeps(over: Partial<EngineDeps>): { deps: EngineDeps; events: ResearchEvent[] } {
  const events: ResearchEvent[] = []
  const deps: EngineDeps = {
    question: "how does X work?",
    runId: "run-1",
    config: baseConfig(),
    hasSearchProvider: true,
    emit: (e) => {
      events.push(e)
    },
    model: makeModel(),
    search: okSearch,
    fetchPage: okFetch,
    isCancelled: () => false,
    now: () => 0,
    ...over,
  }
  return { deps, events }
}

const typesOf = (events: ResearchEvent[]): string[] => events.map((e) => e.type)
const countSearching = (events: ResearchEvent[]): number =>
  events.filter((e) => e.type === "status" && e.phase === "searching").length

describe("happy path", () => {
  it("emits the contract events in order and ends with final then done", async () => {
    const { deps, events } = makeDeps({
      config: baseConfig({ minRounds: 1 }),
      model: makeModel({ stop: "STOP" }),
    })
    await runResearchLoop(deps)

    const types = typesOf(events)
    // planning first, done last, final immediately before done.
    // First status is planning round 0 and echoes the resolved model + effort.
    expect(events[0]).toEqual({ type: "status", phase: "planning", round: 0, model: "astraeus", effort: "medium" })
    expect(types).toContain("plan")
    expect(types).toContain("queries")
    expect(types).toContain("source")
    expect(types[types.length - 1]).toBe("done")
    expect(types[types.length - 2]).toBe("final")

    // A finalizing status precedes the final.
    expect(events.some((e) => e.type === "status" && e.phase === "finalizing")).toBe(true)
    // The final carries markdown + the discovered source.
    const final = events.find((e) => e.type === "final")
    expect(final).toBeTruthy()
    if (final && final.type === "final") {
      expect(final.markdown).toContain("Answer")
      expect(final.sources.map((s) => s.url)).toContain("https://example.com/a")
    }
  })

  it("degrades gracefully (no error) when no search provider is configured", async () => {
    const { deps, events } = makeDeps({ hasSearchProvider: false })
    await runResearchLoop(deps)
    const types = typesOf(events)
    // NOT an error — the user still gets a real, model-only answer.
    expect(events.some((e) => e.type === "error")).toBe(false)
    // A clear, non-error note explains that live search is off.
    expect(events.some((e) => e.type === "note" && /live web search isn't enabled/i.test(e.text))).toBe(true)
    // Ends with a model-only final (empty sources) then the single done.
    expect(types[types.length - 1]).toBe("done")
    expect(types[types.length - 2]).toBe("final")
    const final = events.find((e) => e.type === "final")
    expect(final && final.type === "final" ? final.sources : null).toEqual([])
    // Exactly ONE done — the degraded path must not double-emit (regression).
    expect(events.filter((e) => e.type === "done")).toHaveLength(1)
    // The first status still carries model + effort for the UI.
    expect(events[0]).toEqual({ type: "status", phase: "planning", round: 0, model: "astraeus", effort: "medium" })
    // The search loop never ran.
    expect(countSearching(events)).toBe(0)
  })

  it("degraded path honors cancellation before the model call (note, no final)", async () => {
    const { deps, events } = makeDeps({ hasSearchProvider: false, isCancelled: () => true })
    await runResearchLoop(deps)
    expect(events.some((e) => e.type === "note" && /cancelled by request/i.test(e.text))).toBe(true)
    expect(events.some((e) => e.type === "final")).toBe(false)
    expect(typesOf(events)[typesOf(events).length - 1]).toBe("done")
  })

  it("degraded path — a cancel that lands DURING the model answer wins (no stale final)", async () => {
    let cancelled = false
    const { deps, events } = makeDeps({
      hasSearchProvider: false,
      isCancelled: () => cancelled,
      // /cancel arrives while the model is producing the answer.
      model: async () => {
        cancelled = true
        return { text: "answer that must not ship", tokens: 1 }
      },
    })
    await runResearchLoop(deps)
    expect(events.some((e) => e.type === "final")).toBe(false)
    expect(events.some((e) => e.type === "note" && /cancelled by request/i.test(e.text))).toBe(true)
    expect(typesOf(events)[typesOf(events).length - 1]).toBe("done")
  })

  it("emits exactly one done on the happy path too", async () => {
    const { deps, events } = makeDeps({ config: baseConfig({ minRounds: 1 }), model: makeModel({ stop: "STOP" }) })
    await runResearchLoop(deps)
    expect(events.filter((e) => e.type === "done")).toHaveLength(1)
  })
})

describe("termination quad", () => {
  it("maxRounds — stops after the round ceiling even if stop-check says CONTINUE", async () => {
    const { deps, events } = makeDeps({
      config: baseConfig({ maxRounds: 3, minRounds: 2, maxTimeMs: 10_000_000 }),
      model: makeModel({ stop: "CONTINUE" }),
    })
    await runResearchLoop(deps)
    expect(countSearching(events)).toBe(3)
    expect(events.some((e) => e.type === "final")).toBe(true)
  })

  it("maxTimeMs — a hard wall-clock ceiling stops the loop", async () => {
    let t = 0
    const { deps, events } = makeDeps({
      config: baseConfig({ maxTimeMs: 100, minRounds: 1, maxRounds: 8 }),
      model: makeModel({ stop: "CONTINUE" }),
      now: () => {
        const cur = t
        t += 60
        return cur
      },
    })
    await runResearchLoop(deps)
    // start=0, round1 check=60(<100) runs, round2 check=120(>=100) breaks.
    expect(countSearching(events)).toBe(1)
    expect(events.some((e) => e.type === "final")).toBe(true)
  })

  it("minRounds — floors the stop-check (does not stop before the floor)", async () => {
    const { deps, events } = makeDeps({
      config: baseConfig({ minRounds: 2, maxRounds: 8, maxTimeMs: 10_000_000 }),
      model: makeModel({ stop: "STOP" }), // wants to stop immediately
    })
    await runResearchLoop(deps)
    // Despite STOP from round 1, the floor forces at least 2 rounds.
    expect(countSearching(events)).toBe(2)
  })

  it("maxEmptyRounds — kills after 2 consecutive empty/low-quality rounds", async () => {
    const { deps, events } = makeDeps({
      config: baseConfig({ minRounds: 1, maxEmptyRounds: 2, maxRounds: 8, maxTimeMs: 10_000_000 }),
      model: makeModel({ stop: "CONTINUE" }),
      search: emptySearch, // no hits → no pages → no extractions → empty round
    })
    await runResearchLoop(deps)
    expect(countSearching(events)).toBe(2)
    // No usable info was ever synthesized.
    expect(events.some((e) => e.type === "note" && /no usable information/.test(e.text))).toBe(true)
  })
})

describe("cooperative cancellation", () => {
  it("emits the stop note then done, and does not continue running", async () => {
    const { deps, events } = makeDeps({
      isCancelled: () => true,
      model: makeModel({ stop: "CONTINUE" }),
    })
    await runResearchLoop(deps)
    const types = typesOf(events)
    expect(events.some((e) => e.type === "note" && /cancelled by request/i.test(e.text))).toBe(true)
    expect(types[types.length - 1]).toBe("done")
    // Cancelled before any round did its search/fetch → no final report.
    expect(events.some((e) => e.type === "final")).toBe(false)
    expect(countSearching(events)).toBe(0)
  })
})

describe("low-quality extraction is dropped", () => {
  it("treats a page whose extraction is NO RELEVANT INFORMATION as empty", async () => {
    const { deps, events } = makeDeps({
      config: baseConfig({ minRounds: 1, maxEmptyRounds: 2, maxRounds: 8, maxTimeMs: 10_000_000 }),
      model: makeModel({ stop: "CONTINUE", extract: "NO RELEVANT INFORMATION" }),
    })
    await runResearchLoop(deps)
    // Two empty rounds (extractions all dropped) → empty-kill fires.
    expect(countSearching(events)).toBe(2)
  })
})

describe("model + effort echo (addendum §3)", () => {
  it("ONLY the first status carries model + effort; every other status omits them", async () => {
    const cfg = resolveResearchConfig({} as Env, { model: "pyroeis", effort: "high" })
    const { deps, events } = makeDeps({ config: cfg, model: makeModel({ stop: "STOP" }) })
    await runResearchLoop(deps)

    const statuses = events.filter((e) => e.type === "status")
    expect(statuses[0]).toMatchObject({ phase: "planning", round: 0, model: "pyroeis", effort: "high" })
    for (const s of statuses.slice(1)) {
      if (s.type !== "status") continue
      expect(s.model).toBeUndefined()
      expect(s.effort).toBeUndefined()
    }
  })
})

describe("effort budget matrix (addendum §2)", () => {
  it("low effort caps rounds at 3 and queries/pages per round", async () => {
    const cfg = resolveResearchConfig({} as Env, { effort: "low" })
    // Sanity: the preset numbers.
    expect(cfg.maxRounds).toBe(3)
    expect(cfg.maxQueriesPerRound).toBe(2)
    expect(cfg.maxPagesPerRound).toBe(3)
    expect(cfg.maxTimeMs).toBe(120_000)

    let maxQueriesSeen = 0
    let hitCounter = 0
    const fetchesPerRound: number[] = []
    let currentRoundFetches = 0
    const events: ResearchEvent[] = []
    // The planner returns 6 candidate queries; the engine must cap at 2.
    const model: ResearchModelFn = async (role) => ({
      text:
        role === "classify"
          ? "factual"
          : role === "planner"
            ? "q1\nq2\nq3\nq4\nq5\nq6"
            : role === "stopCheck"
              ? "CONTINUE" // never stop on the check → only maxRounds can stop it
              : role === "extract"
                ? "A detailed, information-rich finding about the topic with concrete version 3.2 specifics."
                : "Consolidated notes with concrete sourced detail.",
      tokens: 1,
    })
    await runResearchLoop({
      question: "q",
      runId: "r",
      config: cfg,
      hasSearchProvider: true,
      emit: (e) => {
        events.push(e)
        if (e.type === "queries") maxQueriesSeen = Math.max(maxQueriesSeen, e.items.length)
        if (e.type === "status" && e.phase === "searching") {
          if (events.length > 1) fetchesPerRound.push(currentRoundFetches)
          currentRoundFetches = 0
        }
      },
      model,
      // A unique URL per call so rounds never go empty (dedupe would otherwise
      // starve later rounds) — the ONLY thing that stops the loop is maxRounds.
      search: () =>
        Promise.resolve({
          ok: true,
          provider: "tavily",
          hits: [{ url: `https://e.com/${hitCounter++}`, title: "A", snippet: "s" }],
        }),
      fetchPage: (url) => {
        currentRoundFetches++
        return Promise.resolve({ ok: true, page: { url, title: "A", domain: "e.com", text: "body text long enough" } })
      },
      isCancelled: () => false,
      now: () => 0,
    })
    fetchesPerRound.push(currentRoundFetches)

    // low effort → exactly 3 rounds (maxRounds), ≤2 queries/round, ≤3 pages/round.
    expect(events.filter((e) => e.type === "status" && e.phase === "searching")).toHaveLength(3)
    expect(maxQueriesSeen).toBe(2)
    for (const n of fetchesPerRound) expect(n).toBeLessThanOrEqual(cfg.maxPagesPerRound)
  })
})

// sig-deep-research-repo-grounding — the codebase-grounding branches.
describe("repo grounding", () => {
  const repoGrounding = {
    namespace: "acme/widgets",
    context:
      "# Team conventions\n- keep it simple\n\n[symbol] src/index/memory-indexer.ts\nexport function indexMemory() {}",
    sources: [
      {
        url: "https://github.com/acme/widgets/blob/HEAD/src/index/memory-indexer.ts#L10-L40",
        title: "src/index/memory-indexer.ts:10-40",
        domain: "acme/widgets",
        kind: "repo" as const,
      },
      {
        url: "https://github.com/acme/widgets/blob/HEAD/src/index/store.ts#L1-L20",
        title: "src/index/store.ts:1-20",
        domain: "acme/widgets",
        kind: "repo" as const,
      },
    ],
    chunkCount: 2,
  }

  it("answers a codebase question from repo context with repo-file citations and NO web search", async () => {
    // A "where does X live in our repo" question — the exact repro.
    const { deps, events } = makeDeps({
      question: "where does the memory indexing live in our repo?",
      repoGrounding,
      hasIndexedRepo: true,
      // Fail loudly if the loop ever hits web search on the repo-grounded path.
      search: () => Promise.reject(new Error("web search must not run for a grounded codebase question")),
    })
    await runResearchLoop(deps)

    // No web search phase at all.
    expect(countSearching(events)).toBe(0)
    // The repo files were emitted as sources (kind "repo").
    const repoSources = events.filter((e) => e.type === "source" && e.kind === "repo")
    expect(repoSources.map((s) => (s.type === "source" ? s.url : ""))).toContain(
      "https://github.com/acme/widgets/blob/HEAD/src/index/memory-indexer.ts#L10-L40",
    )
    // The final cites the repo files (not web pages).
    const final = events.find((e) => e.type === "final")
    expect(final && final.type === "final" ? final.sources.every((s) => s.kind === "repo") : false).toBe(true)
    expect(final && final.type === "final" ? final.sources.length : 0).toBe(2)
    // Terminates cleanly.
    const types = typesOf(events)
    expect(types[types.length - 1]).toBe("done")
    expect(types[types.length - 2]).toBe("final")
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("passes the packed repo context to the (final-report role) model prompt", async () => {
    const seenPrompts: string[] = []
    const { deps } = makeDeps({
      question: "which file implements the token broker in our repo?",
      repoGrounding,
      hasIndexedRepo: true,
      model: async (_role, messages) => {
        seenPrompts.push(messages.map((m) => m.content).join("\n"))
        return { text: "The token broker lives in src/do/linear-token-broker.ts [1].", tokens: 10 }
      },
    })
    await runResearchLoop(deps)
    // The authoritative repo context reached the model.
    expect(seenPrompts.some((p) => p.includes("memory-indexer.ts"))).toBe(true)
    expect(seenPrompts.some((p) => /Repository context/i.test(p))).toBe(true)
  })

  it("tells the user to connect a repo for a codebase question when none is indexed", async () => {
    const { deps, events } = makeDeps({
      question: "where is the auth middleware defined in our codebase?",
      repoGrounding: null,
      hasIndexedRepo: false,
      search: () => Promise.reject(new Error("must not web-search when telling the user to connect a repo")),
    })
    await runResearchLoop(deps)

    expect(countSearching(events)).toBe(0)
    const final = events.find((e) => e.type === "final")
    expect(
      final && final.type === "final" ? /no repository is connected and indexed/i.test(final.markdown) : false,
    ).toBe(true)
    expect(final && final.type === "final" ? final.sources : null).toEqual([])
    expect(typesOf(events)[typesOf(events).length - 1]).toBe("done")
  })

  it("still runs normal web research for a non-codebase question (no grounding)", async () => {
    const { deps, events } = makeDeps({
      question: "what is the latest stable version of Node.js?",
      config: baseConfig({ minRounds: 1 }),
      model: makeModel({ stop: "STOP" }),
      repoGrounding: null,
      hasIndexedRepo: false,
    })
    await runResearchLoop(deps)
    // Web path ran (searched) and cited a web source.
    expect(countSearching(events)).toBeGreaterThan(0)
    const final = events.find((e) => e.type === "final")
    expect(final && final.type === "final" ? final.sources.map((s) => s.url) : []).toContain("https://example.com/a")
  })

  it("folds repo grounding into the web loop for a repo-connected NON-codebase question", async () => {
    const seenPrompts: string[] = []
    const { deps, events } = makeDeps({
      question: "compare our approach to the OAuth 2.1 spec",
      config: baseConfig({ minRounds: 1 }),
      repoGrounding,
      hasIndexedRepo: true,
      model: async (role, messages) => {
        seenPrompts.push(messages.map((m) => m.content).join("\n"))
        if (role === "stopCheck") return { text: "STOP", tokens: 1 }
        if (role === "classify") return { text: "comparative", tokens: 1 }
        return { text: "# Answer\n\nBottom line [1].", tokens: 10 }
      },
    })
    await runResearchLoop(deps)
    // Web search DID run (augmentation), AND repo sources were seeded first.
    expect(countSearching(events)).toBeGreaterThan(0)
    const firstSource = events.find((e) => e.type === "source")
    expect(firstSource && firstSource.type === "source" ? firstSource.kind : "").toBe("repo")
    // The final report prompt carries the authoritative repo context.
    expect(seenPrompts.some((p) => /Authoritative repository context/i.test(p))).toBe(true)
  })
})
