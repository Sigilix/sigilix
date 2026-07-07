// The GitLab HTTP error type — mirrors `GitHubHttpError` so the GitLab review
// client can carry a status code on failure (used for 404 -> null degrades and
// for surfacing a degraded write on the recall-safe review path). Kept in its
// own leaf so importers that only need `instanceof GitLabHttpError` don't drag
// in the full client module.

export class GitLabHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "GitLabHttpError"
    this.status = status
  }
}
