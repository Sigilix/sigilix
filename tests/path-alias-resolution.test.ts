// SIG-318: locks the `@/*` → `src/*` path alias in vitest. Imports real modules
// via `@/` and asserts they loaded — fails if the vitest `resolve.alias` (or the
// tsconfig `paths`) for `@` is removed/broken. (The Worker-bundle + tsc sides are
// exercised by the canary `@/` import in src/index.ts, which CI's Workers Build
// and `tsc --noEmit` both compile.)
import { describe, it, expect } from "vitest"
import { EMBEDDING_DIMENSIONS } from "@/shared/adapters/model"
import { ALL_SPECIALISTS } from "@/shared/domain/specialist-role"

describe("@/ path alias (SIG-318)", () => {
  it("resolves @/<path> to src/<path>", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768)
    expect(ALL_SPECIALISTS).toEqual(["logic", "security", "performance", "tests"])
  })
})
