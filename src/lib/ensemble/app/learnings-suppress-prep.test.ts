// SIG-104 PR-3: e2e for the learnings SUPPRESS gate through the real
// `applyLearningSuppressions` path (KV-mocked). Proves the off/shadow/on
// mode contract end-to-end + that the recall carve-outs fire through the
// wired path (not just the pure core), and that the attribution pill is
// stamped only in `on` mode.
import { afterEach, describe, expect, it, vi } from "vitest"

import { applyLearningSuppressions } from "@/src/lib/ensemble/app/learnings-suppress-prep"
import { appendLearning, computeLearningId, type LearningEntry } from "@/src/features/learnings"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import type { Env } from "@/src/shared/types/env"

const REPO_ID = 555
const SUBJECT = String(REPO_ID)
const TS = Date.parse("2026-06-15T12:00:00.000Z")
// Seat∪Org apply-side test fixtures: owner/repo "o/r" resolves to installation
// 42, so an org-scope learning lives at `learnings:org:42`.
const INSTALL_ID = 42
const ORG_SUBJECT = String(INSTALL_ID)
const INSTALL_MAP = JSON.stringify({ "o/r": INSTALL_ID })

function makeEnv(mode: string | undefined, extra: Partial<Env> = {}): { env: Env } {
  const values = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      values.set(key, value)
    },
    async delete(key: string): Promise<void> {
      values.delete(key)
    },
  }
  return { env: { OPENCLAW_STATE: kv, OPENCLAW_LEARNINGS_MODE: mode, ...extra } as unknown as Env }
}

async function seedLearning(env: Env, overrides: Partial<LearningEntry>): Promise<void> {
  const rule = overrides.rule ?? "Treat generated SDK files as context only."
  const id = overrides.id ?? (await computeLearningId(rule))
  const entry: LearningEntry = {
    id,
    rule,
    polarity: overrides.polarity ?? "suppress",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: "repo",
    subjectId: SUBJECT,
    source: { kind: "command", prNumber: 1, commentId: 1 },
    createdTs: new Date(TS).toISOString(),
    appliedCount: 0,
  }
  await appendLearning(env, "repo", SUBJECT, entry, TS)
}

async function seedOrgLearning(env: Env, overrides: Partial<LearningEntry>): Promise<void> {
  const rule = overrides.rule ?? "Vendored files are context only."
  const id = overrides.id ?? (await computeLearningId(rule))
  const entry: LearningEntry = {
    id,
    rule,
    polarity: overrides.polarity ?? "suppress",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: "org",
    subjectId: ORG_SUBJECT,
    source: { kind: "command", prNumber: 1, commentId: 1 },
    createdTs: new Date(TS).toISOString(),
    appliedCount: 0,
  }
  await appendLearning(env, "org", ORG_SUBJECT, entry, TS)
}

function finding(overrides: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    path: overrides.path ?? "src/generated/sdk.ts",
    line: overrides.line ?? 10,
    score: overrides.score ?? 2,
    category: overrides.category ?? "style",
    headline: overrides.headline ?? "nit",
    body: overrides.body ?? "minor",
    ...overrides,
  }
}

function provenanceFor(roles: SpecialistRole[][]): SynthesizerProvenance["findings"] {
  return roles.map((sourceSpecialists, i) => ({
    sourceSpecialists,
    sourceFindingIds: [`${sourceSpecialists[0] ?? "tests"}-${i}`],
    action: "kept" as const,
    verifiedViaRetrieval: false,
  }))
}

afterEach(() => vi.restoreAllMocks())

describe("applyLearningSuppressions — mode contract", () => {
  it("OFF: returns the input set unchanged and does NOT even read the store", async () => {
    const { env } = makeEnv("off")
    const getSpy = vi.spyOn(env.OPENCLAW_STATE, "get")
    const kept = [finding({ path: "src/generated/sdk.ts" })]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toBe(kept) // same reference — byte-identical, no work
    expect(getSpy).not.toHaveBeenCalled()
  })

  it("SHADOW: telemeters a would-suppress but drops NOTHING and stamps NO attribution", async () => {
    const { env } = makeEnv("shadow")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**" })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const kept = [finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1) // dropped nothing
    expect(out[0]?.shapedByLearning).toBeUndefined() // no attribution in shadow
    const decision = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "learnings-suppress-decision")
    expect(decision).toMatchObject({ mode: "shadow", wouldSuppress: 1 })
  })

  it("ON: drops the matched noise finding from the kept set", async () => {
    const { env } = makeEnv("on")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const noise = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const keeper = finding({ path: "src/app/handler.ts", score: 3, category: "performance" })
    const kept = [noise, keeper]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"], ["performance"]]),
      changedPaths: ["src/generated/sdk.ts", "src/app/handler.ts"],
    })
    expect(out.map((f) => f.path)).toEqual(["src/app/handler.ts"])
  })
})

describe("applyLearningSuppressions — recall carve-outs fire through the wired path", () => {
  it("ON: NEVER drops a P0/P1 even on a perfect match — stamps attribution instead", async () => {
    const { env } = makeEnv("on")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const blocker = finding({ path: "src/generated/sdk.ts", score: 5, category: "style" })
    const kept = [blocker]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1) // P0 survives
    expect(out[0]?.shapedByLearning?.ruleText).toBe("Treat generated SDK files as context only.")
  })

  it("ON: NEVER drops a security/logic-by-provenance finding (miscategorized as style)", async () => {
    const { env } = makeEnv("on")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**", category: "style" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    // Looks like a style nit by category, but the SOURCE specialist is security.
    const realBug = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const kept = [realBug]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["security"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1) // security bug survives the suppress rule
    expect(out[0]?.shapedByLearning).toBeDefined()
  })

  it("ON: NEVER drops a deterministically-grounded finding (astEvidence)", async () => {
    const { env } = makeEnv("on")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const grounded = finding({
      path: "src/generated/sdk.ts",
      score: 2,
      category: "style",
      astEvidence: "redacted slice",
    })
    const kept = [grounded]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1)
  })

  it("ON: NEVER drops a finding whose SOURCE-ID prefix is security even if sourceSpecialists lies", async () => {
    const { env } = makeEnv("on")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**", category: "style" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const realBug = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const kept = [realBug]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      // Roles say "tests" (innocuous) but the source ids say security → must keep.
      consensusProvenance: [
        { sourceSpecialists: ["tests"], sourceFindingIds: ["security-0"], action: "kept", verifiedViaRetrieval: false },
      ],
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.shapedByLearning).toBeDefined()
  })

  it("ON: NEVER drops a finding grounded by a deterministic evidenceRef", async () => {
    const { env } = makeEnv("on")
    await seedLearning(env, { id: "gen", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const grounded = finding({
      path: "src/generated/sdk.ts",
      score: 2,
      category: "style",
      evidenceRefs: ["inspectedTestFile:tests/sdk.test.ts"],
    })
    const kept = [grounded]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1)
  })

  it("best-effort: a KV failure degrades to no suppression (recall-safe)", async () => {
    const env = {
      OPENCLAW_STATE: {
        async get(): Promise<string | null> {
          throw new Error("kv down")
        },
        async put(): Promise<void> {},
        async delete(): Promise<void> {},
      },
      OPENCLAW_LEARNINGS_MODE: "on",
    } as unknown as Env
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const kept = [finding({ path: "src/generated/sdk.ts", score: 2 })]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toBe(kept) // unchanged on failure
  })
})

describe("applyLearningSuppressions — Seat∪Org apply (org-scope union through the wired path)", () => {
  it("APPLY OFF (unset): an org-scope rule is NEVER unioned — its matching finding survives", async () => {
    // Suppress gate ON, but the apply/read flag is OFF → org is never read.
    const { env } = makeEnv("on", { OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL_MAP })
    await seedOrgLearning(env, { id: "org-gen", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const noise = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const kept = [noise]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    // Org rule not applied (apply flag off) → finding is untouched. The two flags
    // compose independently: LEARNINGS_MODE=on ran the gate, but with no repo
    // learning and org not unioned, there was nothing to suppress.
    expect(out.map((f) => f.path)).toEqual(["src/generated/sdk.ts"])
  })

  it("APPLY ON: applied set == repo ∪ org — an org-only rule suppresses a finding no repo rule would catch", async () => {
    const { env } = makeEnv("on", {
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL_MAP,
    })
    // Repo rule catches src/generated/**; a DIFFERENT org rule (different glob +
    // id) catches src/vendor/** — a path no repo rule mentions.
    await seedLearning(env, { id: "repo-gen", rule: "Generated SDK is context.", pathGlob: "src/generated/**" })
    await seedOrgLearning(env, { id: "org-vendor", rule: "Vendored libs are context.", pathGlob: "src/vendor/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const noiseRepo = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const noiseOrg = finding({ path: "src/vendor/lib.ts", score: 2, category: "style" })
    const keeper = finding({ path: "src/app/handler.ts", score: 3, category: "performance" })
    const kept = [noiseRepo, noiseOrg, keeper]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"], ["tests"], ["performance"]]),
      changedPaths: ["src/generated/sdk.ts", "src/vendor/lib.ts", "src/app/handler.ts"],
    })
    // Both the repo-matched AND the org-only-matched noise are dropped — proving
    // an org-scope rule shapes the review.
    expect(out.map((f) => f.path)).toEqual(["src/app/handler.ts"])
  })

  it("APPLY ON: a learning mirrored into BOTH scopes (same id) applies exactly once (dedup)", async () => {
    const { env } = makeEnv("on", {
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL_MAP,
    })
    // Same id in repo + org, exactly as mirrorLearningToOrgScope produces.
    await seedLearning(env, { id: "dup", rule: "Generated SDK is context.", pathGlob: "src/generated/**" })
    await seedOrgLearning(env, { id: "dup", rule: "Generated SDK is context.", pathGlob: "src/generated/**" })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const noise = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const keeper = finding({ path: "src/app/handler.ts", score: 3, category: "performance" })
    const kept = [noise, keeper]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"], ["performance"]]),
      changedPaths: ["src/generated/sdk.ts", "src/app/handler.ts"],
    })
    expect(out.map((f) => f.path)).toEqual(["src/app/handler.ts"])
    // The deduped rule is a SINGLE candidate — not double-counted — and drops the
    // finding once.
    const decision = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "learnings-suppress-decision")
    expect(decision).toMatchObject({ candidates: 1, wouldSuppress: 1 })
  })

  it("RECALL-SAFETY: an org-scope rule NEVER drops a P0/P1 — carve-out is scope-agnostic", async () => {
    const { env } = makeEnv("on", {
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL_MAP,
    })
    // The suppress rule comes ONLY from org scope this time.
    await seedOrgLearning(env, { id: "org-gen", rule: "Generated SDK is context.", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const blocker = finding({ path: "src/generated/sdk.ts", score: 5, category: "style" })
    const kept = [blocker]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1) // P0/P1 survives even against an org rule
    expect(out[0]?.shapedByLearning?.ruleText).toBe("Generated SDK is context.")
  })

  it("RECALL-SAFETY: an org-scope rule NEVER drops a security/logic-by-provenance finding", async () => {
    const { env } = makeEnv("on", {
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL_MAP,
    })
    await seedOrgLearning(env, { id: "org-gen", pathGlob: "src/generated/**", category: "style" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    // Looks like a style nit, but the source specialist is security.
    const realBug = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const kept = [realBug]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["security"]]),
      changedPaths: ["src/generated/sdk.ts"],
    })
    expect(out).toHaveLength(1) // org learnings get no suppression power over the carve-outs
    expect(out[0]?.shapedByLearning).toBeDefined()
  })

  it("fail-soft: an unresolvable installation degrades to a repo-only review (no throw)", async () => {
    const { env } = makeEnv("on", {
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      // Map that does NOT resolve o/r → org load is skipped, review is repo-only.
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "x/y": 99 }),
    })
    await seedLearning(env, { id: "repo-gen", pathGlob: "src/generated/**" })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const noise = finding({ path: "src/generated/sdk.ts", score: 2, category: "style" })
    const keeper = finding({ path: "src/app/handler.ts", score: 3, category: "performance" })
    const kept = [noise, keeper]
    const out = await applyLearningSuppressions({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      repoId: REPO_ID,
      kept,
      renderableFindings: kept,
      consensusProvenance: provenanceFor([["tests"], ["performance"]]),
      changedPaths: ["src/generated/sdk.ts", "src/app/handler.ts"],
    })
    // Repo rule still applied (org unreachable) — the review completed normally.
    expect(out.map((f) => f.path)).toEqual(["src/app/handler.ts"])
  })
})
