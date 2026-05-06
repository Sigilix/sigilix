// ARC-186 — package.json + package-lock.json parser tests.

import { describe, it, expect } from "vitest"
import {
  parsePackageJson,
  parsePackageLock,
  rootDepNames,
} from "../src/lib/dep-vulns/manifest-parsers"

describe("parsePackageJson", () => {
  it("returns null on invalid JSON", () => {
    expect(parsePackageJson("not json")).toBeNull()
    expect(parsePackageJson("")).toBeNull()
  })

  it("returns null on top-level non-object", () => {
    expect(parsePackageJson("[]")).toBeNull()
    expect(parsePackageJson('"string"')).toBeNull()
    expect(parsePackageJson("42")).toBeNull()
  })

  it("captures name + version", () => {
    const result = parsePackageJson(JSON.stringify({ name: "foo", version: "1.2.3" }))
    expect(result).toEqual({ name: "foo", version: "1.2.3" })
  })

  it("captures all three dep buckets", () => {
    const result = parsePackageJson(JSON.stringify({
      dependencies: { lodash: "^4.0.0" },
      devDependencies: { vitest: "^2.0.0" },
      peerDependencies: { react: ">=16" },
    }))
    expect(result?.dependencies).toEqual({ lodash: "^4.0.0" })
    expect(result?.devDependencies).toEqual({ vitest: "^2.0.0" })
    expect(result?.peerDependencies).toEqual({ react: ">=16" })
  })

  it("drops non-string version values within a dep bucket", () => {
    const result = parsePackageJson(JSON.stringify({
      dependencies: { lodash: "^4.0.0", broken: 42 },
    }))
    expect(result?.dependencies).toEqual({ lodash: "^4.0.0" })
  })

  it("omits empty buckets", () => {
    const result = parsePackageJson(JSON.stringify({}))
    expect(result?.dependencies).toBeUndefined()
    expect(result?.devDependencies).toBeUndefined()
    expect(result?.peerDependencies).toBeUndefined()
  })
})

describe("rootDepNames", () => {
  it("unions deps + devDeps + peerDeps", () => {
    const names = rootDepNames({
      dependencies: { foo: "1", bar: "1" },
      devDependencies: { baz: "1" },
      peerDependencies: { qux: "1" },
    })
    expect(names).toEqual(new Set(["foo", "bar", "baz", "qux"]))
  })

  it("returns empty for null", () => {
    expect(rootDepNames(null).size).toBe(0)
  })

  it("returns empty for empty object", () => {
    expect(rootDepNames({}).size).toBe(0)
  })
})

describe("parsePackageLock — npm v6", () => {
  const v6Lock = (deps: Record<string, { version: string }>) =>
    JSON.stringify({ lockfileVersion: 1, dependencies: deps })

  it("returns top-level versions for root deps only", () => {
    const lock = v6Lock({
      lodash: { version: "4.17.21" },
      hoisted: { version: "1.0.0" },
    })
    const result = parsePackageLock(lock, new Set(["lodash"]))
    expect(result.get("lodash")).toBe("4.17.21")
    expect(result.has("hoisted")).toBe(false)
  })

  it("returns empty map on invalid JSON", () => {
    expect(parsePackageLock("not json", new Set(["lodash"])).size).toBe(0)
  })

  it("returns empty map when dependencies is missing", () => {
    expect(parsePackageLock("{}", new Set(["lodash"])).size).toBe(0)
  })

  it("default-dispatches to v6 when lockfileVersion is missing", () => {
    const result = parsePackageLock(
      JSON.stringify({ dependencies: { lodash: { version: "4.17.21" } } }),
      new Set(["lodash"]),
    )
    expect(result.get("lodash")).toBe("4.17.21")
  })
})

describe("parsePackageLock — npm v7+", () => {
  const v7Lock = (packages: Record<string, { version: string }>) =>
    JSON.stringify({ lockfileVersion: 3, packages })

  it("returns versions from packages.node_modules/<name> for root deps only", () => {
    const lock = v7Lock({
      "": { version: "1.0.0" }, // root self-entry; ignored
      "node_modules/lodash": { version: "4.17.21" },
      "node_modules/hoisted": { version: "1.0.0" },
    })
    const result = parsePackageLock(lock, new Set(["lodash"]))
    expect(result.get("lodash")).toBe("4.17.21")
    expect(result.has("hoisted")).toBe(false)
  })

  it("normalizes scoped packages (node_modules/@scope/pkg → @scope/pkg)", () => {
    const lock = v7Lock({
      "node_modules/@scope/pkg": { version: "2.0.0" },
    })
    const result = parsePackageLock(lock, new Set(["@scope/pkg"]))
    expect(result.get("@scope/pkg")).toBe("2.0.0")
  })

  it("rejects deep paths (node_modules/foo/node_modules/bar)", () => {
    const lock = v7Lock({
      "node_modules/foo": { version: "1.0.0" },
      "node_modules/foo/node_modules/bar": { version: "2.0.0" },
    })
    const result = parsePackageLock(lock, new Set(["foo", "bar"]))
    expect(result.get("foo")).toBe("1.0.0")
    expect(result.has("bar")).toBe(false)
  })

  it("HOIST FILTER: ignores entries whose name is not in rootDeps", () => {
    const lock = v7Lock({
      "node_modules/foo": { version: "1.0.0" },
      "node_modules/transitive-bar": { version: "2.0.0" },
      "node_modules/transitive-baz": { version: "3.0.0" },
    })
    const result = parsePackageLock(lock, new Set(["foo"]))
    expect(result.size).toBe(1)
    expect(result.get("foo")).toBe("1.0.0")
  })
})
