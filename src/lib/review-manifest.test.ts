// ARC-184 — review manifest: KV serdes (tagged ReadResult) + drift +
// hash + render. This file covers the pure helpers; integration with
// the triage paths and the queue handler is exercised in the
// triage-pr-* and triage-pr-stale-mark test suites.

import { describe, it, expect, vi } from "vitest"

import {
  readReviewManifest,
  writeReviewManifest,
  detectReviewStale,
  computeFileListHash,
  renderStaleBlock,
  applyStaleBlock,
  type ReviewManifestV1,
} from "@/lib/review-manifest"
import type { Env } from "@/shared/types/env"

// Minimal KV stub — only the get/put surface we exercise. Cast through
// `unknown` to avoid pulling in the full Workers types. Mirrors the
// pattern in tests/incremental-review.test.ts so the two helpers stay
// shape-compatible.
function fakeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  const stub = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: unknown) => {
      store[k] = v
    }),
    delete: vi.fn(async (k: string) => {
      delete store[k]
    }),
  }
  return { stub, store }
}

const fakeEnv = (kv: ReturnType<typeof fakeKV>["stub"]): Env =>
  ({ OPENCLAW_STATE: kv } as unknown as Env)

const validManifest = (): ReviewManifestV1 => ({
  v: 1,
  prNumber: 42,
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  mergeBaseSha: "m".repeat(40),
  fileListHash: "f".repeat(64),
  promptVersion: "1",
  modelId: "qwen3-coder:480b-cloud",
  target: { kind: "review", reviewId: 12345 },
  reviewedAt: 1700000000000,
})

describe("readReviewManifest", () => {
  it("returns {kind: 'missing'} for unknown PR", async () => {
    const { stub } = fakeKV()
    const result = await readReviewManifest(fakeEnv(stub), "o", "r", 1)
    expect(result).toEqual({ kind: "missing" })
  })

  it("returns the parsed v1 record (target.kind = 'review')", async () => {
    const m = validManifest()
    const { stub } = fakeKV({
      "pr-review-manifest:owner/repo#42": JSON.stringify(m),
    })
    const result = await readReviewManifest(fakeEnv(stub), "owner", "repo", 42)
    expect(result).toEqual({ kind: "ok", manifest: m })
  })

  it("returns the parsed v1 record (target.kind = 'issue-comment')", async () => {
    const m: ReviewManifestV1 = { ...validManifest(), target: { kind: "issue-comment", commentId: 9999 } }
    const { stub } = fakeKV({
      "pr-review-manifest:owner/repo#42": JSON.stringify(m),
    })
    const result = await readReviewManifest(fakeEnv(stub), "owner", "repo", 42)
    expect(result).toEqual({ kind: "ok", manifest: m })
  })

  it("returns {kind: 'invalid', reason: 'wrong-version'} for v: 2 records (forward-compat)", async () => {
    const { stub } = fakeKV({
      "pr-review-manifest:o/r#1": JSON.stringify({ ...validManifest(), v: 2 }),
    })
    const result = await readReviewManifest(fakeEnv(stub), "o", "r", 1)
    expect(result).toEqual({ kind: "invalid", reason: "wrong-version" })
  })

  it("returns {kind: 'invalid', reason: 'shape'} when fields are missing", async () => {
    const { stub } = fakeKV({
      "pr-review-manifest:o/r#1": JSON.stringify({ v: 1, prNumber: 1 }),
    })
    const result = await readReviewManifest(fakeEnv(stub), "o", "r", 1)
    expect(result).toEqual({ kind: "invalid", reason: "shape" })
  })

  it("returns {kind: 'invalid', reason: 'shape'} when target is malformed", async () => {
    const { stub } = fakeKV({
      "pr-review-manifest:o/r#1": JSON.stringify({
        ...validManifest(),
        target: { kind: "review" }, // missing reviewId
      }),
    })
    const result = await readReviewManifest(fakeEnv(stub), "o", "r", 1)
    expect(result).toEqual({ kind: "invalid", reason: "shape" })
  })

  it("returns {kind: 'invalid', reason: 'json-parse'} on JSON parse error", async () => {
    const { stub } = fakeKV({ "pr-review-manifest:o/r#1": "{not json" })
    const result = await readReviewManifest(fakeEnv(stub), "o", "r", 1)
    expect(result).toEqual({ kind: "invalid", reason: "json-parse" })
  })

  it("returns {kind: 'missing'} on KV read error (defensive)", async () => {
    const stub = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable")
      }),
      put: vi.fn(),
      delete: vi.fn(),
    }
    const result = await readReviewManifest(fakeEnv(stub), "o", "r", 1)
    expect(result).toEqual({ kind: "missing" })
  })
})

describe("writeReviewManifest", () => {
  it("round-trips through fakeKV — read returns the same manifest", async () => {
    const m = validManifest()
    const { stub } = fakeKV()
    await writeReviewManifest(fakeEnv(stub), "owner", "repo", 42, m)
    const read = await readReviewManifest(fakeEnv(stub), "owner", "repo", 42)
    expect(read).toEqual({ kind: "ok", manifest: m })
  })

  it("writes with the per-PR key shape and a 30-day TTL", async () => {
    const { stub } = fakeKV()
    await writeReviewManifest(fakeEnv(stub), "acme", "site", 7, validManifest())
    expect(stub.put).toHaveBeenCalledWith(
      "pr-review-manifest:acme/site#7",
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    )
  })

  it("swallows KV write errors and returns false rather than throwing", async () => {
    const stub = {
      get: vi.fn(),
      put: vi.fn(async () => {
        throw new Error("KV write rejected")
      }),
      delete: vi.fn(),
    }
    const result = await writeReviewManifest(fakeEnv(stub), "o", "r", 1, validManifest())
    expect(result).toBe(false)
  })
})

describe("detectReviewStale", () => {
  const baseManifest = validManifest()
  const baseCurrent = {
    headSha: baseManifest.headSha,
    baseSha: baseManifest.baseSha,
    fileListHash: baseManifest.fileListHash,
    promptVersion: baseManifest.promptVersion,
  }

  it("returns {stale: false} when nothing differs", () => {
    const result = detectReviewStale(baseManifest, baseCurrent)
    expect(result).toEqual({ stale: false, reasons: [] })
  })

  it("detects head SHA drift", () => {
    const result = detectReviewStale(baseManifest, { ...baseCurrent, headSha: "x".repeat(40) })
    expect(result).toEqual({ stale: true, reasons: ["head"] })
  })

  it("detects base SHA drift", () => {
    const result = detectReviewStale(baseManifest, {
      ...baseCurrent,
      baseSha: "y".repeat(40),
      headSha: "x".repeat(40), // also force head differ so the head-match short-circuit doesn't fire
    })
    expect(result.stale).toBe(true)
    expect(result.reasons).toContain("base")
  })

  it("detects file-list-hash drift", () => {
    const result = detectReviewStale(baseManifest, {
      ...baseCurrent,
      fileListHash: "z".repeat(64),
      headSha: "x".repeat(40),
    })
    expect(result.stale).toBe(true)
    expect(result.reasons).toContain("file-list")
  })

  it("detects prompt-version drift", () => {
    const result = detectReviewStale(baseManifest, {
      ...baseCurrent,
      promptVersion: "2",
      headSha: "x".repeat(40),
    })
    expect(result.stale).toBe(true)
    expect(result.reasons).toContain("prompt-version")
  })

  it("returns multiple reasons when several fields differ", () => {
    const result = detectReviewStale(baseManifest, {
      headSha: "x".repeat(40),
      baseSha: "y".repeat(40),
      fileListHash: "z".repeat(64),
      promptVersion: "2",
    })
    expect(result.stale).toBe(true)
    expect(new Set(result.reasons)).toEqual(new Set(["head", "base", "file-list", "prompt-version"]))
  })

  it("HEAD-MATCH SHORT-CIRCUIT: when manifest.headSha === current.headSha, returns stale=false regardless of other deltas (KV consistency mitigation)", () => {
    const result = detectReviewStale(baseManifest, {
      ...baseCurrent,
      // headSha matches — the manifest IS the up-to-date one, so any
      // other "drift" is just an eventual-consistency artifact between
      // the writer and the reader.
      baseSha: "y".repeat(40),
      fileListHash: "z".repeat(64),
      promptVersion: "2",
    })
    expect(result).toEqual({ stale: false, reasons: [] })
  })

  it("OVERFLOW vs OVERFLOW: file-list drift NOT detected (caller can't compare overflows reliably)", () => {
    const m: ReviewManifestV1 = { ...baseManifest, fileListHash: "sha256:overflow:5000" }
    const result = detectReviewStale(m, {
      ...baseCurrent,
      fileListHash: "sha256:overflow:5100",
      headSha: "x".repeat(40), // force head differ so we don't short-circuit
    })
    expect(result.stale).toBe(true)
    expect(result.reasons).toEqual(["head"])
    expect(result.reasons).not.toContain("file-list")
  })

  it("OVERFLOW vs NORMAL: file-list drift NOT detected", () => {
    const m: ReviewManifestV1 = { ...baseManifest, fileListHash: "sha256:overflow:5000" }
    const result = detectReviewStale(m, {
      ...baseCurrent,
      fileListHash: "f".repeat(64),
      headSha: "x".repeat(40),
    })
    expect(result.reasons).not.toContain("file-list")
  })

  it("NORMAL vs OVERFLOW: file-list drift NOT detected (symmetric)", () => {
    const result = detectReviewStale(baseManifest, {
      ...baseCurrent,
      fileListHash: "sha256:overflow:5000",
      headSha: "x".repeat(40),
    })
    expect(result.reasons).not.toContain("file-list")
  })
})

describe("computeFileListHash", () => {
  it("returns a stable hex digest for an empty file list", async () => {
    const h1 = await computeFileListHash({ overflow: false, entries: [] })
    const h2 = await computeFileListHash({ overflow: false, entries: [] })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("hashes a single file (no rename) deterministically", async () => {
    const h = await computeFileListHash({
      overflow: false,
      entries: [{ filename: "src/foo.ts", previous_filename: null, status: "modified" }],
    })
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is order-insensitive on input (sorts internally)", async () => {
    const a = await computeFileListHash({
      overflow: false,
      entries: [
        { filename: "z.ts", previous_filename: null, status: "modified" },
        { filename: "a.ts", previous_filename: null, status: "modified" },
        { filename: "m.ts", previous_filename: null, status: "modified" },
      ],
    })
    const b = await computeFileListHash({
      overflow: false,
      entries: [
        { filename: "a.ts", previous_filename: null, status: "modified" },
        { filename: "m.ts", previous_filename: null, status: "modified" },
        { filename: "z.ts", previous_filename: null, status: "modified" },
      ],
    })
    expect(a).toBe(b)
  })

  it("a rename hashes differently than an add of the same final filename", async () => {
    const renamed = await computeFileListHash({
      overflow: false,
      entries: [{ filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" }],
    })
    const added = await computeFileListHash({
      overflow: false,
      entries: [{ filename: "src/new.ts", previous_filename: null, status: "added" }],
    })
    expect(renamed).not.toBe(added)
  })

  it("includes removed-status files", async () => {
    const withRemoval = await computeFileListHash({
      overflow: false,
      entries: [
        { filename: "src/keep.ts", previous_filename: null, status: "modified" },
        { filename: "src/gone.ts", previous_filename: null, status: "removed" },
      ],
    })
    const withoutRemoval = await computeFileListHash({
      overflow: false,
      entries: [{ filename: "src/keep.ts", previous_filename: null, status: "modified" }],
    })
    expect(withRemoval).not.toBe(withoutRemoval)
  })

  it("returns the overflow sentinel when the input is flagged overflow", async () => {
    const out = await computeFileListHash({
      overflow: true,
      entries: new Array(3000).fill(null).map((_, i) => ({
        filename: `f${i}.ts`,
        previous_filename: null,
        status: "modified",
      })),
    })
    expect(out).toBe("sha256:overflow:3000")
  })
})

describe("renderStaleBlock + applyStaleBlock", () => {
  const m = validManifest()
  const current = {
    headSha: "n".repeat(40),
    baseSha: "p".repeat(40),
    fileListHash: m.fileListHash,
    promptVersion: m.promptVersion,
  }

  it("renderStaleBlock includes both old and new short SHAs and the literal markers", () => {
    const block = renderStaleBlock(m, current)
    expect(block).toContain("<!-- sigilix:stale-marker:start -->")
    expect(block).toContain("<!-- sigilix:stale-marker:end -->")
    expect(block).toContain(m.headSha.slice(0, 7))
    expect(block).toContain(current.headSha.slice(0, 7))
    expect(block).toContain(m.baseSha.slice(0, 7))
    expect(block).toContain(current.baseSha.slice(0, 7))
    expect(block).toContain("/sigilix review")
  })

  it("applyStaleBlock inserts after the leading sigilix marker when no prior block exists", () => {
    const body = "<!-- sigilix:pr-review -->\n\n### Sigilix Summary\n\nLooks good."
    const block = renderStaleBlock(m, current)
    const out = applyStaleBlock(body, block)
    expect(out.indexOf("<!-- sigilix:pr-review -->")).toBeLessThan(out.indexOf("sigilix:stale-marker:start"))
    expect(out.indexOf("sigilix:stale-marker:start")).toBeLessThan(out.indexOf("### Sigilix Summary"))
  })

  it("applyStaleBlock IS IDEMPOTENT — running twice = same body length", () => {
    const body = "<!-- sigilix:pr-review -->\n\n### Sigilix Summary\n\nLooks good."
    const block = renderStaleBlock(m, current)
    const once = applyStaleBlock(body, block)
    const twice = applyStaleBlock(once, block)
    expect(twice).toBe(once)
  })

  it("applyStaleBlock with a NEW block replaces an existing one (no accumulation)", () => {
    const body = "<!-- sigilix:pr-review -->\n\n### Sigilix Summary\n\nLooks good."
    const blockA = renderStaleBlock(m, current)
    const after = applyStaleBlock(body, blockA)
    const newCurrent = { ...current, headSha: "z".repeat(40) }
    const blockB = renderStaleBlock(m, newCurrent)
    const replaced = applyStaleBlock(after, blockB)
    expect(replaced).toContain("z".repeat(7))
    expect(replaced).not.toContain("n".repeat(7))
    // Only one stale-marker:start in the output
    const matches = replaced.match(/sigilix:stale-marker:start/g) ?? []
    expect(matches.length).toBe(1)
  })

  it("applyStaleBlock prepends if no sigilix marker is present", () => {
    const body = "Some other body without our marker.\n"
    const block = renderStaleBlock(m, current)
    const out = applyStaleBlock(body, block)
    expect(out.startsWith("<!-- sigilix:stale-marker:start -->")).toBe(true)
  })

  it("applyStaleBlock truncates the original body when the result would exceed 65000 chars", () => {
    const huge = "<!-- sigilix:pr-review -->\n\n" + "x".repeat(64900)
    const block = renderStaleBlock(m, current)
    const out = applyStaleBlock(huge, block)
    expect(out.length).toBeLessThanOrEqual(65000)
    expect(out).toContain("[review body truncated to fit stale notice")
  })

  it("does NOT match accidental marker-like prose inside a code block (literal markers required)", () => {
    const body = [
      "<!-- sigilix:pr-review -->",
      "",
      "### Sigilix Summary",
      "",
      "Earlier reviews used to say `sigilix:stale-marker:start` in a code fence.",
      "```",
      "sigilix:stale-marker:start",
      "sigilix:stale-marker:end",
      "```",
    ].join("\n")
    const block = renderStaleBlock(m, current)
    const out = applyStaleBlock(body, block)
    // The new block should be inserted; the in-code-fence text remains.
    expect(out).toContain("<!-- sigilix:stale-marker:start -->")
    expect(out).toContain("```")
  })
})
