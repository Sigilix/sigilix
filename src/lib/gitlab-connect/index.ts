// Barrel for the GitLab connector (sig-gitlab-connector) — the portal's one-click
// "Connect GitLab" flow: OAuth (api scope) → project picker → auto-provision the
// MR webhook + a stable review token. Deliberately NARROW: index.ts imports only
// the dispatcher + the CORS-path predicate; the webhook-verify extension imports
// the per-project secret resolver directly from the store.

export { tryHandleGitLabConnectRoute, isGitLabConnectCorsPath } from "./gitlab-connect-routes"
export { getProjectWebhookSecret } from "./gitlab-connect-store"
