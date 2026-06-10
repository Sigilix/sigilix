# COMPLIANCE.md — the structure standard

[`CONTRIBUTING.md`](./CONTRIBUTING.md) is how a change gets *made*. This is how the code is
*shaped*. [`ENGINEERING.md`](./ENGINEERING.md) explains the architecture and conventions in
depth — read that to understand the *why*; read this for the rules you must not break.

Same bar as everything else here: we sell AI code review, so we hold our own structure to it.

> **If you are an intern, worker, or AI model: read this file before you touch code, and tell
> your point of contact you have read it** (for an intern, that's your supervising engineer; for
> an AI model, the engineer running you). A change that breaks a rule below is wrong even if the
> tests pass — every rule here is machine-enforced, so a violation is a red build, not a style
> opinion. Don't argue with the gate; fix the structure.
>
> **The one rule to internalize before anything else: put new code in the layer it belongs to, and
> never reach outward.** Pure logic goes in `domain`; orchestration in `app` (through ports, not
> adapters); IO in `adapters`; output in `render`. An import may only point inward (§1). When you
> are unsure where something goes, that uncertainty is the signal to stop and read §1 and
> [`ENGINEERING.md`](./ENGINEERING.md) §3 — not to reach across a boundary to make it work.

---

## 0. What "compliant" means

A change is compliant when all of the following hold. They are listed once here and detailed
below; the CI gates check each one.

- Imports point **inward only** (the dependency rule).
- Cross-feature imports go through a **barrel**, never an internal path.
- Every cross-tree import uses **`@/`**, never `../`.
- Every file is within its **size budget** (1,000 lines; 1,500 for an allowlisted class-module).
- Tests are **co-located** next to their module, **dot-named**, with cross-cutting suites in `e2e/`.
- A restructuring PR is **zero-behavior** — pinned first, moved verbatim, proven unchanged.
- The code is **Prettier-formatted** and **typechecks** (tests included).

---

## 1. The dependency rule — imports point inward only

Layers, outermost to innermost:

```
render   →   adapters   →   ports   →   app   →   domain
(output)     (IO impls)    (seams)    (orchestration)  (pure)
```

- **`domain/`** is pure. No network, no env, no IO, no framework, no clock. Unit-testable in
  isolation with plain inputs. This is the believability core — the part we can prove correct.
- **`app/`** orchestrates domain logic. It may depend on `domain` and on **ports**, never on a
  concrete adapter. Keep it thin: it wires phases together, it does not contain policy.
- **`ports/`** are **type-only** interfaces — the seams. `ModelProviderPort` is the
  Ollama→OpenRouter swap point; `ReviewSinkPort`, `RetrievalPort`, `GraphPort`, `ClockPort` are
  the others. A port imports nothing but types.
- **`adapters/`** implement ports against the real world (GitHub, KV, Vectorize, the model
  provider). An adapter may import `domain` types and its port; it must not import `app`.
- **`render/`** turns a finished result into output (markdown, comments). It imports `domain`
  types only.

**An import may only point inward.** Concretely, these are violations and fail CI:

- `domain/foo.ts` importing anything from `app/`, `adapters/`, or `render/`.
- `app/bar.ts` importing a concrete adapter instead of a port.
- `ports/baz.ts` importing a value (a port is types only).

`shared/` holds the cross-cutting foundations every feature builds on: `shared/types` (pure
types — `Env`, `JobMessage`, GitHub DTOs), `shared/domain` (pure logic — config parsing,
finding categories, policy), `shared/util` (pure helpers), `shared/ports`, `shared/adapters`
(the GitHub client, the model adapters). The inward rule applies inside `shared/` too.

When a feature needs a foundational type or helper that still lives in a not-yet-relocated
file, **extract it to `shared/` first** (and re-export from its old home so nothing breaks),
then import from `shared/`. Never create a `features/* → lib/god-file` edge to get at a type.

## 2. Cross-feature imports go through the barrel

A feature is imported only through its barrel `index.ts`. That file **is** the feature's public
surface — the set of symbols other code is allowed to depend on. Reaching past it into an
internal layer path (`@/src/features/foo/domain/internal-thing`) from outside the feature is a
violation.

The one exception: a feature's **own** unit tests may import its internal layer paths directly
(they are inside the boundary). Production code in another feature may not.

Keep barrels **narrow**. Re-export the public surface, not every internal helper. Example: the
GitHub adapter barrel exposes `GitHubClient` and `GitHubHttpError` — not the wire-shape DTOs or
the encoding helpers, which are internal.

## 3. Imports use `@/`, never `../` across trees

`@/*` resolves to the **repo root** (configured once in `tsconfig`, honored by vitest and the
wrangler build). The alias is root-anchored, so one `@/` reaches the whole tree and the path shows
the exact file: `@/src/...` for code, `@/scripts/...` for tooling, `@/e2e/...` for cross-cutting
tests. Author **every** cross-directory import as `@/...`:

```ts
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { GitHubClient } from "@/src/shared/adapters/github"
```

A `./sibling` import inside the same directory is fine. A `../` that climbs out of the current
directory is **banned** (`no-restricted-imports`) — it hides the real dependency and breaks when
files move. If you typed `../`, you wanted `@/`.

## 4. File size — a readability budget, in two tiers

The budget exists for one reason: **a file you open should stay comfortably readable and
navigable.** The line count is the proxy; readability is the goal. Don't lawyer the number —
when a file gets hard to navigate, split it (§6), don't shave a comment to sneak under.

- **≤ 1,000 lines** — the default for **every** file, source and test alike.
- **≤ 1,500 lines** — only for a **single-cohesive-module** file: one class is one module, and
  splitting it would hurt readability *more* than its size does (the GitHub `client.ts` is the
  canonical case — one cohesive HTTP client, ~75 methods, no natural seam that doesn't fragment
  it). These files are named on an **explicit allowlist** in the lint config.
- **1,500 is the hard ceiling.** Nothing — allowlisted or not — passes above it.

**Getting on the allowlist:** you add the file to the allowlist entry **in the same PR** that
needs it. That makes the claim visible in the diff, so a reviewer (human or bot) judges whether
it genuinely meets the one-class-one-module bar. Being large, or merely containing a class, does
**not** qualify a file automatically — most large files have a seam and should be split.

## 5. Tests live beside the code

- **Co-located, side by side**: `foo.ts` and `foo.test.ts` in the same directory. No
  `__tests__/` subdirectories, no mirrored `test/` tree. A module and its test are neighbors.
- **Dot-style aspect naming** when one module needs several test files:
  `foo.test.ts`, `foo.security.test.ts`, `foo.rendering.test.ts`. Everything after the first dot
  is an *aspect* of `foo` — unambiguous, and it sorts directly under the module.
- **`e2e/`** holds only the genuinely cross-cutting suites: full webhook flows, golden-output
  parity, live multi-module integration, the model-eval rulers. A unit test belongs next to its
  module, not here.
- **Shared fixtures** go in a non-test `foo.test-helpers.ts` (note: *not* `*.test.ts`, so the
  runner doesn't collect it as a suite) imported by the sibling test files. Keep helpers pure
  (factory functions returning fresh objects) so a shared module can't leak state across files.

## 6. Restructuring is zero-behavior by default — pin first, move verbatim

When you split or relocate code without intending to change what it does:

1. **Pin first.** If the behavior isn't already covered, add the test or golden that pins it
   **before** you move anything. For the believability core, that is the golden matrix — it pins
   the output object byte-for-byte **and** the ordered sequence of telemetry callbacks.
2. **Move verbatim.** A relocated declaration is byte-identical to its original modulo the added
   `export` keyword and the changed import lines. Comments move with their declaration. The
   original file **re-exports** every previously-public symbol, so no importer changes.
3. **No new cycles.** A leaf module never *value*-imports its core. An `import type` across the
   seam is fine — it is erased under `verbatimModuleSyntax`, so there is no runtime cycle.
4. **Prove it.** The suite count is unchanged; golden fixtures are byte-untouched; the diff is
   deletions plus an import block — nothing edited inside a body that survived the move.

A genuine behavior change **never rides a refactor PR.** If you must change pinned behavior, that
is its own PR, with the golden regenerated deliberately and reviewed as a behavior change.

This protocol is how the entire clean-architecture decomposition shipped without a single
behavior regression. It is not optional ceremony — it is the reason the refactors were safe.

## 7. Formatting is Prettier, not opinion

The repo is Prettier-formatted; `prettier --check` is part of CI. Don't hand-format and don't
fight it. The one-shot format commit is listed in `.git-blame-ignore-revs`, so `git blame`
skips it.

---

## How this is enforced

Every rule above is machine-checked. A violation is a red build, not a review comment:

| Rule | Gate |
|------|------|
| Inward-only dependencies, barrel-only cross-feature imports | `dependency-cruiser` |
| `../` cross-tree ban | `eslint` `no-restricted-imports` |
| Size budget (two-tier, with the 1.5k allowlist) | `eslint` `max-lines` |
| No lint warnings accumulate | `eslint --max-warnings 0` |
| Formatting | `prettier --check` |
| Types — over **all** files, tests included | `tsc --noEmit` |

`npm run build` runs the same gates locally, so you find a violation on your machine before CI
does. Never push a red build.

The architecture rationale and the layer decision are recorded in the ADR (`docs/adr/`). Read it
once if you are making a structural change; read [`ENGINEERING.md`](./ENGINEERING.md) to learn
how the system fits together.
