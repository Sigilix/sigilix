# ADR 0002 — Machine-enforced compliance ("the lock")

- **Status:** Accepted
- **Date:** 2026-06
- **Relates to:** [ADR 0001](./0001-clean-architecture.md) — turns its CI-enforcement clause into reality

## Context

ADR 0001 adopted clean architecture and stated the rules would be enforced by CI. Throughout the
SIG-318 migration that enforcement was, in fact, only documented:

- `eslint` carried the real rules — the two-tier `max-lines` size budget and the `../` cross-tree
  ban (`no-restricted-imports`) — but **CI never ran it.** The CI job (confusingly named `lint`)
  ran typecheck, tests, and the advisory-DB size check only. The size budget and import ban held
  by author discipline, not by a gate.
- `prettier --check` was not run in CI either.
- `dependency-cruiser` — the only tool that can enforce the inward dependency rule (§1) and
  barrel-only cross-feature imports (§2) — **did not exist in the repo.**

So the structural rules in `COMPLIANCE.md` could erode silently: a climbing import, an
over-budget file, or a `domain → adapters` edge would pass CI green. The migration is now complete
enough — the four `src/features/*` islands and the `src/shared/*` foundation are fully relocated —
that the rules covering them can be locked without blocking unfinished work.

## Decision

Machine-enforce the `COMPLIANCE.md` rules in CI, so a violation is a red build. Concretely:

1. **Run the existing gates in CI.** `ci.yml` now runs `npm run lint` (`eslint --max-warnings 0`),
   `npm run format:check` (`prettier --check .`), and `npm run depcruise` alongside typecheck and
   tests. `npm run build` chains the same gates locally, so a violation is caught before push.

2. **Add `dependency-cruiser`** (`.dependency-cruiser.cjs`) enforcing:
   - **the inward rule (§1)** — `domain`/`app`/`ports`/`adapters`/`render` layering. The rule is
     scoped by its *source* (only a migrated-unit layer is held to it) but its *target* is global,
     so a cross-unit escape (`features/a/app → shared/adapters`, `features/a/domain →
     features/b/app`) is caught, not just same-unit edges. `domain`, `app`, and `render` are
     fully strict (no reference to a concrete adapter or an outer layer, even a type — adapters
     are injected at the composition root and an app layer names them only by a **port** in
     `src/shared/ports/`); `ports` are type-only seams (every import out of a port must be
     `import type`).
   - **barrel-only cross-feature imports (§2)** — a feature is reached only through its `index.ts`,
     enforced for both external (non-feature) callers and other features.
   - **no new `feature → src/lib` god-file edges**, with an explicit allowlist for the two
     sanctioned façades (`sigilix-config.ts`, `triage-pr-review-ensemble.ts`).

3. **Scope the dependency rule to what is migrated.** The rule covers `src/features/*` and
   `src/shared` only. The still-flat `src/lib/*` migration zone — including the
   *partially*-migrated `src/lib/ensemble/*`, which carries the layer sub-dirs but whose `app`
   still wires concrete adapters/render directly — is **deliberately out of scope** until its
   relocation lands. Locking it now would be ~20 red edges of unfinished work, not a lock.
   Tests are exempt from the inward and barrel rules: a domain unit test legitimately imports the
   adapter/render it exercises, and forcing it through the barrel would either break the test or
   bloat the public surface.

4. **`.git-blame-ignore-revs`** records the two pure mechanical rewrites (the `@/` codemod and the
   Prettier format) so `git blame` attributes lines to the last logical change, not the sweep.

A single misplaced domain type surfaced by turning the lock on (`DepVulnFinding`, a finding shape
living in `app/` that `render/` imported) was relocated to `domain/` in the same change — the lock
finding its first real violation.

## Consequences

- The structure cannot silently erode: a climbing import, an over-budget file, a layer violation,
  an unformatted file, or a lint warning is now a failed build.
- The dependency rule's coverage will widen as the `src/lib/*` zone migrates — each unit added to
  clean-arch gets added to the `UNIT` scope in `.dependency-cruiser.cjs` in the PR that migrates
  it (the same discipline as the `max-lines` allowlist: the claim is visible in review).
- CI does slightly more work per run (three fast static gates ahead of the test step); they
  fail fast, before the long test run.
