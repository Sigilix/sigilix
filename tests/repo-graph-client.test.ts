// SIG-138 Fix 2 — Delegation tests for repo-graph-client wrappers.
//
// Verifies that each wrapper resolves the DO stub via
// indexNamespace(owner, repo) and delegates to the correct RPC method
// with the correct arguments.  This is a pure delegation test; no real
// SQLite or Cloudflare runtime is needed.

import { describe, expect, it } from "vitest"
import {
  graphContextFor,
  blastRadiusFor,
  writeFileGraph,
  commitGraph,
  deleteGraph,
} from "../src/lib/repo-graph-client"
import { indexNamespace } from "../src/lib/repo-index-manifest"
import type { Env } from "../src/index"

// ─── Minimal DO stub ─────────────────────────────────────────────────────────
//
// Captures every method call so tests can assert delegation without touching
// real DO storage.

type Call = { method: string; args: unknown[] }

function makeStub(): { calls: Call[]; stub: Record<string, (...a: unknown[]) => Promise<unknown>> } {
  const calls: Call[] = []
  const stub = new Proxy({} as Record<string, (...a: unknown[]) => Promise<unknown>>, {
    get(_t, method: string) {
      return (...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve(undefined)
      }
    },
  })
  return { calls, stub }
}

// ─── Minimal env mock ────────────────────────────────────────────────────────
//
// REPO_GRAPH_DO is typed as DurableObjectNamespace, but the wrappers only call
// idFromName(name) → id and get(id) → stub.  We provide a minimal stand-in.

function makeEnv(owner: string, repo: string): { env: Env; calls: Call[] } {
  const { calls, stub } = makeStub()

  const expectedNamespace = indexNamespace(owner, repo)
  const sentinelId = Symbol("sentinelId")

  const ns = {
    idFromName(name: string) {
      calls.push({ method: "idFromName", args: [name] })
      expect(name).toBe(expectedNamespace)
      return sentinelId
    },
    get(id: unknown) {
      calls.push({ method: "get", args: [id] })
      expect(id).toBe(sentinelId)
      return stub
    },
  }

  return {
    env: { REPO_GRAPH_DO: ns } as unknown as Env,
    calls,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("graphContextFor delegation", () => {
  it("calls idFromName(indexNamespace(owner, repo)) then stub.contextForVectorHits(args)", async () => {
    const owner = "acme"
    const repo = "widget"
    const { env, calls } = makeEnv(owner, repo)

    const args = { seedPaths: ["src/a.ts"], maxFiles: 8, maxSymbolsPerHit: 12, maxEdgesPerSymbol: 6 }
    await graphContextFor(env, owner, repo, args)

    // idFromName was called with the correct namespace key
    const idFromNameCall = calls.find((c) => c.method === "idFromName")
    expect(idFromNameCall).toBeDefined()
    expect(idFromNameCall!.args[0]).toBe(indexNamespace(owner, repo))

    // get was called (stub fetch via ns.get)
    expect(calls.find((c) => c.method === "get")).toBeDefined()

    // contextForVectorHits was called on the stub with the exact args
    const rpcCall = calls.find((c) => c.method === "contextForVectorHits")
    expect(rpcCall).toBeDefined()
    expect(rpcCall!.args[0]).toEqual(args)
  })
})

describe("blastRadiusFor delegation", () => {
  it("calls idFromName(indexNamespace(owner, repo)) then stub.blastRadius(args)", async () => {
    const owner = "acme"
    const repo = "widget"
    const { env, calls } = makeEnv(owner, repo)

    const args = { changedSymbolIds: ["src/a.ts function foo 1 0"] }
    await blastRadiusFor(env, owner, repo, args)

    const idFromNameCall = calls.find((c) => c.method === "idFromName")
    expect(idFromNameCall).toBeDefined()
    expect(idFromNameCall!.args[0]).toBe(indexNamespace(owner, repo))

    const rpcCall = calls.find((c) => c.method === "blastRadius")
    expect(rpcCall).toBeDefined()
    expect(rpcCall!.args[0]).toEqual(args)
  })
})

describe("writeFileGraph delegation", () => {
  it("calls stub.upsertFileGraph(args)", async () => {
    const owner = "acme"
    const repo = "widget"
    const { env, calls } = makeEnv(owner, repo)

    const args = {
      runId: "run1",
      headSha: "sha1",
      path: "src/a.ts",
      symbols: [],
      fileEdgesRaw: [],
      callEdges: [],
    }
    await writeFileGraph(env, owner, repo, args)

    const rpcCall = calls.find((c) => c.method === "upsertFileGraph")
    expect(rpcCall).toBeDefined()
    expect(rpcCall!.args[0]).toEqual(args)
  })
})

describe("commitGraph delegation", () => {
  it("calls stub.commitGraphVersion(runId)", async () => {
    const owner = "acme"
    const repo = "widget"
    const { env, calls } = makeEnv(owner, repo)

    await commitGraph(env, owner, repo, "run42")

    const rpcCall = calls.find((c) => c.method === "commitGraphVersion")
    expect(rpcCall).toBeDefined()
    expect(rpcCall!.args[0]).toBe("run42")
  })
})

describe("deleteGraph delegation", () => {
  it("calls stub.deleteRepoGraph()", async () => {
    const owner = "acme"
    const repo = "widget"
    const { env, calls } = makeEnv(owner, repo)

    await deleteGraph(env, owner, repo)

    const rpcCall = calls.find((c) => c.method === "deleteRepoGraph")
    expect(rpcCall).toBeDefined()
  })
})

describe("namespace key correctness", () => {
  it("uses indexNamespace(owner, repo) as the DO key — different repos get different keys", () => {
    const ns1 = indexNamespace("acme", "widget")
    const ns2 = indexNamespace("acme", "other-repo")
    expect(ns1).not.toBe(ns2)
  })

  it("is deterministic for the same owner/repo", () => {
    expect(indexNamespace("acme", "widget")).toBe(indexNamespace("acme", "widget"))
  })
})
