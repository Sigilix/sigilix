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
    expect(events[0]).toEqual({ type: "status", phase: "planning", round: 0 })
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

  it("fails fast with an error event when no search provider is configured", async () => {
    const { deps, events } = makeDeps({ hasSearchProvider: false })
    await runResearchLoop(deps)
    expect(events.some((e) => e.type === "error")).toBe(true)
    expect(typesOf(events)[typesOf(events).length - 1]).toBe("done")
    // Exactly ONE done — the fail-fast path must not double-emit (regression).
    expect(events.filter((e) => e.type === "done")).toHaveLength(1)
    // The loop never ran.
    expect(countSearching(events)).toBe(0)
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
