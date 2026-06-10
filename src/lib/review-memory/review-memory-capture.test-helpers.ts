// Shared fixtures for the review-memory-capture.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).
//
// NB: the per-file `vi.mock("@/lib/review-memory/marker", …)` factory is
// NOT here — vitest hoists `vi.mock` per file, so a sibling that needs to
// override `hydrateClaimIds` declares it inline.

import { vi } from "vitest"
import type { Env } from "@/shared/types/env"
import type { GitHubClient } from "@/shared/adapters/github"
import type { ResolvedReviewMemoryConfig } from "@/lib/review-memory/types"

export interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  putKeys: string[]
  failPut: { value: boolean }
  failPutKeys: Set<string>
}

export function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const putKeys: string[] = []
  const failPut = { value: false }
  const failPutKeys = new Set<string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      putKeys.push(key)
      if (failPut.value || failPutKeys.has(key)) {
        throw new Error(`kv-put failed for ${key}`)
      }
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, putKeys, failPut, failPutKeys }
}

export function makeEnv(
  kv: Env["OPENCLAW_STATE"],
  captureEnv: "on" | "off" = "on",
): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_REVIEW_MEMORY_CAPTURE: captureEnv,
  } as unknown as Env
}

export function makeConfig(
  over: Partial<ResolvedReviewMemoryConfig> = {},
): ResolvedReviewMemoryConfig {
  return {
    enabled: false,
    captureOnly: true,  // capture-only by default — testing the
                        // capture path independently from retrieval
    categories: ["security", "logic", "performance", "tests"],
    maxInjectedMemories: 5,
    minSignalThreshold: 3,
    maxSignalAgeDays: 90,
    claimSoftening: false,
    ...over,
  }
}

export function makeClient(
  parentBody: string | null,
  opts: {
    /**
     * SIG-247 Phase 1: parent comment author login. The capture path
     * gates marker validation on isArcGithubLogin(parent.user?.login).
     * Default `"sigilix[bot]"` keeps existing happy-path tests passing;
     * a non-Sigilix login exercises the spoofing-hole guard.
     */
    authorLogin?: string
    /**
     * SIG-247 Phase 1: getRepository response used by the capture-time
     * fallback path (when args.repoId is undefined). Default is a
     * positive-integer id so dual-write paths fire without explicit
     * repoId plumbing in every test.
     */
    repoId?: number
  } = {},
): GitHubClient {
  const authorLogin = opts.authorLogin ?? "sigilix[bot]"
  const repoId = opts.repoId ?? 555_000
  const getPullRequestReviewComment = vi.fn(
    async (_o: string, _r: string, _id: number) => {
      if (parentBody === null) return null
      return { id: 9001, body: parentBody, user: { login: authorLogin } }
    },
  )
  const getRepository = vi.fn(async (_o: string, _r: string) => ({
    default_branch: "main",
    id: repoId,
  }))
  return {
    getPullRequestReviewComment,
    getRepository,
  } as unknown as GitHubClient
}

export const VALID_MARKER =
  "<!-- sigilix:fid:1111111111111111:cat:performance:sev:warning:path:222222222222 -->"
export const OTHER_VALID_MARKER =
  "<!-- sigilix:fid:3333333333333333:cat:security:sev:warning:path:444444444444 -->"
export const VALID_FINGERPRINT = "f".repeat(64)
export const VALID_FINGERPRINT_2 = "a".repeat(64)
export const PRECISION_FINDING_MARKERS = [
  "<!-- sigilix:pr-review-finding -->",
  "<!-- sigilix:category:performance -->",
  "<!-- sigilix:severity:3 -->",
  `<!-- sigilix:fingerprint:${VALID_FINGERPRINT} -->`,
].join("\n")
export const SECOND_PRECISION_FINDING_MARKERS = [
  "<!-- sigilix:pr-review-finding -->",
  "<!-- sigilix:category:security -->",
  "<!-- sigilix:severity:4 -->",
  `<!-- sigilix:fingerprint:${VALID_FINGERPRINT_2} -->`,
].join("\n")
