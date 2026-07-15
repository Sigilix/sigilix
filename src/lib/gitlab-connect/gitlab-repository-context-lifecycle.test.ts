import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  readRepositoryContext,
  releaseGitLabRepositoryAuthority,
  replaceRepositoryContext,
} from "@/src/features/repository-context"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { reconcileGitLabRepositoryContextAfterAuthorityChange } from "./gitlab-repository-context-lifecycle"

const CONTEXT_MIGRATION = readFileSync(
  new URL("../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const AUTHORITY_MIGRATION = readFileSync(
  new URL("../../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
  "utf8",
)

describe("GitLab repository-context authority lifecycle", () => {
  it("best-effort reconciliation removes disconnected rows and relationships", async () => {
    const db = makeD1()
    await db.exec(CONTEXT_MIGRATION)
    await db.exec(AUTHORITY_MIGRATION)
    const scopeId = "user-a"
    const claims = []
    for (const [sourceId, fullName] of [
      [5, "grp/api"],
      [6, "grp/worker"],
    ] as const) {
      const claim = await claimGitLabRepositoryAuthority(db, {
        scopeId,
        instanceOrigin: "https://gitlab.com",
        sourceId,
        fullName,
      })
      if (claim.status !== "claimed") throw new Error("expected claim")
      await activateGitLabRepositoryAuthority(db, {
        scopeId,
        externalId: claim.repository.externalId,
        claimToken: claim.claimToken,
      })
      claims.push(claim)
    }
    const seeded = await replaceRepositoryContext(db, {
      provider: "gitlab",
      scopeId,
      expectedRevision: 0,
      repositories: claims.map((claim, position) => ({
        ...claim.repository,
        context: `context-${position}`,
        position,
      })),
      relationships: [
        {
          fromExternalId: claims[0]!.repository.externalId,
          toExternalId: claims[1]!.repository.externalId,
          label: "queues",
          normalizedLabel: "queues",
          position: 0,
        },
      ],
      conventions: "keep",
      nowIso: "2026-07-14T12:00:00.000Z",
      updatedBy: "gitlab:user-a",
      authorityGuard: { revision: 2, externalIds: claims.map((claim) => claim.repository.externalId) },
    })
    expect(seeded.status).toBe("updated")

    await releaseGitLabRepositoryAuthority(db, {
      scopeId,
      externalId: claims[1]!.repository.externalId,
      claimToken: claims[1]!.claimToken,
    })
    await expect(reconcileGitLabRepositoryContextAfterAuthorityChange(db, scopeId)).resolves.toBe("updated")
    await expect(readRepositoryContext(db, "gitlab", scopeId)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        repositories: [{ externalId: claims[0]!.repository.externalId, context: "context-0" }],
        relationships: [],
        conventions: "keep",
      },
    })
  })
})
