// SIG-184 PR 2 — POST /runner/ingest route, end-to-end through the REAL verify +
// provenance gate (a generated RSA keypair signs fixture tokens; the JWKS is
// served via a stubbed global fetch). Mocks: the receipt DO + the KV binding.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { handleRunnerIngestRoute } from "../src/lib/runner-ingest-route"
import { __resetJwksCacheForTests } from "../src/lib/runner-oidc/jwks-cache"
import { RunnerReceiptDO } from "../src/do/runner-receipt"
import type { GitHubOidcClaims, Jwk } from "../src/lib/runner-oidc/types"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

const ISS = "https://token.actions.githubusercontent.com"
const AUD = "sigilix-runner-ingest"
const KID = "test-kid-1"
const WORKFLOW = "sigilix/runner/.github/workflows/scan.yml"
const VALID_SARIF = JSON.stringify({ version: "2.1.0", runs: [] })

function b64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)))
}

let privateKey: CryptoKey
let jwk: Jwk

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const j = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey
  privateKey = pair.privateKey
  jwk = { kid: KID, kty: j.kty!, n: j.n!, e: j.e!, alg: "RS256", use: "sig" }
})

async function signToken(claims: Partial<GitHubOidcClaims>, kid = KID): Promise<string> {
  const input = `${b64urlJson({ alg: "RS256", kid })}.${b64urlJson(claims)}`
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

// exp far in the future so real Date.now() never expires the fixture token.
const baseClaims: GitHubOidcClaims = {
  iss: ISS,
  aud: AUD,
  exp: 2_000_000_000,
  iat: 1_700_000_000,
  repository: "Sigilix/sigilix",
  repository_id: "424242",
  sha: "deadbeef",
  run_id: "555",
  run_attempt: "1",
  job_workflow_ref: `${WORKFLOW}@v1`,
  runner_environment: "github-hosted",
}

function makeReceiptDo() {
  const store = new Map<string, string>() // key → sarifSha256
  let throwOnClaim = false
  const ns = {
    idFromName: (id: string) => ({ id }),
    get: () => ({
      async claimReceipt(args: { repositoryId: string; sha: string; runId: string; runAttempt: string; sarifSha256: string }) {
        if (throwOnClaim) throw new Error("do down")
        const k = `${args.repositoryId}:${args.sha}:${args.runId}:${args.runAttempt}`
        const existing = store.get(k)
        if (existing === undefined) {
          store.set(k, args.sarifSha256)
          return { outcome: "accepted" as const }
        }
        if (existing === args.sarifSha256) return { outcome: "duplicate" as const }
        return { outcome: "conflict" as const, existingSarifSha256: existing }
      },
    }),
  }
  return { ns, store, setThrow: (v: boolean) => { throwOnClaim = v } }
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    kv: {
      async put(k: string, v: string): Promise<void> { store.set(k, v) },
      async get(k: string): Promise<string | null> { return store.get(k) ?? null },
    },
    store,
  }
}

function makeEnv(over: Partial<Record<keyof Env, unknown>>, receiptNs: unknown, kv: unknown): Env {
  return {
    OPENCLAW_RUNNER_OIDC_AUDIENCE: AUD,
    OPENCLAW_RUNNER_WORKFLOW_REF: WORKFLOW,
    OPENCLAW_STATE: kv,
    RUNNER_RECEIPT_DO: receiptNs,
    ...over,
  } as unknown as Env
}

function stubJwksFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })))
}

function post(body: unknown, token?: string): Request {
  return new Request("https://x/runner/ingest", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const envelope = (over: Record<string, unknown> = {}) => ({
  sarif: VALID_SARIF,
  repository: "Sigilix/sigilix",
  sha: "deadbeef",
  ...over,
})

afterEach(() => {
  __resetJwksCacheForTests()
  vi.unstubAllGlobals()
})

describe("handleRunnerIngestRoute", () => {
  it("503 when the audience / workflow-ref config is unset", async () => {
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const res = await handleRunnerIngestRoute(post(envelope(), "tok"), makeEnv({ OPENCLAW_RUNNER_OIDC_AUDIENCE: undefined }, ns, kv))
    expect(res.status).toBe(503)
  })

  it("401 on a missing bearer token", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    expect((await handleRunnerIngestRoute(post(envelope()), makeEnv({}, ns, kv))).status).toBe(401)
  })

  it("401 on a wrong-audience token (verify fails)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken({ ...baseClaims, aud: "someone-else" })
    expect((await handleRunnerIngestRoute(post(envelope(), tok), makeEnv({}, ns, kv))).status).toBe(401)
  })

  it("503 (retry) when a forced JWKS refresh is throttled on a still-unknown kid", async () => {
    stubJwksFetch() // the JWKS only ever advertises KID
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const env = makeEnv({}, ns, kv)
    const rotated = await signToken(baseClaims, "rotated-kid") // a kid not in the JWKS
    // First unknown-kid on a cold isolate: forces a refetch → JWKS still lacks
    // the kid → 401, and the forced-refetch cooldown is now set.
    expect((await handleRunnerIngestRoute(post(envelope(), rotated), env)).status).toBe(401)
    // Second within the cooldown: forced refetch throttled → 503 retry, so a
    // possibly-just-rotated key isn't hard-failed.
    expect((await handleRunnerIngestRoute(post(envelope(), rotated), env)).status).toBe(503)
  })

  it("400 when the token lacks run_id / run_attempt (fail-closed key)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken({ ...baseClaims, run_id: undefined })
    const res = await handleRunnerIngestRoute(post(envelope(), tok), makeEnv({}, ns, kv))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("missing-claim")
  })

  it("413 on an oversized body (read past the cap)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken(baseClaims)
    const big = { sarif: "x".repeat(2 * 1024 * 1024 + 16), repository: "Sigilix/sigilix", sha: "deadbeef" }
    expect((await handleRunnerIngestRoute(post(big, tok), makeEnv({}, ns, kv))).status).toBe(413)
  })

  it("400 on invalid JSON", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken(baseClaims)
    expect((await handleRunnerIngestRoute(post("{not json", tok), makeEnv({}, ns, kv))).status).toBe(400)
  })

  it("400 on a bad envelope (missing sha)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken(baseClaims)
    const res = await handleRunnerIngestRoute(post({ sarif: VALID_SARIF, repository: "Sigilix/sigilix" }, tok), makeEnv({}, ns, kv))
    expect(res.status).toBe(400)
  })

  it("403 when the envelope repo doesn't match the token (provenance binding)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken(baseClaims)
    expect((await handleRunnerIngestRoute(post(envelope({ repository: "evil/repo" }), tok), makeEnv({}, ns, kv))).status).toBe(403)
  })

  it("403 on a self-hosted runner (isolation gate)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken({ ...baseClaims, runner_environment: "self-hosted" })
    expect((await handleRunnerIngestRoute(post(envelope(), tok), makeEnv({}, ns, kv))).status).toBe(403)
  })

  it("400 on malformed SARIF (wrong version)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const { kv } = makeKv()
    const tok = await signToken(baseClaims)
    const res = await handleRunnerIngestRoute(post(envelope({ sarif: JSON.stringify({ version: "1.0.0", runs: [] }) }), tok), makeEnv({}, ns, kv))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("bad-sarif")
  })

  it("200 accepted on the happy path + persists the receipt to KV", async () => {
    stubJwksFetch()
    const { ns, store } = makeReceiptDo()
    const kvWrap = makeKv()
    const tok = await signToken(baseClaims)
    const res = await handleRunnerIngestRoute(post(envelope(), tok), makeEnv({}, ns, kvWrap.kv))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      outcome: "accepted",
      receipt: { repository: "Sigilix/sigilix", sha: "deadbeef", runId: "555", runAttempt: "1" },
    })
    expect(store.size).toBe(1)
    expect([...kvWrap.store.keys()][0]).toBe("runner-receipt:repo:424242:deadbeef:555:1")
  })

  it("200 duplicate on an identical re-POST (idempotent CI retry)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const tok = await signToken(baseClaims)
    const env = makeEnv({}, ns, kvWrap.kv)
    await handleRunnerIngestRoute(post(envelope(), tok), env)
    const res2 = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(res2.status).toBe(200)
    expect(((await res2.json()) as { outcome: string }).outcome).toBe("duplicate")
  })

  it("409 conflict — same run, DIFFERENT SARIF", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const tok = await signToken(baseClaims)
    const env = makeEnv({}, ns, kvWrap.kv)
    await handleRunnerIngestRoute(post(envelope(), tok), env)
    const res2 = await handleRunnerIngestRoute(post(envelope({ sarif: JSON.stringify({ version: "2.1.0", runs: [], extra: 1 }) }), tok), env)
    expect(res2.status).toBe(409)
  })

  it("503 when the receipt DO is unavailable", async () => {
    stubJwksFetch()
    const r = makeReceiptDo()
    r.setThrow(true)
    const kvWrap = makeKv()
    const tok = await signToken(baseClaims)
    expect((await handleRunnerIngestRoute(post(envelope(), tok), makeEnv({}, r.ns, kvWrap.kv))).status).toBe(503)
  })

  it("scrubs secrets (classic + fine-grained PAT, AWS secret) from the persisted SARIF", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const tok = await signToken(baseClaims)
    const pat = `github_pat_${"A1b2C3d4".repeat(9)}` // > 60 chars after the prefix
    const awsSecret = "aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12" // 40-char secret
    const sarif = JSON.stringify({ version: "2.1.0", runs: [{ results: [{ message: { text: `leaked ${pat} and ${awsSecret}` } }] }] })
    await handleRunnerIngestRoute(post(envelope({ sarif }), tok), makeEnv({}, ns, kvWrap.kv))
    const stored = [...kvWrap.store.values()][0] ?? ""
    expect(stored).toContain("[REDACTED]")
    expect(stored).not.toContain(pat)
    expect(stored).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12")
  })

  it("backfills the SARIF body on a duplicate retry when the first KV put failed", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const store = new Map<string, string>()
    let failNextPut = true
    const kv = {
      async put(k: string, v: string): Promise<void> {
        if (failNextPut) { failNextPut = false; throw new Error("kv down") }
        store.set(k, v)
      },
      async get(k: string): Promise<string | null> { return store.get(k) ?? null },
    }
    const env = makeEnv({}, ns, kv)
    const tok = await signToken(baseClaims)
    // accept, but the KV put throws (swallowed) → 200 with no body persisted.
    expect((await handleRunnerIngestRoute(post(envelope(), tok), env)).status).toBe(200)
    expect(store.size).toBe(0)
    // idempotent retry → duplicate → backfills the body now that KV is healthy.
    expect((await handleRunnerIngestRoute(post(envelope(), tok), env)).status).toBe(200)
    expect(store.size).toBe(1)
  })

  it("end-to-end through the REAL RunnerReceiptDO: accepted → duplicate → conflict → re-run", async () => {
    stubJwksFetch()
    const sqlStorage = new NodeSqliteStorage()
    let alarmAt: number | null = null
    const doState = {
      storage: {
        sql: sqlStorage,
        transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
        async get(): Promise<unknown> { return undefined },
        async put(): Promise<void> { /* no-op */ },
        async delete(): Promise<boolean> { return false },
        async setAlarm(t: number): Promise<void> { alarmAt = t },
        async getAlarm(): Promise<number | null> { return alarmAt },
        async deleteAlarm(): Promise<void> { alarmAt = null },
      },
      id: { toString: () => "424242", name: "424242" },
    }
    const realDo = new RunnerReceiptDO(doState as unknown as DurableObjectState, {} as Env)
    const ns = { idFromName: (id: string) => ({ id }), get: () => realDo }
    const kvWrap = makeKv()
    const env = makeEnv({}, ns, kvWrap.kv)
    const tok = await signToken(baseClaims)
    const outcome = async (req: Request) => ((await (await handleRunnerIngestRoute(req, env)).json()) as { outcome: string }).outcome

    expect(await outcome(post(envelope(), tok))).toBe("accepted")
    expect(await outcome(post(envelope(), tok))).toBe("duplicate") // real DO single-use
    // same run, DIFFERENT SARIF → conflict (does not overwrite)
    expect((await handleRunnerIngestRoute(post(envelope({ sarif: JSON.stringify({ version: "2.1.0", runs: [], x: 1 }) }), tok), env)).status).toBe(409)
    // re-run (incremented run_attempt) → a new accepted receipt
    const rerun = await signToken({ ...baseClaims, run_attempt: "2" })
    expect(await outcome(post(envelope(), rerun))).toBe("accepted")
  })
})
