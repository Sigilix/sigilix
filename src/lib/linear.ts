// Linear GraphQL client — only the operations the triage path needs.
// Replaces the GitHub Issues API + Project board GraphQL surface from
// the Node daemon. The cross-repo project-write vulnerability class
// disappears here because Linear's API token is workspace-scoped, and
// every call is an explicit issue or comment update rather than a
// project-level field write.

import { getAppActorToken } from "./linear-oauth"
import {
  getValidAgentTokenViaBroker,
  forceRefreshViaBroker,
  type LinearTokenBrokerEnv,
} from "@/src/lib/linear-token-broker-client"

const LINEAR_GRAPHQL = "https://api.linear.app/graphql"

/**
 * Linear AgentActivity content kind (Agents API). Posted into an AgentSession to
 * drive the agent's visible turn:
 *   - "thought"      — internal reasoning surfaced as an italic note (the ACK).
 *   - "action"       — a tool/step the agent took.
 *   - "response"     — the agent's final answer; completes the session turn.
 *   - "elicitation"  — a question back to the user.
 *   - "error"        — a surfaced failure.
 */
export type AgentActivityType = "thought" | "action" | "response" | "elicitation" | "error"

/**
 * SIG-144 slice 4: resolve the Linear-unification cutover mode for
 * `buildLinearAuth` / `buildLinearClient`. Case-sensitive and fail-closed,
 * mirrors `resolveLinearAgentRunMode` (src/lib/agent-runner/mode.ts) — only
 * the exact string "on" routes auth through the broker agent token; unset,
 * "ON", whitespace variants, or any unknown value default to "off", which
 * keeps `buildLinearAuth` byte-identical to its pre-slice-4 behavior.
 */
export type LinearUnifiedMode = "off" | "on"

export function resolveLinearUnifiedMode(env: Pick<LinearAuthEnv, "OPENCLAW_LINEAR_UNIFIED">): LinearUnifiedMode {
  return env.OPENCLAW_LINEAR_UNIFIED === "on" ? "on" : "off"
}

/**
 * Build the Linear auth credential.
 *
 * Default (OPENCLAW_LINEAR_UNIFIED off/unset — see `resolveLinearUnifiedMode`):
 * prefers OAuth `client_credentials` (so comments post under the Sigilix bot
 * identity, not a human owner) and falls back to a personal API key when
 * OAuth isn't configured. Byte-identical to the pre-SIG-144-slice-4 behavior.
 *
 * SIG-144 slice 4 (OPENCLAW_LINEAR_UNIFIED "on"): returns the AGENT token via
 * `getValidAgentTokenViaBroker` (`readOnly: false` — this is the active
 * triage/mutation path, not the 10s-ACK hot path that `buildLinearAgentClient`
 * serves, so the broker is allowed to refresh a near-expiry token here)
 * instead of the client_credentials / human-key choice above. When the
 * broker returns no token — not installed, or a hard refresh failure — this
 * THROWS a loud, neutral error rather than falling through to the
 * `LINEAR_API_KEY` human fallback below: post-cutover, silently mutating
 * Linear under a human identity would hide a broken agent install. The
 * thrown message never carries token material.
 *
 * Extracted from `triage.ts` + `mention-reply.ts` when SIG-225's
 * webhook-side thread-walk became the 3rd call site that needed it.
 * Single source of truth — if the auth pick logic changes, it changes
 * once. `LinearAuthEnv` is the minimum env slice this helper needs so
 * the call site doesn't need to pass the full `Env`.
 */
export interface LinearAuthEnv {
  LINEAR_OAUTH_CLIENT_ID?: string
  LINEAR_OAUTH_CLIENT_SECRET?: string
  LINEAR_API_KEY: string
  /** Only required when OAuth client_credentials are configured —
   *  `getAppActorToken` uses it to cache the actor token. The
   *  API-key fallback path never touches it. Optional here so a
   *  caller that knows it's API-key-only can pass a minimal env. */
  OPENCLAW_STATE?: KVNamespace
  /** SIG-144 slice 4 — see `resolveLinearUnifiedMode`. Default/unset → "off",
   *  the unchanged client_credentials/human-key path. */
  OPENCLAW_LINEAR_UNIFIED?: string
  /** Only read when OPENCLAW_LINEAR_UNIFIED is "on" — `buildLinearAuth` reads
   *  the agent token from this DO via `getValidAgentTokenViaBroker`. The
   *  flag-off path never touches it; optional here so an API-key-only caller
   *  can keep passing a minimal env (mirrors the OPENCLAW_STATE convention
   *  above). A missing binding while unified is "on" is treated exactly like
   *  a broker miss — `buildLinearAuth` throws rather than guessing. */
  LINEAR_TOKEN_BROKER?: DurableObjectNamespace
}

export async function buildLinearAuth(env: LinearAuthEnv): Promise<LinearAuth> {
  if (resolveLinearUnifiedMode(env) === "on") {
    const token = env.LINEAR_TOKEN_BROKER
      ? await getValidAgentTokenViaBroker({ LINEAR_TOKEN_BROKER: env.LINEAR_TOKEN_BROKER }, { readOnly: false })
      : null
    if (!token) {
      throw new Error(
        "buildLinearAuth: OPENCLAW_LINEAR_UNIFIED is on but no agent token is available " +
          "(broker not installed, a hard refresh failure, or LINEAR_TOKEN_BROKER unbound) — " +
          "refusing to fall back to the human LINEAR_API_KEY",
      )
    }
    return { oauthToken: token }
  }
  if (env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET) {
    if (!env.OPENCLAW_STATE) {
      throw new Error("buildLinearAuth: OAuth client_credentials configured but OPENCLAW_STATE KV binding is missing")
    }
    const token = await getAppActorToken(env.OPENCLAW_STATE, env.LINEAR_OAUTH_CLIENT_ID, env.LINEAR_OAUTH_CLIENT_SECRET)
    return { oauthToken: token }
  }
  return { apiKey: env.LINEAR_API_KEY }
}

/**
 * Build a fully-constructed `LinearClient` from `buildLinearAuth`'s credential
 * choice — the single helper every `buildLinearAuth` call site should use
 * (SIG-144 slice 4). Exists so the ~7 callers don't each have to know whether
 * the unified-mode 401-retry hook applies; this is the one place that decides.
 *
 * Default (unified off): identical to the pre-slice-4 call-site pattern,
 * `new LinearClient(await buildLinearAuth(env))` — no `onUnauthorized` hook,
 * zero behavior change.
 *
 * Unified on: the credential IS the broker agent token (or `buildLinearAuth`
 * already threw — see above), so the returned client also carries
 * `onUnauthorized: () => forceRefreshViaBroker(env)`, mirroring
 * `buildLinearAgentClient`'s slice-3 wiring — a 401 on this path refreshes
 * through the broker and retries once instead of failing the whole call.
 * `forceRefreshViaBroker` is captured in the closure here, same clean-arch
 * seam as `buildLinearAgentClient`: the generic `LinearClient` never imports
 * the broker.
 */
export async function buildLinearClient(env: LinearAuthEnv): Promise<LinearClient> {
  const auth = await buildLinearAuth(env)
  if (resolveLinearUnifiedMode(env) === "on" && env.LINEAR_TOKEN_BROKER) {
    const brokerEnv = { LINEAR_TOKEN_BROKER: env.LINEAR_TOKEN_BROKER }
    return new LinearClient(auth, { onUnauthorized: () => forceRefreshViaBroker(brokerEnv) })
  }
  return new LinearClient(auth)
}

/**
 * Build a LinearClient authenticated with the stored AGENT token (the actor=app
 * install token from the OAuth callback), or null when no agent token is installed.
 *
 * Use this — NOT `buildLinearAuth` — for agent-activity posts: the agent capability
 * lives on the authorization-code token, not the client_credentials token. Callers
 * treat null as "agent not installed → skip the activity post" (fail-safe).
 *
 * SIG-144 slice 2: reads the token via `getValidAgentTokenViaBroker` (the
 * LinearTokenBroker DO), NOT the KV-backed `getValidAgentToken` this used before.
 * `readOnly: true` is deliberate — this is the hot ACK / agent-activity path, so
 * it must NEVER trigger a refresh itself; the broker's own alarm keeps the token
 * fresh. A null return (not installed, or the broker reports a hard refresh
 * failure) keeps the existing fail-safe: skip the post, never throw, never fall
 * back to a human key.
 *
 * SIG-144 slice 3: wires the `onUnauthorized` refresh+retry hook — the ONLY
 * client variant that gets it. `forceRefreshViaBroker(env)` is captured in the
 * closure here, so the generic `LinearClient.gql()` never imports the broker;
 * the broker dependency flows in through this one call site (clean-arch — see
 * `LinearClientOptions` on `linear.ts`). A token still served from the readOnly
 * cache can be stale relative to Linear (e.g. the broker's proactive-refresh
 * alarm hasn't fired yet); the hook is what recovers from that without the
 * caller (the agent-run completion post) having to know anything about the broker.
 *
 * SIG-145: `opts.allowRefresh` (default true) gates that 401-refresh hook. The
 * webhook ACK path (`ackAgentSession`) passes `allowRefresh: false` so a stale-token
 * 401 can NOT trigger a blocking broker `forceRefresh` — that refresh is a DO RPC
 * NOT bounded by the ACK's `AbortSignal.timeout(2000)`, so on the ACK hot path it
 * could overrun Linear's ~10s ack window and cause a redelivery → duplicate run. The
 * ACK is best-effort anyway: a 401 there just skips (the background run still posts
 * the real completion later). The background run leaves `allowRefresh` default-on so
 * its terminal post self-heals a stale token via the refresh+retry. Either way the
 * token READ stays `readOnly: true` (one DO read, never a refresh POST), and a null
 * return keeps the fail-safe: skip the post, never throw, never use a human key.
 */
export async function buildLinearAgentClient(
  env: LinearTokenBrokerEnv,
  opts?: { allowRefresh?: boolean },
): Promise<LinearClient | null> {
  const token = await getValidAgentTokenViaBroker(env, { readOnly: true })
  if (!token) return null
  if (opts?.allowRefresh === false) {
    return new LinearClient({ oauthToken: token })
  }
  return new LinearClient({ oauthToken: token }, { onUnauthorized: () => forceRefreshViaBroker(env) })
}

export interface LinearIssue {
  id: string
  identifier: string // e.g. "ARC-42"
  title: string
  description: string | null
  url: string
  team: { id: string; key: string }
  creator: { name: string | null; displayName: string | null } | null
  labels: { nodes: Array<{ name: string }> }
  comments: { nodes: Array<{ id: string; body: string }> }
}

export interface LinearCommentWithIssue {
  id: string
  body: string
  user: { name: string | null; displayName: string | null } | null
  /** SIG-225 follow-up: parent comment id when this comment is a
   *  thread reply, null on top-level comments. Threaded by Linear
   *  via `parent: Comment` (we project to id-only here since the
   *  caller never needs the parent body/user — only its existence
   *  + id for the createComment(... parentId) pass-through). */
  parent: { id: string } | null
  issue: {
    id: string
    identifier: string
    title: string
    description: string | null
    team: { id: string; key: string }
    comments: {
      nodes: Array<{
        id: string
        body: string
        createdAt: string
        user: { name: string | null; displayName: string | null } | null
      }>
    }
  }
}

interface IssueLabel {
  id: string
  name: string
}

export type LinearAuth = { apiKey: string } | { oauthToken: string }

/**
 * SIG-144 slice 3: optional behavior hooks for `LinearClient`. `onUnauthorized`
 * is the broker-agent-token 401-retry hook — set ONLY by `buildLinearAgentClient`.
 * The `client_credentials` / human-`LINEAR_API_KEY` path (`buildLinearAuth`)
 * never sets it, so that path's existing re-mint behavior is unchanged.
 *
 * Keeping this as a plain callback (rather than importing the broker client
 * here) is the clean-arch seam: `linear.ts` stays ignorant of the broker DO —
 * the broker dependency flows in from the call site that builds the hook.
 */
export interface LinearClientOptions {
  /**
   * Called when a GraphQL request comes back 401. Must return a fresh access
   * token to retry the SAME request once with a rebuilt Authorization header,
   * or `null` if no fresh token could be obtained — in which case the 401 is
   * surfaced as a loud, structured failure (no token material logged) and the
   * call is NOT retried again.
   */
  onUnauthorized?: () => Promise<string | null>
}

export class LinearClient {
  private authHeader: string
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined

  constructor(auth: LinearAuth, options?: LinearClientOptions) {
    // Personal API keys go through as the raw header value (Linear's docs).
    // OAuth access tokens use the standard Bearer prefix. Mixing them up
    // produces a 401 on every call, which is the expected mode failure.
    this.authHeader = "oauthToken" in auth ? `Bearer ${auth.oauthToken}` : auth.apiKey
    this.onUnauthorized = options?.onUnauthorized
  }

  /**
   * Fetch a single comment along with its parent issue and the surrounding
   * thread. Used by the mention-reply path to build context for the model.
   * The thread is bounded — Linear can return tens of thousands of comments
   * on busy issues, but we only need the most recent for a coherent reply.
   */
  async getCommentWithIssue(commentId: string): Promise<LinearCommentWithIssue | null> {
    const query = /* GraphQL */ `
      query CommentWithIssue($id: String!) {
        comment(id: $id) {
          id
          body
          user {
            name
            displayName
          }
          parent {
            id
          }
          issue {
            id
            identifier
            title
            description
            team {
              id
              key
            }
            comments(first: 50) {
              nodes {
                id
                body
                createdAt
                user {
                  name
                  displayName
                }
              }
            }
          }
        }
      }
    `
    const data = await this.gql<{ comment: LinearCommentWithIssue | null }>(query, {
      id: commentId,
    })
    return data.comment
  }

  /**
   * SIG-225 — fetch JUST the parent + author for an issue's recent
   * comments. Used by the webhook's in-thread-reply trigger path to
   * walk the parent chain without paying the full `getIssue` cost
   * (no labels, no creator, no body, no description). The result
   * feeds `commentHasSigilixAncestor` from `linear-thread-ancestor.ts`.
   *
   * `orderBy: updatedAt` is CRITICAL — Linear's default connection
   * ordering returns OLDEST 100 first, which silently omits every
   * recent Sigilix reply on any thread past 100 comments and breaks
   * the trigger entirely. Code-reviewer P1 catch on PR #196.
   *
   * When the parent chain runs past 100 comments OR a freshly-posted
   * comment hasn't propagated to the read replica yet (replica-lag
   * race), the helper falls closed (returns false). The webhook
   * caller has a second-pass `getComment(parentId)` direct-lookup
   * backstop that bypasses both failure modes.
   */
  async getCommentParents(
    issueId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<
    Array<{
      id: string
      parentId: string | null
      user: { name: string | null; displayName: string | null } | null
    }>
  > {
    const query = /* GraphQL */ `
      query CommentParents($id: String!) {
        issue(id: $id) {
          comments(first: 100, orderBy: updatedAt) {
            nodes {
              id
              parent {
                id
              }
              user {
                name
                displayName
              }
            }
          }
        }
      }
    `
    const data = await this.gql<{
      issue: {
        comments: {
          nodes: Array<{
            id: string
            parent: { id: string } | null
            user: { name: string | null; displayName: string | null } | null
          }>
        }
      } | null
    }>(query, { id: issueId }, opts?.signal)
    const nodes = data.issue?.comments.nodes ?? []
    return nodes.map((n) => ({
      id: n.id,
      parentId: n.parent?.id ?? null,
      user: n.user,
    }))
  }

  /**
   * SIG-225 P1 fix — direct single-comment lookup. The backstop for
   * the `getCommentParents` snapshot walk: if the parent chain runs
   * past the 100-comment page OR Linear's read replica hasn't surfaced
   * a freshly-posted comment yet, the webhook caller hits this to
   * resolve the IMMEDIATE parent's author. One narrow GraphQL call —
   * no body, no surrounding thread.
   */
  async getCommentAuthor(
    commentId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    id: string
    parentId: string | null
    user: { name: string | null; displayName: string | null } | null
  } | null> {
    const query = /* GraphQL */ `
      query CommentAuthor($id: String!) {
        comment(id: $id) {
          id
          parent {
            id
          }
          user {
            name
            displayName
          }
        }
      }
    `
    const data = await this.gql<{
      comment: {
        id: string
        parent: { id: string } | null
        user: { name: string | null; displayName: string | null } | null
      } | null
    }>(query, { id: commentId }, opts?.signal)
    const c = data.comment
    if (!c) return null
    return { id: c.id, parentId: c.parent?.id ?? null, user: c.user }
  }

  /** Fetch issue + recent comments. Used for triage dedupe + context. */
  async getIssue(issueId: string): Promise<LinearIssue | null> {
    const query = /* GraphQL */ `
      query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          team {
            id
            key
          }
          creator {
            name
            displayName
          }
          labels {
            nodes {
              name
            }
          }
          comments(first: 50) {
            nodes {
              id
              body
            }
          }
        }
      }
    `
    const data = await this.gql<{ issue: LinearIssue | null }>(query, { id: issueId })
    return data.issue
  }

  /**
   * Resolve label NAMES to IDs for the given team. Auto-creates any name
   * the team doesn't have yet — matches the original GitHub openclaw which
   * relies on `POST /labels` to create-on-add. Without auto-create, the
   * model's suggestions would silently disappear when a label is new to
   * a workspace, which is exactly what shipped originally and broke the
   * ARC test issue.
   */
  async resolveLabels(teamId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return []
    const query = /* GraphQL */ `
      query Labels($teamId: String!) {
        team(id: $teamId) {
          labels(first: 250) {
            nodes {
              id
              name
            }
          }
        }
      }
    `
    const data = await this.gql<{
      team: { labels: { nodes: IssueLabel[] } } | null
    }>(query, { teamId })
    const existing = data.team?.labels.nodes ?? []
    const byNameLower = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]))

    const ids: string[] = []
    for (const rawName of names) {
      const name = rawName.trim()
      if (!name) continue
      const found = byNameLower.get(name.toLowerCase())
      if (found) {
        ids.push(found)
        continue
      }
      try {
        const created = await this.createLabel(teamId, name)
        ids.push(created)
        byNameLower.set(name.toLowerCase(), created)
      } catch (error) {
        console.warn("label create failed (skipping)", {
          teamId,
          name,
          error: String(error),
        })
      }
    }
    return ids
  }

  /**
   * Create a new Linear issue and return its id, identifier, and URL.
   * Used by the Slack agent thread→issue flow (SIG-196).
   * `description` is optional — omitted from the mutation input when not provided.
   * `assigneeId` is optional (SIG-545 B3b) — when provided (e.g. the Sigilix agent
   * user, so the Slack "implement this" flow self-assigns), it's included in the
   * mutation input; omitted when undefined.
   */
  async createIssue(input: {
    teamId: string
    title: string
    description?: string
    assigneeId?: string
  }): Promise<{ id: string; identifier: string; url: string }> {
    const mutation = /* GraphQL */ `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `
    const vars: { teamId: string; title: string; description?: string; assigneeId?: string } = {
      teamId: input.teamId,
      title: input.title,
    }
    if (typeof input.description === "string") vars.description = input.description
    if (typeof input.assigneeId === "string") vars.assigneeId = input.assigneeId

    const data = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null }
    }>(mutation, { input: vars })

    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error(`issueCreate returned success=false for "${input.title}"`)
    }
    const { id, identifier, url } = data.issueCreate.issue
    return { id, identifier, url }
  }

  /** Create a new issue label scoped to a team. Returns the new label ID. */
  private async createLabel(teamId: string, name: string): Promise<string> {
    const mutation = /* GraphQL */ `
      mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
          }
        }
      }
    `
    const data = await this.gql<{
      issueLabelCreate: { success: boolean; issueLabel: { id: string } }
    }>(mutation, { input: { teamId, name } })
    if (!data.issueLabelCreate.success) {
      throw new Error(`issueLabelCreate returned success=false for "${name}"`)
    }
    return data.issueLabelCreate.issueLabel.id
  }

  /**
   * Update issue priority, estimate, labels, and/or description. All fields
   * optional. Description writes overwrite the issue body in place — the
   * caller (triage) is responsible for preserving any media URLs from the
   * original before passing the new description here.
   */
  async updateIssue(
    issueId: string,
    fields: {
      priority?: number
      estimate?: number
      labelIds?: string[]
      description?: string
    },
  ): Promise<void> {
    const mutation = /* GraphQL */ `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
    `
    const input: Record<string, unknown> = {}
    if (typeof fields.priority === "number") input.priority = fields.priority
    if (typeof fields.estimate === "number") input.estimate = fields.estimate
    if (Array.isArray(fields.labelIds) && fields.labelIds.length > 0) {
      input.labelIds = fields.labelIds
    }
    if (typeof fields.description === "string" && fields.description.trim().length > 0) {
      input.description = fields.description
    }
    if (Object.keys(input).length === 0) return
    await this.gql(mutation, { id: issueId, input })
  }

  /** Create a new comment on an issue. Returns the comment ID.
   *
   *  SIG-225 follow-up: optional `parentId` makes the new comment a
   *  REPLY inside an existing thread instead of a top-level post. Used
   *  by `handleMention` when responding to a thread-followup trigger —
   *  the bot's reply should land in the same thread as the founder's
   *  reply, not at issue-root. Top-level callers (triage, manual
   *  trigger) keep the legacy two-arg call. */
  async createComment(issueId: string, body: string, parentId?: string): Promise<string> {
    const mutation = /* GraphQL */ `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
          }
        }
      }
    `
    const input: { issueId: string; body: string; parentId?: string } = { issueId, body }
    if (parentId) input.parentId = parentId
    const data = await this.gql<{ commentCreate: { comment: { id: string } } }>(mutation, {
      input,
    })
    return data.commentCreate.comment.id
  }

  /** Update an existing comment's body in place. */
  async updateComment(commentId: string, body: string): Promise<void> {
    const mutation = /* GraphQL */ `
      mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) {
          success
        }
      }
    `
    await this.gql(mutation, { id: commentId, input: { body } })
  }

  /**
   * Post an agent activity into an AgentSession (Linear Agents API). This is how a
   * real Linear AGENT drives its turn — the ACK (`thought`), progress (`action`),
   * the final answer (`response`), a question (`elicitation`), or a failure
   * (`error`). Posting `response`/`error` completes the session turn; the others
   * keep it active.
   *
   * The client MUST be constructed with the AGENT access token (the actor=app
   * authorization-code token the OAuth callback stored) — the client_credentials
   * app-actor token does NOT carry the agent capability. Use `buildLinearAgentClient`
   * to construct a correctly-authed client.
   *
   * `content` maps to Linear's `AgentActivityContentInput`: body-bearing kinds
   * (thought/response/elicitation/error) send `content.body`; an `action` sends
   * `content.action`.
   *
   * `opts.signal` bounds the underlying GraphQL call — the webhook ACK passes an
   * `AbortSignal.timeout(...)` so an un-timed call can't overrun Linear's webhook
   * ack window (which would trigger a redelivery → duplicate runs). SIG-225 pattern.
   */
  async createAgentActivity(
    sessionId: string,
    content: string,
    type: AgentActivityType,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const mutation = /* GraphQL */ `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `
    const activityContent: Record<string, unknown> =
      type === "action" ? { type, action: content } : { type, body: content }
    const data = await this.gql<{ agentActivityCreate: { success: boolean } }>(
      mutation,
      { input: { agentSessionId: sessionId, content: activityContent } },
      opts?.signal,
    )
    if (!data.agentActivityCreate.success) {
      throw new Error(`agentActivityCreate returned success=false (type=${type})`)
    }
  }

  /**
   * SIG-144 slice 3: `isRetry` bounds the 401-refresh-retry to exactly ONE
   * attempt — it is only ever set `true` by this method's own recursive call
   * below, never by an external caller, so there is no path to a second retry
   * or a loop. Every other call site keeps the implicit `isRetry = false`.
   */
  private async gql<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
    isRetry = false,
  ): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.authHeader,
      },
      body: JSON.stringify({ query, variables }),
    }
    // Only set `signal` when explicitly provided. `exactOptionalPropertyTypes`
    // rejects `signal: undefined` literals; gating the assignment keeps the
    // existing zero-signal call sites unchanged.
    if (signal) init.signal = signal
    const res = await fetch(LINEAR_GRAPHQL, init)

    // SIG-144 slice 3: scoped 401-retry for the broker-backed agent client ONLY.
    // `this.onUnauthorized` is set exclusively by `buildLinearAgentClient` — the
    // client_credentials / human-`LINEAR_API_KEY` path (`buildLinearAuth`) never
    // sets it, so that path falls straight through to the unchanged `!res.ok`
    // throw below, exactly as before this slice. `!isRetry` is what caps this at
    // one attempt: the recursive call passes `isRetry = true`, so a second 401
    // (or any later 401 from a later call) never re-enters this branch.
    if (res.status === 401 && this.onUnauthorized && !isRetry) {
      const freshToken = await this.onUnauthorized()
      if (freshToken) {
        this.authHeader = `Bearer ${freshToken}`
        return this.gql<T>(query, variables, signal, true)
      }
      // The broker could not mint a fresh token (forceRefresh failed). Fail
      // loudly with a neutral breadcrumb — NEVER the token/header — and fall
      // through to the generic 401 throw below; no further retry is attempted.
      console.error(JSON.stringify({ event: "linear-gql-401-refresh-failed" }))
    }

    if (!res.ok) {
      const text = await res.text()
      if (res.status === 401 && isRetry) {
        // The retried request — with the freshly-refreshed token — STILL came
        // back 401. Loud neutral breadcrumb (no token material); the caller's
        // thrown error is the only further signal, never a second retry.
        console.error(JSON.stringify({ event: "linear-gql-401-retry-failed" }))
      }
      throw new Error(`Linear HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`)
    }
    if (!json.data) {
      throw new Error("Linear GraphQL returned no data")
    }
    return json.data
  }
}

// Severity → Linear priority enum.
//   0 None, 1 Urgent, 2 High, 3 Medium, 4 Low
export function severityToPriority(severity: string): number {
  switch (severity.toUpperCase()) {
    case "P0":
      return 1
    case "P1":
      return 2
    case "P2":
      return 3
    case "P3":
      return 4
    default:
      return 0
  }
}

// Estimate label → Fibonacci point value. Mirrors the previous OpenClaw map.
//   trivial 1, S 2, M 3, L 5, XL 8 — never auto-assigns 13 (operator picks epics).
export function estimateToPoints(estimate: string): number | undefined {
  switch (estimate) {
    case "trivial":
      return 1
    case "S":
      return 2
    case "M":
      return 3
    case "L":
      return 5
    case "XL":
      return 8
    default:
      return undefined
  }
}
