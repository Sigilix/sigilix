// ARC-190 vitest shim for Cloudflare Workers' `cloudflare:workers`
// virtual module. The real module is provided by the Workers runtime
// at execution time and exports `DurableObject` (the base class for
// DO implementations). In Node test runtime that module isn't
// resolvable, so we ship a minimal stand-in.
//
// Tests that actually exercise DO behavior provide their own
// `state.storage` / `env` mocks; the base class just needs a callable
// constructor that accepts the standard `(state, env)` shape.

export class DurableObject<EnvT = unknown> {
  protected readonly ctx: DurableObjectState
  protected readonly env: EnvT

  constructor(ctx: DurableObjectState, env: EnvT) {
    this.ctx = ctx
    this.env = env
  }

  // Subclasses override this. Default implementation 404s so a stray
  // construct-without-override surfaces in tests instead of silently
  // returning undefined.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented in shim", { status: 501 })
  }

  // Cloudflare's DurableObject runtime calls this on alarm fire. The
  // shim default no-ops so tests that don't care about alarms don't
  // need to override.
  async alarm(): Promise<void> {
    // no-op
  }
}

// Minimal DurableObjectState shape — tests provide a real Map-backed
// stub via `makeDoStub()` per the spec §4.2 contract.
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<boolean>
    setAlarm(timestamp: number): Promise<void>
    getAlarm(): Promise<number | null>
    deleteAlarm(): Promise<void>
  }
  id: { toString(): string; name?: string }
}
