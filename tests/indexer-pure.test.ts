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
  splitOversizedWindow,
  walkIndexableFiles,
  type TreeEntry,
} from "../src/lib/indexer"

describe("CHUNKER_VERSION constant", () => {
  it("is pinned at 2 — bump invalidates the index (SIG-133 split-not-drop)", () => {
    expect(CHUNKER_VERSION).toBe(2)
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
    // CodeRabbit nit on PR #76: use allowlisted extensions in the
    // "should be dropped" entries so directory-gating is the ONLY
    // thing under test. With non-allowlisted extensions a regression
    // that removed dir filtering would still pass because the
    // extension filter would drop them anyway.
    const entries: TreeEntry[] = [
      { path: "node_modules/foo/index.ts", type: "blob", size: 100 },
      { path: "dist/main.ts", type: "blob", size: 100 },
      { path: "build/out.ts", type: "blob", size: 100 },
      { path: ".git/config.toml", type: "blob", size: 50 },
      { path: "src/keep.ts", type: "blob", size: 100 },
    ]
    expect(walkIndexableFiles(entries)).toEqual([
      { path: "src/keep.ts", size: 100 },
    ])
  })

  it("drops dotfile directories EXCEPT .github (CLI parity)", () => {
    // CodeRabbit nit on PR #76: use an allowlisted extension on the
    // dropped .vscode entry so this isolates the dotfile-dir filter.
    const entries: TreeEntry[] = [
      { path: ".vscode/settings.toml", type: "blob", size: 50 },
      { path: ".github/workflows/test.toml", type: "blob", size: 50 },
    ]
    // .vscode dropped (dotfile dir), .github kept.
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

  it("SPLITS windows that exceed MAX_CHUNK_CHARS (=1400) instead of dropping them", () => {
    // SIG-133: an over-cap window used to be silently dropped (data loss).
    // It must now be split into consecutive sub-chunks, all <= the cap,
    // collectively covering every source line of the window.
    const longLine = "x".repeat(100)
    // 30 of these = 30 * 100 + 29 newlines = 3029 chars (over 1400).
    const lines = Array(30).fill(longLine)
    const content = lines.join("\n")
    const chunks = chunkFile("x.ts", content)
    // Not dropped.
    expect(chunks.length).toBeGreaterThan(0)
    // Every sub-chunk is within the token-safe cap.
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1400)
    }
    // The sub-chunks (from the first over-cap window starting at line 1)
    // together cover lines 1..30 with no gap. Filter to the chunks that
    // belong to the first window (lineStart starts at 1) — for a 30-line
    // file of long lines every window is over-cap, but the first window
    // covers lines 1..30 and that range must be fully covered.
    const firstWindow = chunks.filter((c) => c.lineStart >= 1 && c.lineEnd <= 30)
    expect(firstWindow.length).toBeGreaterThan(0)
    let cursor = 1
    for (const c of firstWindow) {
      if (c.lineStart > cursor) break // jumped past line 30 into next window overlap
      expect(c.lineStart).toBe(cursor)
      cursor = c.lineEnd + 1
    }
    expect(cursor).toBeGreaterThan(30) // covered through line 30
  })

  it("returns exactly one chunk for a normal under-cap window (unchanged shape)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    const content = lines.join("\n")
    const chunks = chunkFile("normal.ts", content)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      path: "normal.ts",
      lineStart: 1,
      lineEnd: 10,
      content,
    })
    expect(chunks[0]!.content.length).toBeLessThanOrEqual(1400)
  })

  it("hard-splits a single line longer than MAX_CHUNK_CHARS into char slices", () => {
    const longLine = "y".repeat(5000)
    const chunks = chunkFile("hard.ts", longLine)
    // ceil(5000 / 1400) = 4 sub-chunks.
    expect(chunks).toHaveLength(Math.ceil(5000 / 1400))
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1400)
      // A single physical line → lineStart === lineEnd === 1.
      expect(c.lineStart).toBe(1)
      expect(c.lineEnd).toBe(1)
    }
    // Concatenating the slices reconstructs the original line exactly.
    expect(chunks.map((c) => c.content).join("")).toBe(longLine)
  })

  it("splits the old 30-line drop case (3029 chars) preserving every source line", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      `${i + 1}:`.padEnd(100, "a"),
    )
    const content = lines.join("\n")
    const chunks = chunkFile("x.ts", content)
    expect(chunks.length).toBeGreaterThan(1)
    // Restrict to the first window (lines 1..30) sub-chunks.
    const firstWindow = chunks.filter((c) => c.lineStart >= 1 && c.lineEnd <= 30)
    for (const c of firstWindow) {
      expect(c.content.length).toBeLessThanOrEqual(1400)
    }
    // Reconstruct lines 1..30 from the first window's sub-chunks: each
    // sub-chunk's content is a "\n"-join of consecutive source lines, so
    // joining the sub-chunks back with "\n" yields lines 1..30 verbatim.
    let cursor = 1
    const reconstructed: string[] = []
    for (const c of firstWindow) {
      if (c.lineStart > cursor) break
      expect(c.lineStart).toBe(cursor)
      reconstructed.push(c.content)
      cursor = c.lineEnd + 1
    }
    expect(cursor).toBeGreaterThan(30)
    expect(reconstructed.join("\n")).toBe(lines.slice(0, 30).join("\n"))
  })

  it("covers leading blank lines at a split boundary (C1 regression)", () => {
    // SIG-133 C1: a window whose first lines are blank ("") used to be
    // skipped by the buffer-length flush gate — flush() bailed on the
    // empty buffer and the next iteration overwrote bufStartLine, so the
    // first emitted sub-chunk claimed a later line and lines 1/2 were
    // uncovered. Blank lines are real content (a line that must be
    // covered + counted) so coverage must start at line 1.
    const dense = "z".repeat(100)
    // 2 blank lines + 25 dense lines = 2 + 25*100 + 26 newlines = 2552 chars (> 1400).
    const lines = ["", "", ...Array(25).fill(dense)]
    const content = lines.join("\n")
    const chunks = chunkFile("x.ts", content)
    expect(chunks.length).toBeGreaterThan(0)
    // The first sub-chunk of the first window must start at the window's
    // true first line (1), not a shifted-forward line.
    expect(chunks[0]?.lineStart).toBe(1)
    // Walk the first window's sub-chunks (lines 1..27): every line covered
    // with no gap.
    const firstWindow = chunks.filter((c) => c.lineStart >= 1 && c.lineEnd <= 27)
    let cursor = 1
    for (const c of firstWindow) {
      if (c.lineStart > cursor) break
      expect(c.lineStart).toBe(cursor)
      cursor = c.lineEnd + 1
    }
    expect(cursor).toBeGreaterThan(27) // covered through line 27
  })
})

describe("splitOversizedWindow", () => {
  it("counts blank lines so coverage starts at the window's true line (C1)", () => {
    // Window of 4 lines starting at absolute file line 10:
    //   line 10: ""        (blank, leading)
    //   line 11: 700 chars
    //   line 12: ""        (blank, middle)
    //   line 13: 700 chars
    // Joined length = 0 + 1 + 700 + 1 + 0 + 1 + 700 = 1403 (> 1400 cap)
    // so it splits. The buffer's first candidate ("" then "\n"+700) is
    // 701 chars, still under cap; adding "\n" + "" → 702; adding
    // "\n" + 700 → 1403 overflows, so flush happens before line 13.
    const lines = ["", "x".repeat(700), "", "y".repeat(700)]
    const out = splitOversizedWindow(lines, 10)

    // Every input line index is covered by exactly one contiguous range,
    // starting at line 10 (NOT shifted forward past the blank).
    const ranges = out.map((c) => ({ lineStart: c.lineStart, lineEnd: c.lineEnd }))
    expect(ranges).toEqual([
      { lineStart: 10, lineEnd: 12 }, // "", 700, "" -> 702 chars
      { lineStart: 13, lineEnd: 13 }, // 700 chars
    ])
    // path is left empty (caller sets it).
    for (const c of out) {
      expect(c.path).toBe("")
      expect(c.content.length).toBeLessThanOrEqual(1400)
    }
    // First sub-chunk content is "" + "\n" + 700-x + "\n" + "" .
    expect(out[0]?.content).toBe(`\n${"x".repeat(700)}\n`)
    expect(out[1]?.content).toBe("y".repeat(700))
    // Coverage walk: lines 10..13 fully covered, no gap, no overlap.
    let cursor = 10
    for (const c of out) {
      expect(c.lineStart).toBe(cursor)
      cursor = c.lineEnd + 1
    }
    expect(cursor).toBe(14) // covered 10,11,12,13
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
