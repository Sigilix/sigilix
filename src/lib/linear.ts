// Linear GraphQL client — only the operations the triage path needs.
// Replaces the GitHub Issues API + Project board GraphQL surface from
// the Node daemon. The cross-repo project-write vulnerability class
// disappears here because Linear's API token is workspace-scoped, and
// every call is an explicit issue or comment update rather than a
// project-level field write.

import type { Env } from "@/src/shared/types/env"
import { getAppActorToken } from "./linear-oauth"
import { getLinearAgentToken } from "./linear-agent-oauth"

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
 * Build the Linear auth credential. Prefers OAuth `client_credentials`
 * (so comments post under the Sigilix bot identity, not a human owner)
 * and falls back to a personal API key when OAuth isn't configured.
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
}

export async function buildLinearAuth(env: LinearAuthEnv): Promise<LinearAuth> {
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
 * Build a LinearClient authenticated with the stored AGENT token (the actor=app
 * install token from the OAuth callback), or null when no agent token is installed.
 *
 * Use this — NOT `buildLinearAuth` — for agent-activity posts: the agent capability
 * lives on the authorization-code token, not the client_credentials token. Callers
 * treat null as "agent not installed → skip the activity post" (fail-safe).
 */
export async function buildLinearAgentClient(env: Pick<Env, "OPENCLAW_STATE">): Promise<LinearClient | null> {
  const token = await getLinearAgentToken(env.OPENCLAW_STATE)
  if (!token) return null
  return new LinearClient({ oauthToken: token })
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

export class LinearClient {
  private readonly authHeader: string

  constructor(auth: LinearAuth) {
    // Personal API keys go through as the raw header value (Linear's docs).
    // OAuth access tokens use the standard Bearer prefix. Mixing them up
    // produces a 401 on every call, which is the expected mode failure.
    this.authHeader = "oauthToken" in auth ? `Bearer ${auth.oauthToken}` : auth.apiKey
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

  private async gql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
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
    if (!res.ok) {
      const text = await res.text()
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
