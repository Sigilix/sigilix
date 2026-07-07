// Barrel for the GitLab IO adapter — the GitLab counterpart of
// `shared/adapters/github`. Deliberately NARROW: re-exports the client + its
// error type. The webhook-token verifier is imported directly from its own
// module (`shared/adapters/gitlab/gitlab-webhook-verify`) so a test that
// partially mocks it doesn't break a re-export here (mirrors the GitHub barrel).

export { GitLabClient } from "./client"
export type { GitLabClientOptions } from "./client"
export { GitLabHttpError } from "./gitlab-errors"
