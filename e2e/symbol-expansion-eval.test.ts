// SIG-407 PR-4 — retrieval-quality eval (DETERMINISTIC, NO model — the PRIMARY
// flip gate). Drives the REAL RepoGraphDO over real SQLite (the PR-1 harness) so
// the ON numbers come from prod resolution (`resolveEnclosingSymbolId` +
// `expansionForIds`), not a re-derivation. Runs in `npm run build` / CI — no key.
//
// Measures symbol recall@6 with the expansion flag OFF vs ON over committed
// fixtures and asserts the flip gate:
//   - ON >= OFF on EVERY fixture (additive — expansion can never lose recall),
//   - aggregate symbol recall@6 STRICTLY higher ON than OFF,
//   - the no-graph control fixture scores ON == OFF (expansion never fires).
//
// The live answer-quality confirmation lives in symbol-expansion-eval.live.test.ts.

import { describe, expect, it } from "vitest"
import { RepoGraphDO } from "@/src/do/repo-graph"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"
import {
  SYMBOL_EXPANSION_FIXTURES,
  fixtureToUpsertArgs,
  symbolRecallOff,
  symbolRecallOn,
  hitFullyCoversSymbol,
  RECALL_K,
  type SymbolExpansionFixture,
} from "./symbol-expansion-corpus"

// ─── Real DO over SQLite (mirrors repo-graph.hits.test.ts) ─────────────

function makeDoInstance(name: string): RepoGraphDO {
  const sqlStorage = new NodeSqliteStorage()
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T {
        return sqlStorage.transactionSync(fn)
      },
      async get<T>(): Promise<T | undefined> {
        return undefined
      },
      async put(): Promise<void> {
        /* no-op */
      },
      async delete(): Promise<boolean> {
        return false
      },
      async setAlarm(): Promise<void> {
        /* no-op */
      },
      async getAlarm(): Promise<number | null> {
        return null
      },
      async deleteAlarm(): Promise<void> {
        /* no-op */
      },
    },
    id: { toString: () => name, name },
  }
  return new RepoGraphDO(state as unknown as DurableObjectState, {} as Env)
}

const HEAD = "0".repeat(40)

/**
 * Resolve a fixture's hits through the REAL DO and return the set of definition
 * symbol-ids the graph surfaced (the ON expansion). `noGraph` fixtures skip the
 * upsert so `enclosingSymbolsForHits` reports `graphAvailable:false` → empty set.
 */
async function expandedDefinitionIds(fixture: SymbolExpansionFixture): Promise<Set<string>> {
  const do_ = makeDoInstance(`eval/${fixture.id}`)
  if (!fixture.noGraph) {
    for (const args of fixtureToUpsertArgs(fixture, "r", HEAD)) {
      await do_.upsertFileGraph(args)
    }
    await do_.commitGraphVersion("r")
  }
  const exp = await do_.enclosingSymbolsForHits({ hits: fixture.hits.slice(0, RECALL_K) })
  return new Set(exp.definitionRows.map((r) => r.symbolId))
}

// ─── Pure scorer unit checks (no DO) ──────────────────────────────────

describe("symbol-expansion scorers", () => {
  const big = { symbolId: "x", path: "src/a.ts", name: "f", kind: "function", startLine: 10, endLine: 49 }

  it("hitFullyCoversSymbol: needs same path AND full [start,end] containment", () => {
    expect(hitFullyCoversSymbol({ path: "src/a.ts", lineStart: 5, lineEnd: 60 }, big)).toBe(true)
    expect(hitFullyCoversSymbol({ path: "src/a.ts", lineStart: 22, lineEnd: 28 }, big)).toBe(false) // slice inside
    expect(hitFullyCoversSymbol({ path: "src/b.ts", lineStart: 5, lineEnd: 60 }, big)).toBe(false) // wrong path
  })

  it("OFF recall counts only FULLY-covered targets; ON is additive over that", () => {
    const f = SYMBOL_EXPANSION_FIXTURES.find((x) => x.id === "slice-inside-large-function")!
    expect(symbolRecallOff(f)).toBe(0) // a 6-line slice doesn't cover the 40-line fn
    expect(symbolRecallOn(f, new Set(f.targetSymbolIds))).toBe(1) // graph resolves it
    // ON with an EMPTY expansion set must equal OFF (additive identity).
    expect(symbolRecallOn(f, new Set())).toBe(symbolRecallOff(f))
  })

  it("a fixture with no targets scores 1 (vacuous) both ways", () => {
    const f: SymbolExpansionFixture = { ...SYMBOL_EXPANSION_FIXTURES[0]!, targetSymbolIds: [] }
    expect(symbolRecallOff(f)).toBe(1)
    expect(symbolRecallOn(f, new Set())).toBe(1)
  })
})

// ─── The flip gate (real DO) ──────────────────────────────────────────

describe("SIG-407 symbol recall@6 — OFF vs ON (real RepoGraphDO, no model)", () => {
  it("ON >= OFF on every fixture; aggregate strictly higher; no-graph control unchanged", async () => {
    let sumOff = 0
    let sumOn = 0
    const rows: string[] = []
    for (const f of SYMBOL_EXPANSION_FIXTURES) {
      const defIds = await expandedDefinitionIds(f)
      const off = symbolRecallOff(f)
      const on = symbolRecallOn(f, defIds)
      sumOff += off
      sumOn += on

      // Additive guarantee: ON can never be below OFF, per fixture.
      expect(on, `${f.id}: ON (${on}) must be >= OFF (${off})`).toBeGreaterThanOrEqual(off)

      // The no-graph control must be a strict no-op: ON == OFF (expansion off).
      if (f.noGraph) {
        expect(defIds.size, `${f.id}: no-graph fixture must surface no definitions`).toBe(0)
        expect(on, `${f.id}: no-graph control must not change recall`).toBe(off)
      }

      const delta = on - off
      rows.push(`  ${delta > 0 ? "▲" : "="} ${f.id.padEnd(34)} OFF ${off.toFixed(2)} → ON ${on.toFixed(2)}`)
    }
    const n = SYMBOL_EXPANSION_FIXTURES.length
    const meanOff = sumOff / n
    const meanOn = sumOn / n

    // THE FLIP GATE: aggregate symbol recall@6 strictly higher ON than OFF.
    expect(
      meanOn,
      `aggregate ON recall@${RECALL_K} (${meanOn.toFixed(3)}) must exceed OFF (${meanOff.toFixed(3)})`,
    ).toBeGreaterThan(meanOff)

    console.log(
      [
        "",
        `┌─ SIG-407 SYMBOL RECALL@${RECALL_K} · ${n} fixtures (deterministic, no model) ─┐`,
        `MEAN: OFF ${(meanOff * 100).toFixed(0)}%  →  ON ${(meanOn * 100).toFixed(0)}%   (+${((meanOn - meanOff) * 100).toFixed(0)}pp)`,
        ...rows,
        "└────────────────────────────────────────────────────────────┘",
      ].join("\n"),
    )
  })
})
