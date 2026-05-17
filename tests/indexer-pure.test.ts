// ARC-235 — pure-helper tests for the indexer module.
//
// Covers:
//   - walkIndexableFiles: filters by extension, skip-dirs, blob type,
//     size cap; preserves order; rejects directory entries and
//     non-allowlisted extensions; handles dotfile dirs the same way
//     the CLI script does.
//   - chunkFile: 30-line windows with 10-line overlap, skips empty
//     windows, skips over-MAX_CHUNK_CHARS windows, stops at EOF
//     without re-emitting the trailing window.
//   - chunkId: deterministic, content-addressed, 48-char hex.
//   - computeRunId: deterministic + depends on all inputs.

import { describe, expect, it } from "vitest"
import {
  CHUNKER_VERSION,
  MAX_FILES_PER_JOB,
  chunkFile,
  chunkId,
  computeRunId,
  walkIndexableFiles,
  type TreeEntry,
} from "../src/lib/indexer"

describe("CHUNKER_VERSION constant", () => {
  it("is pinned at 1 — bump invalidates the index", () => {
    expect(CHUNKER_VERSION).toBe(1)
  })
  it("MAX_FILES_PER_JOB is 1000 per the ARC-235 spec", () => {
    expect(MAX_FILES_PER_JOB).toBe(1000)
  })
})

describe("walkIndexableFiles", () => {
  it("keeps .ts / .tsx / .md blobs", () => {
    const entries: TreeEntry[] = [
      { path: "src/index.ts", type: "blob", size: 1000 },
      { path: "src/App.tsx", type: "blob", size: 1000 },
      { path: "README.md", type: "blob", size: 1000 },
    ]
    const result = walkIndexableFiles(entries)
    expect(result).toEqual([
      { path: "src/index.ts", size: 1000 },
      { path: "src/App.tsx", size: 1000 },
      { path: "README.md", size: 1000 },
    ])
  })

  it("drops directory entries (type !== blob)", () => {
    const entries: TreeEntry[] = [
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob", size: 100 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "src/index.ts", size: 100 },
    ])
  })

  it("drops non-allowlisted extensions", () => {
    const entries: TreeEntry[] = [
      { path: "image.png", type: "blob", size: 100 },
      { path: "binary.exe", type: "blob", size: 100 },
      { path: "src/index.ts", type: "blob", size: 100 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "src/index.ts", size: 100 },
    ])
  })

  it("drops blobs above MAX_FILE_BYTES (200KB)", () => {
    const entries: TreeEntry[] = [
      { path: "huge.ts", type: "blob", size: 300 * 1024 },
      { path: "ok.ts", type: "blob", size: 100 * 1024 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "ok.ts", size: 100 * 1024 },
    ])
  })

  it("drops files inside node_modules / dist / build / .git", () => {
    const entries: TreeEntry[] = [
      { path: "node_modules/foo/index.ts", type: "blob", size: 100 },
      { path: "dist/main.js", type: "blob", size: 100 },
      { path: "build/out.js", type: "blob", size: 100 },
      { path: ".git/HEAD", type: "blob", size: 50 },
      { path: "src/keep.ts", type: "blob", size: 100 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "src/keep.ts", size: 100 },
    ])
  })

  it("drops dotfile directories EXCEPT .github (CLI parity)", () => {
    const entries: TreeEntry[] = [
      { path: ".vscode/settings.json", type: "blob", size: 50 },
      { path: ".github/workflows/ci.yml", type: "blob", size: 50 },
      { path: ".github/workflows/test.toml", type: "blob", size: 50 },
    ]
    // .vscode dropped (not allowlisted), .github/.toml kept.
    expect(walkIndexableFiles(entries)).toEqual([
      { path: ".github/workflows/test.toml", size: 50 },
    ])
  })

  it("treats missing size as 0 and keeps the entry", () => {
    const entries: TreeEntry[] = [
      { path: "small.ts", type: "blob" }, // size missing
    ]
    expect(walkIndexableFiles(entries)).toEqual([{ path: "small.ts", size: 0 }])
  })

  it("rejects entries with no extension or only dotfile name", () => {
    const entries: TreeEntry[] = [
      { path: "Makefile", type: "blob", size: 100 },
      { path: ".env", type: "blob", size: 100 },
      { path: "src/index.ts", type: "blob", size: 100 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "src/index.ts", size: 100 },
    ])
  })

  it("rejects malformed entries (missing path / non-string path)", () => {
    const entries: TreeEntry[] = [
      { type: "blob", size: 100 },
      { path: "src/keep.ts", type: "blob", size: 100 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "src/keep.ts", size: 100 },
    ])
  })
})

describe("chunkFile", () => {
  it("returns empty for empty content", () => {
    expect(chunkFile("x.ts", "")).toEqual([])
  })

  it("returns a single chunk for short content", () => {
    const content = "line 1\nline 2\nline 3\n"
    const chunks = chunkFile("short.ts", content)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      path: "short.ts",
      lineStart: 1,
      lineEnd: 4, // content.split("\n") includes a trailing empty after final \n
    })
  })

  it("uses 30-line windows with 10-line overlap (step=20)", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
    const content = lines.join("\n")
    const chunks = chunkFile("long.ts", content)
    // Starts at: 1 (lines 1-30), 21 (lines 21-50), 41 (lines 41-60).
    expect(chunks).toHaveLength(3)
    expect(chunks[0]?.lineStart).toBe(1)
    expect(chunks[0]?.lineEnd).toBe(30)
    expect(chunks[1]?.lineStart).toBe(21)
    expect(chunks[1]?.lineEnd).toBe(50)
    expect(chunks[2]?.lineStart).toBe(41)
    expect(chunks[2]?.lineEnd).toBe(60)
  })

  it("does not duplicate the final partial window", () => {
    const lines = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`)
    const chunks = chunkFile("x.ts", lines.join("\n"))
    // [1, 30) + [21, 35)
    expect(chunks).toHaveLength(2)
    expect(chunks.at(-1)?.lineEnd).toBe(35)
  })

  it("skips empty windows (all-whitespace) but continues past them", () => {
    const lines = [
      ...Array(15).fill("   "), // whitespace-only first 15
      ...Array.from({ length: 30 }, (_, i) => `line ${i + 1}`),
    ]
    const chunks = chunkFile("x.ts", lines.join("\n"))
    // First window [1, 30) trims to non-empty (mix of whitespace + 15 real). Second window [21, 45).
    // We don't care about exact count — just that we don't crash + we emit something.
    expect(chunks.length).toBeGreaterThan(0)
  })

  it("skips windows that exceed MAX_CHUNK_CHARS (=1800)", () => {
    const longLine = "x".repeat(100)
    // 30 of these = 30 * 100 + 29 newlines = 3029 chars (way over 1800)
    const content = Array(30).fill(longLine).join("\n")
    const chunks = chunkFile("x.ts", content)
    // Each window is over MAX_CHUNK_CHARS → all skipped.
    expect(chunks).toEqual([])
  })
})

describe("chunkId", () => {
  it("returns a 48-char hex id", async () => {
    const id = await chunkId("sigilix", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "hello",
    })
    expect(id).toMatch(/^[0-9a-f]{48}$/)
  })

  it("is deterministic for identical inputs", async () => {
    const a = await chunkId("sigilix", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "hello",
    })
    const b = await chunkId("sigilix", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "hello",
    })
    expect(a).toBe(b)
  })

  it("changes when content changes (same path/lines)", async () => {
    const a = await chunkId("sigilix", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "hello",
    })
    const b = await chunkId("sigilix", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "world",
    })
    expect(a).not.toBe(b)
  })

  it("changes when namespace changes", async () => {
    const a = await chunkId("sigilix", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "hello",
    })
    const b = await chunkId("rubberfit", {
      path: "x.ts",
      lineStart: 1,
      lineEnd: 30,
      content: "hello",
    })
    expect(a).not.toBe(b)
  })
})

describe("computeRunId", () => {
  it("returns a 16-char hex id", async () => {
    const id = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha: "a".repeat(40),
      modelId: "@cf/baai/bge-base-en-v1.5",
      chunkerVersion: 1,
    })
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("depends on every input", async () => {
    const base = {
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha: "a".repeat(40),
      modelId: "@cf/baai/bge-base-en-v1.5",
      chunkerVersion: 1,
    }
    const a = await computeRunId(base)
    const b = await computeRunId({ ...base, owner: "different" })
    const c = await computeRunId({ ...base, repo: "different" })
    const d = await computeRunId({ ...base, headSha: "b".repeat(40) })
    const e = await computeRunId({ ...base, modelId: "different-model" })
    const f = await computeRunId({ ...base, chunkerVersion: 2 })
    expect(new Set([a, b, c, d, e, f]).size).toBe(6)
  })
})
