import { describe, expect, it } from "vitest"
import { isStableRuntimeScope, runtimeSessionScope } from "./runtime-principal"

describe("runtimeSessionScope", () => {
  it("keeps the established GitHub namespace when both stable ids exist", () => {
    expect(runtimeSessionScope({ githubUserId: 42, userId: "9e3f198f-0f9e-4e3e-8e23-aab253be56e6" })).toBe("session:42")
  })

  it("uses the persistent user identity for non-GitHub sessions", () => {
    expect(runtimeSessionScope({ userId: "9e3f198f-0f9e-4e3e-8e23-aab253be56e6" })).toBe(
      "session:9e3f198f-0f9e-4e3e-8e23-aab253be56e6",
    )
  })

  it("fails closed instead of manufacturing session:anon", () => {
    expect(runtimeSessionScope({})).toBeNull()
    expect(runtimeSessionScope({ githubUserId: 0, userId: "  " })).toBeNull()
  })
})

describe("isStableRuntimeScope", () => {
  it("accepts only real session or installation namespaces", () => {
    expect(isStableRuntimeScope("session:42")).toBe(true)
    expect(isStableRuntimeScope("session:9e3f198f-0f9e-4e3e-8e23-aab253be56e6")).toBe(true)
    expect(isStableRuntimeScope("tenant:123")).toBe(true)
    expect(isStableRuntimeScope("session:anon")).toBe(false)
    expect(isStableRuntimeScope("session:anonymous")).toBe(false)
    expect(isStableRuntimeScope("tenant:-1")).toBe(false)
    expect(isStableRuntimeScope("tenant:0")).toBe(false)
    expect(isStableRuntimeScope("anonymous")).toBe(false)
  })
})
