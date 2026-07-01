# Repo role classification

Detects and stores each indexed repo's **role** — `frontend` / `backend` /
`infra` / `library` / `mobile` / `fullstack` / `unknown` — at index time, from
cheap real signals. This is the foundation for cross-repo context: a later slice
will re-rank retrieval/review by role.

**Additive + shadow-safe.** The index job stamps `role` onto the repo's index
manifest KV record; **nothing reads it yet**, so there is zero behavior change.
`unknown` is the fail-safe default — we never guess wildly.

## Signals (cheap, index-time)

Gathered by `gatherRepoRoleSignals({ treePaths, packageJsonRaw })` (pure) from
the two inputs already available during the `index-repo` job:

- the **flattened git-tree paths** (already in memory after `getRepoTree`), for
  an extension histogram + marker-file presence (`Dockerfile`, `*.tf`,
  `go.mod`, `Cargo.toml`, `AndroidManifest.xml`, `next.config.*`, `manage.py`, …);
- the **root `package.json`** body (one file fetch, and only when the tree
  actually has one), for the dependency-name union + publishable markers
  (`main` / `exports` / `bin` / `private`).

No file contents are deep-scanned. `RepoRoleSignals` is the explicit, named
signal set the classifier reasons over.

## Precedence (first match wins)

`classifyRepoRole(signals)` applies a fixed, documented order by
specificity/confidence:

1. **mobile** — react-native/expo/flutter, or a native android/ios shell.
   Checked first: a react-native app also depends on `react`.
2. **infra** — dominated by IaC/orchestration (terraform/pulumi/cloudformation/
   k8s/helm) with no app framework.
3. **fullstack** — both a frontend and a backend surface (FE+BE deps, a monorepo
   with both, or an FE meta-framework with API routes / a server dep).
4. **frontend** — a frontend surface and no backend surface.
5. **backend** — a backend surface (express/fastify/nest/koa/hapi, or non-JS
   django/rails/spring/.NET markers) and no frontend surface.
6. **library** — a publishable package with none of the above app surfaces.
7. **unknown** — insufficient signal (FAIL-SAFE default).

## Wiring

`computeRepoRoleForIndex` (in `src/lib/indexer-persist.ts`) fetches
`package.json` best-effort and calls `computeRepoRole`, then `persistManifest`
stamps `repoRole` onto the manifest. It is gated behind
`OPENCLAW_REPO_ROLE_CLASSIFY` (default **off**) and only runs on the
default-branch manifest — it **never fails or slows the index job** (any error
yields `unknown`; when the flag is off, no fetch happens at all). Incremental
push refreshes carry the prior role forward so it is not erased.
