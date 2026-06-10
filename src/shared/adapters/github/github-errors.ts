// SIG-318 / SIG-387: the GitHub HTTP error type, extracted from client.ts so
// the 30+ importers that only need `instanceof GitHubHttpError` (and the barrel
// re-export) don't depend on the full client module. The barrel re-exports this
// from here; external import surface (`@/shared/adapters/github`) is unchanged.

export class GitHubHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "GitHubHttpError"
    this.status = status
  }
}
