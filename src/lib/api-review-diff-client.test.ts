// SIG-543 PR D Finding #1 — parseUnifiedDiff co-located tests.
//
// Restored from src/lib/api-review-route.test.ts (main, ~L255–302) which
// originally held this describe block.  Moved here to live alongside the
// implementation in api-review-diff-client.ts (co-location principle).

import { describe, it, expect } from "vitest"
import { parseUnifiedDiff } from "@/src/lib/api-review-diff-client"

/** Minimal single-file diff used across multiple cases. */
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const x=1\n+const x=2\n"

describe("parseUnifiedDiff", () => {
  it("extracts filename, status, and line counts per file", () => {
    const diff =
      "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n" +
      "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1,2 +1,2 @@\n const k=1\n-const y=2\n+const y=3\n"
    const files = parseUnifiedDiff(diff)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ filename: "src/new.ts", status: "added", additions: 2, deletions: 0 })
    expect(files[1]).toMatchObject({ filename: "src/old.ts", status: "modified", additions: 1, deletions: 1 })
  })
  it("does not count the --- / +++ header lines as deletions/additions", () => {
    const [f] = parseUnifiedDiff(DIFF)
    expect(f).toMatchObject({ additions: 1, deletions: 1 })
  })
  it("is CRLF-safe (does not return an empty manifest on \\r\\n diffs)", () => {
    const [f] = parseUnifiedDiff(DIFF.replace(/\n/g, "\r\n"))
    expect(f).toMatchObject({ filename: "a.ts", additions: 1, deletions: 1 })
  })
  // L2: a filename literally containing " b/" defeats the `a/<old> b/<new>` header
  // regex; the `--- a/`/`+++ b/` lines carry the path verbatim and win.
  it('L2: handles a filename containing " b/"', () => {
    const diff =
      "diff --git a/src/a b/c.ts b/src/a b/c.ts\n--- a/src/a b/c.ts\n+++ b/src/a b/c.ts\n@@ -1 +1 @@\n-x\n+y\n"
    const [f] = parseUnifiedDiff(diff)
    expect(f).toMatchObject({ filename: "src/a b/c.ts", status: "modified", additions: 1, deletions: 1 })
  })
  // L3: a rename with NO explicit `rename from` line (header old !== new) is detected
  // as a rename, not silently downgraded to a modify on the new path.
  it("L3: detects a rename with no explicit `rename from` line", () => {
    const diff =
      "diff --git a/old.ts b/new.ts\nindex abc1234..def5678 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-x\n+y\n"
    const [f] = parseUnifiedDiff(diff)
    expect(f).toMatchObject({
      filename: "new.ts",
      previousFilename: "old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
    })
  })
  // Regression guard for the parser refactor: an EXPLICIT `rename from`/`rename to`
  // (pure rename, no content change, no ---/+++ lines) still resolves correctly.
  it("still handles an explicit `rename from`/`rename to` (pure rename)", () => {
    const diff = "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n"
    const [f] = parseUnifiedDiff(diff)
    expect(f).toMatchObject({ filename: "new.ts", previousFilename: "old.ts", status: "renamed" })
  })
})
