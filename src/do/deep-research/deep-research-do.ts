// SIG-298 — DeepResearchDO: the Durable Object that runs one deep-research job
// and streams its transcript over SSE. One DO instance per run (crypto-random
// id from the route). The DO OWNS the event buffer: every emitted event is
// appended to an in-memory buffer AND persisted to DO storage (evt:<seq>), so a
// client that (re)connects to /stream replays the whole transcript from the
// start and then continues live. Cancellation is cooperative — the loop checks a
// flag between steps. A cleanup alarm wipes state ~1h after the last activity.
//
// Why the DO runs the loop directly (unlike PrReviewRunDO, which defers to a
// queue): the research loop is IO-bound (model + search + fetch awaits) and
// bounded by maxTimeMs (5 min) — wall-clock spent awaiting does not burn DO CPU
// time. The loop is kicked off with ctx.waitUntil so it outlives the /start
// request while /stream stays concurrently serviceable.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import { normalizeEnv } from "@/src/shared/util/normalize-env"
import { runResearchLoop, type EngineDeps } from "./engine"
import { parseEffort, parseMode, parseTier, resolveResearchConfig } from "./config"
import { buildModelFn, type ResearchModelFn } from "./model"
import { updateUsageEventCost } from "@/src/features/tenancy"
import { SIGILIX_MODEL_BURN_USD_PER_MTOK } from "@/src/shared/domain/sigilix-model-burn"
import { hasAnySearchProvider, searchWeb } from "./search"
import { fetchPage } from "./fetch-guard"
import { gatherRepoGrounding, type GatherRepoGroundingArgs } from "./repo-grounding"
import { isCodebaseQuestion, isTrivialMessage } from "./text-utils"
import type { RepoGrounding, ResearchEffort, ResearchEvent, ResearchMode, ResearchTier } from "./types"

const META_KEY = "meta"
const EVENT_PREFIX = "evt:"
const SEQ_PAD = 12
/** Header the route uses to bind a run to its creator (tenant/session subject). */
export const CREATOR_HEADER = "x-research-creator"

interface RunMeta {
  question: string
  startedAt: number
  seq: number
  done: boolean
  cancelled: boolean
  /** The opaque creator identity that owns this run (session subject / api
   *  tenant / installation id). Only this identity may stream or cancel it. */
  creator: string
  model: ResearchTier
  effort: ResearchEffort
  /** sig-chat-conversational-mode: the run mode (Deep Research toggle). */
  mode: ResearchMode
  /** sig-deep-research-repo-grounding: the repo (if any) resolved for this run
   *  from the caller's identity, and whether they have ANY indexed repo. */
  owner?: string
  repo?: string
  hasIndexedRepo?: boolean
}

/** Test seam: lets DO-level tests drive the loop with fake IO. Never set in
 *  production (buildDeps falls back to the real adapters). `gatherGrounding`
 *  lets a test inject codebase grounding without hitting real retrieval. */
export type ResearchTestHooks = Partial<Pick<EngineDeps, "model" | "search" | "fetchPage" | "now">> & {
  gatherGrounding?: (args: GatherRepoGroundingArgs) => Promise<RepoGrounding | null>
}

export class DeepResearchDO extends DurableObject<Env> {
  /** In-memory authoritative event buffer (mirrors persisted evt:* frames). */
  private events: string[] = []
  /** Live SSE subscribers. */
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>()
  private started = false
  private cancelled = false
  private done = false
  private seq = 0
  private driveDone: Promise<void> | null = null
  private hooks: ResearchTestHooks | undefined
  private creator = ""
  private model: ResearchTier = "astraeus"
  private effort: ResearchEffort = "medium"
  private mode: ResearchMode = "deep"
  private owner = ""
  private repo = ""
  private hasIndexedRepo = false
  private readonly encoder = new TextEncoder()

  // sig-worker-debrand-openclaw: resolve SIGILIX_ (preferred) / OPENCLAW_ (fallback)
  // research config + search-provider keys on `this.env` (see normalize-env.ts).
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, normalizeEnv(env))
  }

  /** Route the internal DO requests. Matches PrReviewRunDO's fetch-based API. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/start") return this.handleStart(request)
    if (request.method === "GET" && url.pathname === "/stream") return this.handleStream(request)
    if (request.method === "POST" && url.pathname === "/cancel") return this.handleCancel(request)
    return json({ error: "not found" }, 404)
  }

  /** Install test IO hooks (test-only seam; no-op contract in prod). */
  setTestHooks(hooks: ResearchTestHooks): void {
    this.hooks = hooks
  }

  private async handleStart(request: Request): Promise<Response> {
    if (this.started) return json({ ok: true, alreadyStarted: true })
    let body: {
      question?: unknown
      model?: unknown
      effort?: unknown
      mode?: unknown
      creator?: unknown
      owner?: unknown
      repo?: unknown
      hasIndexedRepo?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return json({ error: "invalid json" }, 400)
    }
    const question = typeof body.question === "string" ? body.question.trim() : ""
    if (!question) return json({ error: "missing question" }, 400)

    // The route validates model/effort and rejects bad values with a 400 before
    // ever reaching the DO; here we simply default anything absent/unknown.
    this.model = parseTier(body.model) ?? "astraeus"
    this.effort = parseEffort(body.effort) ?? "medium"
    // sig-chat-conversational-mode: the Deep Research toggle. Default "deep" so an
    // API-key caller (or an older portal) that omits it keeps full research.
    this.mode = parseMode(body.mode) ?? "deep"
    this.creator = typeof body.creator === "string" ? body.creator : ""
    // sig-deep-research-repo-grounding: the repo target (resolved in the route from
    // the caller's identity) + whether they have any indexed repo. Absent ⇒ no
    // codebase grounding for this run.
    this.owner = typeof body.owner === "string" ? body.owner.trim() : ""
    this.repo = typeof body.repo === "string" ? body.repo.trim() : ""
    this.hasIndexedRepo = body.hasIndexedRepo === true

    this.started = true
    const meta: RunMeta = {
      question,
      startedAt: Date.now(),
      seq: 0,
      done: false,
      cancelled: false,
      creator: this.creator,
      model: this.model,
      effort: this.effort,
      mode: this.mode,
      ...(this.owner ? { owner: this.owner } : {}),
      ...(this.repo ? { repo: this.repo } : {}),
      hasIndexedRepo: this.hasIndexedRepo,
    }
    await this.ctx.storage.put(META_KEY, meta)
    await this.armCleanupAlarm()

    this.driveDone = this.drive(question)
    // Keep the DO alive while the loop runs, without blocking /stream.
    this.ctx.waitUntil?.(this.driveDone)
    return json({ ok: true })
  }

  private async drive(question: string): Promise<void> {
    const config = resolveResearchConfig(this.env, { model: this.model, effort: this.effort })
    const runId = this.ctx.id.toString()
    const tenant = this.creator || "anonymous"

    // sig-deep-research-repo-grounding: gather codebase grounding for the resolved
    // repo (if any) BEFORE the loop, reusing the PR-review retrieval seam. Soft-
    // fails to null (the run then falls back to web research) — grounding must
    // never break a run.
    let repoGrounding: RepoGrounding | null = null
    // Gather grounding only when the engine will actually USE it: deep mode (a
    // codebase question answers from the repo, a non-codebase one folds it into the
    // web loop) OR a codebase question in chat mode. A trivial greeting, and a
    // non-codebase chat message, both answer directly — retrieving code for them
    // would only add latency to a message that never cites it.
    const wantGrounding = this.mode === "deep" || isCodebaseQuestion(question)
    if (this.owner && this.repo && wantGrounding && !isTrivialMessage(question)) {
      const gather = this.hooks?.gatherGrounding ?? gatherRepoGrounding
      try {
        repoGrounding = await gather({ env: this.env, owner: this.owner, repo: this.repo, query: question })
      } catch {
        repoGrounding = null
      }
    }

    // sig-cost-based-metering: wrap the model fn to tally this run's total tokens
    // across EVERY model call (every engine path routes through deps.model), so we
    // can stamp the chatbot's real token spend + estimated cost onto its usage_events
    // row after the run — the CLI/chat surfaces previously recorded ZERO token/cost
    // data. Engine untouched; the wrapper only sums (pure aside from the counter).
    let tokensAccum = 0
    const baseModel: ResearchModelFn = this.hooks?.model ?? buildModelFn(this.env, config)
    const meteredModel: ResearchModelFn = async (role, messages) => {
      const r = await baseModel(role, messages)
      if (Number.isFinite(r.tokens) && r.tokens > 0) tokensAccum += r.tokens
      return r
    }

    const deps: EngineDeps = {
      question,
      runId,
      config,
      hasSearchProvider: hasAnySearchProvider(this.env),
      repoGrounding,
      hasIndexedRepo: this.hasIndexedRepo,
      mode: this.mode,
      emit: (event) => this.emit(event),
      model: meteredModel,
      search: this.hooks?.search ?? ((query) => searchWeb({ query, env: this.env, runId, tenant })),
      fetchPage: this.hooks?.fetchPage ?? ((pageUrl) => fetchPage({ url: pageUrl, runId, tenant })),
      isCancelled: () => this.cancelled,
      now: this.hooks?.now ?? (() => Date.now()),
    }
    await runResearchLoop(deps)

    // Late-bind the chatbot event's tokens + cost (the row was appended at run-start
    // by the route, keyed by runId = this DO id). Cost is ESTIMATED from the tier's
    // representative burn rate — the DO has a combined token total, not a per-model
    // split, so this is a documented estimate, not a billed figure. Fail-open: a
    // metering fault must never surface on the (already-streamed) research run.
    // ORDERING: the route appends the row (fire-and-forget) at run START; this UPDATE
    // runs at run COMPLETION (seconds–minutes later), so the row is reliably present.
    // In the pathological case where it isn't, the UPDATE matches 0 rows (harmless
    // no-op) and the row keeps cost 0 — an under-count, never a wrong block.
    try {
      const costUsd = (tokensAccum / 1_000_000) * (SIGILIX_MODEL_BURN_USD_PER_MTOK[this.model] ?? 0)
      await updateUsageEventCost(this.env, { meter: "chatbot", eventId: runId, tokens: tokensAccum, costUsd })
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "chatbot-usage-cost-update-failed",
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  /** Append an event to the buffer, persist it, and fan it out to live writers. */
  private async emit(event: ResearchEvent): Promise<void> {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    this.events.push(frame)
    this.seq += 1
    const key = EVENT_PREFIX + String(this.seq).padStart(SEQ_PAD, "0")
    await this.ctx.storage.put(key, frame)
    await this.touchMeta(event)
    await this.armCleanupAlarm()

    const bytes = this.encoder.encode(frame)
    for (const writer of [...this.writers]) {
      try {
        await writer.write(bytes)
      } catch {
        this.writers.delete(writer)
      }
    }
    if (event.type === "done") {
      this.done = true
      for (const writer of [...this.writers]) {
        try {
          await writer.close()
        } catch {
          // already closed / aborted
        }
        this.writers.delete(writer)
      }
    }
  }

  private async touchMeta(event: ResearchEvent): Promise<void> {
    const meta = (await this.ctx.storage.get<RunMeta>(META_KEY)) ?? {
      question: "",
      startedAt: Date.now(),
      seq: 0,
      done: false,
      cancelled: false,
      creator: this.creator,
      model: this.model,
      effort: this.effort,
      mode: this.mode,
    }
    meta.seq = this.seq
    if (event.type === "done") meta.done = true
    if (this.cancelled) meta.cancelled = true
    await this.ctx.storage.put(META_KEY, meta)
  }

  /** Enforce that the requester owns this run. Returns a 403 when the presented
   *  creator differs from the stored one; null when it matches (or no run yet). */
  private async ownerGuard(request: Request): Promise<Response | null> {
    const meta = await this.ctx.storage.get<RunMeta>(META_KEY)
    if (!meta) return null // nothing to protect yet
    const presented = request.headers.get(CREATOR_HEADER) ?? ""
    if (meta.creator && meta.creator !== presented) return json({ error: "forbidden" }, 403)
    return null
  }

  private async handleStream(request: Request): Promise<Response> {
    const forbidden = await this.ownerGuard(request)
    if (forbidden) return forbidden

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()

    // Hydrate the in-memory buffer from storage on a cold isolate. Guarded so a
    // concurrent live emit (same isolate) is never clobbered.
    if (this.events.length === 0) {
      const loaded = await this.loadPersistedFrames()
      if (this.events.length === 0) {
        this.events = loaded.frames
        this.seq = loaded.seq
        this.done = loaded.done
      }
    }

    // Replay the full transcript synchronously (no await) → no race with emit.
    for (const frame of this.events) {
      void writer.write(this.encoder.encode(frame))
    }
    if (this.done) {
      void writer.close()
    } else {
      this.writers.add(writer)
    }
    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    })
  }

  private async handleCancel(request: Request): Promise<Response> {
    const meta = await this.ctx.storage.get<RunMeta>(META_KEY)
    if (!meta) return json({ error: "not started" }, 409)
    const presented = request.headers.get(CREATOR_HEADER) ?? ""
    if (meta.creator && meta.creator !== presented) return json({ error: "forbidden" }, 403)
    this.cancelled = true
    meta.cancelled = true
    await this.ctx.storage.put(META_KEY, meta)
    return json({ ok: true, cancelled: true })
  }

  /** Load persisted frames in seq order for cold-isolate replay. */
  private async loadPersistedFrames(): Promise<{ frames: string[]; seq: number; done: boolean }> {
    const map = await this.ctx.storage.list<string>({ prefix: EVENT_PREFIX })
    const frames = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v)
    const meta = await this.ctx.storage.get<RunMeta>(META_KEY)
    // Prefer the persisted meta flag; else derive from the last frame's parsed
    // type (the terminal event is always `done`) rather than a substring match.
    const doneFromFrames = frameType(frames[frames.length - 1]) === "done"
    return { frames, seq: meta?.seq ?? frames.length, done: meta?.done ?? doneFromFrames }
  }

  private async armCleanupAlarm(): Promise<void> {
    const config = resolveResearchConfig(this.env, { model: this.model, effort: this.effort })
    await this.ctx.storage.setAlarm(Date.now() + config.cleanupAfterMs)
  }

  /** Cleanup: wipe all run state ~1h after the last activity. */
  override async alarm(): Promise<void> {
    for (const writer of [...this.writers]) {
      try {
        await writer.close()
      } catch {
        // ignore
      }
      this.writers.delete(writer)
    }
    if (typeof this.ctx.storage.deleteAll === "function") {
      await this.ctx.storage.deleteAll()
    } else {
      const map = await this.ctx.storage.list()
      for (const key of map.keys()) await this.ctx.storage.delete(key)
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Parse the `type` out of a persisted `data: {json}\n\n` frame, or null. */
function frameType(frame: string | undefined): string | null {
  if (!frame) return null
  try {
    const parsed = JSON.parse(frame.replace(/^data: /, "").trim()) as { type?: unknown }
    return typeof parsed.type === "string" ? parsed.type : null
  } catch {
    return null
  }
}
