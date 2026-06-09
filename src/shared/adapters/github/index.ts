// SIG-380 / P1a: barrel for the GitHub IO adapter's HTTP client surface.
// Importers reach `GitHubClient` + `GitHubHttpError` via `shared/adapters/github`.
//
// Deliberately NARROW: this barrel re-exports ONLY the client. The App-auth +
// webhook-verify helpers are imported directly from their own modules
// (`shared/adapters/github/github-app`, `.../github-installation`,
// `.../github-webhook-verify`) so a test that partially mocks one of those
// modules doesn't break a re-export here (a barrel that re-exported them would
// eagerly pull each module's full surface, and a partial `vi.mock` of
// `github-app` would then drop the other auth exports).
//
// It also does NOT re-export the pure DTO types — those live in
// `src/shared/types/github.ts` (a leaf with no IO), preserving the split so a
// module that only needs a `PullRequestMeta` shape never pulls in `fetch`.

export { GitHubClient, GitHubHttpError } from "./client"
