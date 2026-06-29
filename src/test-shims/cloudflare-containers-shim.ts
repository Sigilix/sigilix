// SIG-545 B1 vitest shim for the `@cloudflare/containers` package.
//
// The real `Container` base class extends Cloudflare's `cloudflare:workers`
// DurableObject, which only resolves at Workers runtime — in Node/vitest the
// package's `class Container extends DurableObject` evaluates `DurableObject`
// to `undefined` and throws "Class extends value undefined" at import time.
// Because `src/index.ts` statically exports `AgentRunnerContainer` (which
// extends `Container`), that import-time crash would break EVERY test that
// imports the worker entry (the webhook/index suites). So, exactly like the
// `cloudflare:workers` alias, we alias the package to this minimal stand-in.
//
// Tests that actually exercise dispatch/container behavior provide their own
// `vi.mock("@cloudflare/containers", …)` (the factory wins over this alias)
// or construct the DO with a Map-backed `ctx` stub. This base only needs to
// be a real, extendable class so subclassing + the field overrides type-check
// and load.

interface ContainerCtx {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<boolean>
  }
  id: { toString(): string; name?: string }
}

export class Container<EnvT = unknown> {
  protected readonly ctx: ContainerCtx
  protected readonly env: EnvT

  // Fields the real Container exposes for subclasses to override. Declared
  // mutable so `override defaultPort = 8080` etc. assign cleanly.
  defaultPort = 0
  sleepAfter: string | number = 0
  enableInternet = false
  requiredPorts: number[] = []
  entrypoint: string[] = []
  envVars: Record<string, string> = {}

  constructor(ctx: ContainerCtx, env: EnvT) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented in @cloudflare/containers shim", { status: 501 })
  }
}

// A stub container instance handle. Tests that drive `getContainer` mock the
// package; this stand-in returns a benign handle so an un-mocked call doesn't
// crash at import or call time.
export function getContainer(
  _namespace: unknown,
  _idName?: string,
): {
  fetch(request: Request): Promise<Response>
  getRunRecord(): Promise<null>
} {
  return {
    async fetch(_request: Request): Promise<Response> {
      return new Response("getContainer shim: mock @cloudflare/containers to exercise this path", {
        status: 501,
      })
    },
    async getRunRecord(): Promise<null> {
      return null
    },
  }
}
