# `ensemble/` — PR-review clean-architecture layer (SIG-318)

The decomposed home of the PR-review ensemble. **Dependency rule: imports point
inward only.**

```
domain/    pure policy — NO env / network / storage; unit-testable
app/       thin orchestrator — calls ports, holds no IO detail
ports/     interfaces only (ModelProviderPort, ReviewSinkPort, GraphPort,
           RetrievalPort, PersistencePort, EnvReader)
adapters/  the ONLY IO — implement the port interfaces
render/    markdown emitters — consume domain types, make no decisions
```

- `domain/` imports nothing outward.
- `app/` depends on `domain` + `ports` only — never a concrete adapter.
- `adapters/` depend on `domain` (to implement ports) — never the reverse.
- `render/` depends on `domain` types only.

No file > ~1,500 lines. See the design spec for the phased extraction order.
Migration tracked in [SIG-318](https://linear.app/sigilix/issue/SIG-318).
