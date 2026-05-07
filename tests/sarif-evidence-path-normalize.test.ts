// ARC-188 — SARIF path normalizer tests.
//
// Codex MAJOR #4 + Kimi MAJOR #2: extensive negative coverage for
// encoded traversal, Windows absolute, UNC, malformed percent
// encoding, artifactLocation.index out-of-bounds.

import { describe, it, expect } from "vitest"
import { normalizeSarifPath } from "../src/lib/sarif-evidence/path-normalize"

describe("normalizeSarifPath — happy paths", () => {
  it("plain relative path passes through", () => {
    const r = normalizeSarifPath("src/foo.js")
    expect(r).toEqual({ ok: true, path: "src/foo.js" })
  })

  it("decodes URI-encoded path", () => {
    expect(normalizeSarifPath("src%2Ffoo.js")).toEqual({ ok: true, path: "src/foo.js" })
  })

  it("strips file:// scheme with relative authority (./)", () => {
    expect(normalizeSarifPath("file://./src/foo.js")).toEqual({ ok: true, path: "src/foo.js" })
  })

  it("strips leading ./", () => {
    expect(normalizeSarifPath("./src/foo.js")).toEqual({ ok: true, path: "src/foo.js" })
    expect(normalizeSarifPath("././foo.js")).toEqual({ ok: true, path: "foo.js" })
  })

  it("normalizes Windows backslash to forward slash on relative paths", () => {
    expect(normalizeSarifPath("src\\foo.js")).toEqual({ ok: true, path: "src/foo.js" })
  })

  it("uriBaseId %SRCROOT% accepted", () => {
    expect(normalizeSarifPath("src/foo.js", { uriBaseId: "%SRCROOT%" })).toEqual({
      ok: true, path: "src/foo.js",
    })
  })
})

describe("normalizeSarifPath — index resolution (Codex BLOCKING #2 type, Kimi MAJOR #2 negatives)", () => {
  it("resolves index against artifacts[index].location.uri", () => {
    const r = normalizeSarifPath(undefined, {
      index: 1,
      artifacts: [{ location: { uri: "a.js" } }, { location: { uri: "src/b.js" } }],
    })
    expect(r).toEqual({ ok: true, path: "src/b.js" })
  })

  it("index out of bounds rejected", () => {
    const r = normalizeSarifPath(undefined, {
      index: 5,
      artifacts: [{ location: { uri: "a.js" } }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/out of bounds/)
  })

  it("index set but artifacts missing rejected", () => {
    const r = normalizeSarifPath(undefined, { index: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/artifacts array missing/)
  })

  it("index points at artifact with no location.uri rejected", () => {
    const r = normalizeSarifPath(undefined, { index: 0, artifacts: [{ location: {} }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/undefined/)
  })

  it("rawUri preferred over index when both provided", () => {
    const r = normalizeSarifPath("src/explicit.js", {
      index: 0,
      artifacts: [{ location: { uri: "src/from-index.js" } }],
    })
    expect(r).toEqual({ ok: true, path: "src/explicit.js" })
  })
})

describe("normalizeSarifPath — uriBaseId", () => {
  it("rejects unsupported uriBaseId", () => {
    const r = normalizeSarifPath("src/foo.js", { uriBaseId: "%TOOLPATH%" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unsupported uriBaseId/)
  })
})

describe("normalizeSarifPath — rejection paths", () => {
  it("host-absolute Unix path rejected", () => {
    const r = normalizeSarifPath("/etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/host-absolute/)
  })

  it("host-absolute Unix path under file:// rejected", () => {
    const r = normalizeSarifPath("file:///etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/host-absolute/)
  })

  it("Windows-absolute drive letter rejected", () => {
    const r = normalizeSarifPath("C:\\path\\foo.js")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Windows/)
  })

  it("Windows-absolute under file:// rejected", () => {
    const r = normalizeSarifPath("file:///C:/path/foo.js")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Windows/)
  })

  it("file:// URI with non-empty host authority rejected (sigilix-bot PR #68)", () => {
    const r = normalizeSarifPath("file://hostname/src/foo.ts")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/non-empty host component/)
  })

  it("file:// URI with bare authority + no path rejected", () => {
    const r = normalizeSarifPath("file://malicious-host/etc/shadow")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/non-empty host component/)
  })

  it("UNC path rejected", () => {
    const r = normalizeSarifPath("\\\\server\\share\\foo.js")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/UNC/)
  })

  it("plain ../etc/passwd rejected", () => {
    const r = normalizeSarifPath("../etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/traversal/)
  })

  it("encoded traversal %2e%2e/etc/passwd rejected (decode-then-check)", () => {
    const r = normalizeSarifPath("%2e%2e/etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/traversal/)
  })

  it("encoded traversal mid-path src/%2e%2e/foo rejected", () => {
    const r = normalizeSarifPath("src/%2e%2e/foo")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/traversal/)
  })

  it("encoded slash %2Fetc/passwd resolves to host-absolute and rejects", () => {
    const r = normalizeSarifPath("%2Fetc/passwd")
    expect(r.ok).toBe(false)
  })

  it("malformed percent encoding rejected", () => {
    const r1 = normalizeSarifPath("%2")
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toMatch(/malformed percent/)
    const r2 = normalizeSarifPath("%2G")
    expect(r2.ok).toBe(false)
  })

  it("unsupported URI scheme (https://) rejected", () => {
    const r = normalizeSarifPath("https://example.com/foo.js")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unsupported URI scheme/)
  })

  it("empty / undefined path with no index rejected", () => {
    expect(normalizeSarifPath(undefined).ok).toBe(false)
    expect(normalizeSarifPath("").ok).toBe(false)
  })

  it("path that collapses to empty after normalization rejected", () => {
    const r = normalizeSarifPath("./")
    expect(r.ok).toBe(false)
  })
})

describe("normalizeSarifPath — combined transformations", () => {
  it("decoded + Windows + leading-dot cascades", () => {
    expect(normalizeSarifPath(".\\src%2Ffoo.js")).toEqual({ ok: true, path: "src/foo.js" })
  })
})
