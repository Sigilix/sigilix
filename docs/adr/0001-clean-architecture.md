# ADR 0001 — Clean architecture for the Sigilix Worker

- **Status:** Accepted
- **Date:** 2026-06
- **Supersedes:** the pre-refactor god-file layout

## Context

The PR-review pipeline had grown into a small number of very large files. A single
`triage-pr-review-ensemble.ts` reached ~11,000 lines with one ~5,700-line function, and a
139-file strongly-connected import cycle tangled pure policy (validation gates, consensus,
quorum, budget) with IO (model calls, GitHub, KV/Durable Objects, the graph RPC). There were
effectively no module boundaries: the believability core — the part of the product we most need
to reason about and prove correct — could not be tested or changed in isolation.

This made every change risky, slowed review, and blocked the infrastructure swaps we want (e.g.
moving the model provider from Ollama to OpenRouter) because the seam did not exist.

## Decision

Adopt clean architecture across the repository, enforced by CI.

1. **The dependency rule — imports point inward only.**
   `render → adapters → ports → app → domain`. `domain` is pure (no IO, env, clock, or
   framework). `app` orchestrates domain logic through **ports** (type-only interface seams),
   never through a concrete adapter. `adapters` implement the ports. `render` produces output.
   `shared/` holds the cross-cutting foundations (types, pure domain, util, ports, adapters)
   under the same rule.

2. **Barrel-only cross-feature imports.** A feature is consumed through its `index.ts` barrel —
   that file is its public surface. Internal layer paths are private to the feature.

3. **`@/` imports, never `../` across trees.** `@/*` → repo root (root-anchored: `@/src/...`,
   `@/scripts/...`), honored by tsc, vitest, and the wrangler build.

4. **A two-tier file-size budget, for readability.** ≤1,000 lines for every file; ≤1,500 for an
   explicitly allowlisted single-cohesive-module file (one class = one module) where splitting
   would hurt readability more than the size does. 1,500 is the hard ceiling.

5. **Zero-behavior restructuring protocol.** Structural change pins behavior first (for the
   believability core, the golden matrix pins output byte-identity *and* ordered telemetry
   callbacks), moves declarations verbatim, re-exports from the original so importers don't
   change, introduces no value cycles, and proves the suite and golden fixtures unchanged.
   Behavior changes never ride a refactor PR.

The full, normative statement of these rules is [`COMPLIANCE.md`](../../COMPLIANCE.md); the
architecture and conventions are explained in [`ENGINEERING.md`](../../ENGINEERING.md).

## How it was carried out

The decomposition (epic SIG-318) ran as a long sequence of small, individually-verified PRs:
dissolve the import cycle into `shared/`, extract the ensemble into
`domain`/`app`/`ports`/`adapters`/`render`, decompose the remaining god-files and oversized test
files to the size budget, then lock the rules in with machine enforcement. Every PR held the test
suite at its exact baseline and carried independent review sign-off; the believability core was
pinned by a golden matrix before any of its code moved.

## Consequences

- The believability core (`ensemble/domain`) is now pure and unit-testable in isolation.
- The model provider is swappable behind `ModelProviderPort` — a single-adapter change.
- The rules are enforced by CI (`dependency-cruiser`, `eslint` `max-lines` + `no-restricted-imports`,
  `prettier --check`, `tsc` over all files), so a violation is a red build rather than a review
  comment, and the structure cannot silently erode.
- New code costs a little more up front (pick the right layer, import through barrels) and pays
  that back in reviewability and safe change.
