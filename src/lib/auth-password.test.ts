// auth-password: PBKDF2 hash/verify roundtrip, wrong-password rejection,
// self-describing format, and work-factor upgrade detection.

import { describe, it, expect } from "vitest"
import {
  hashPassword,
  isAcceptablePassword,
  needsRehash,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
} from "@/src/lib/auth-password"

describe("auth-password", () => {
  it("hashes into the self-describing PHC-style format and never returns the plaintext", async () => {
    const hash = await hashPassword("correct horse battery staple")
    expect(hash.startsWith("pbkdf2-sha256$")).toBe(true)
    expect(hash.split("$")).toHaveLength(4)
    expect(hash).not.toContain("correct horse")
  })

  it("verifies the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("s3cret-passphrase!")
    expect(await verifyPassword("s3cret-passphrase!", hash)).toBe(true)
    expect(await verifyPassword("s3cret-passphrase?", hash)).toBe(false)
    expect(await verifyPassword("", hash)).toBe(false)
  })

  it("produces a different hash each call (random salt) but both verify", async () => {
    const a = await hashPassword("same-password-here")
    const b = await hashPassword("same-password-here")
    expect(a).not.toBe(b)
    expect(await verifyPassword("same-password-here", a)).toBe(true)
    expect(await verifyPassword("same-password-here", b)).toBe(true)
  })

  it("fails closed (false, no throw) on a malformed stored hash", async () => {
    expect(await verifyPassword("x", "not-a-valid-hash")).toBe(false)
    expect(await verifyPassword("x", "pbkdf2-sha256$abc$def$ghi")).toBe(false)
    expect(await verifyPassword("x", "")).toBe(false)
  })

  it("flags a lower-iteration hash for rehash", async () => {
    const weak = await hashPassword("pw-to-upgrade", 1000)
    expect(needsRehash(weak)).toBe(true)
    const current = await hashPassword("pw-to-upgrade")
    expect(needsRehash(current)).toBe(false)
    expect(needsRehash("garbage")).toBe(true)
  })

  it("enforces the minimum password length", () => {
    expect(isAcceptablePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true)
    expect(isAcceptablePassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false)
    expect(isAcceptablePassword("a".repeat(1000))).toBe(false)
  })
})
