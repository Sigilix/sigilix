// SIG-304 (review CLI) Phase 1b — Node stub for the Workers-only `cloudflare:workers`
// module. The review engine reuses Worker code that statically imports
// `{ DurableObject }` from `cloudflare:workers` (9 DO classes). Those classes are
// never INSTANTIATED on the CLI path (local-env stubs the DO bindings) — but the
// static import must still resolve for the module graph to load under plain Node.
// `cloudflare-loader.mjs` redirects the import here. Minimal base classes only.

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}

export class RpcTarget {}
