# Frozen head sources — fullstack-pr20-dense (commit 2a3bc30)

The PR-head source of the five changed files, used by `e2e/gate-survival.ts`
to feed the AST-dependent validation gates (window-blindness, logic-claim
refutation, AST rules) a faithful `filesByPath`. Stored with a `.txt` suffix
so the repo's inclusive tsconfig does not typecheck fixture code; the
harness strips the suffix to reconstruct the real in-repo path as the map key.
