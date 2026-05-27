// Linear GraphQL client — only the operations the triage path needs.
// Replaces the GitHub Issues API + Project board GraphQL surface from
// the Node daemon. The cross-repo project-write vulnerability class
// disappears here because Linear's API token is workspace-scoped, and
// every call is an explicit issue or comment update rather than a
// project-level field write.

import { getAppActorToken } from "./linear-oauth"

const LINEAR_GRAPHQL = "https://api.linear.app/graphql"

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
  OPENCLAW_STATE: KVNamespace
}

export async function buildLinearAuth(env: LinearAuthEnv): Promise<LinearAuth> {
  if (env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET) {
    const token = await getAppActorToken(
      env.OPENCLAW_STATE,
      env.LINEAR_OAUTH_CLIENT_ID,
      env.LINEAR_OAUTH_CLIENT_SECRET
    )
    return { oauthToken: token }
  }
  return { apiKey: env.LINEAR_API_KEY }
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
    this.authHeader =
      "oauthToken" in auth ? `Bearer ${auth.oauthToken}` : auth.apiKey
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
          user { name displayName }
          issue {
            id
            identifier
            title
            description
            team { id key }
            comments(first: 50) {
              nodes {
                id
                body
                createdAt
                user { name displayName }
              }
            }
          }
        }
      }
    `
    const data = await this.gql<{ comment: LinearCommentWithIssue | null }>(query, { id: commentId })
    return data.comment
  }

  /**
   * SIG-225 — fetch JUST the parent + author for an issue's recent
   * comments. Used by the webhook's in-thread-reply trigger path to
   * walk the parent chain without paying the full `getIssue` cost
   * (no labels, no creator, no body, no description). The result
   * feeds `commentHasSigilixAncestor` from `linear-thread-ancestor.ts`.
   *
   * `first: 100` is wider than `getIssue`'s 50 because a long-running
   * thread can stack replies past Linear's default page size; if the
   * parent chain runs past 100 comments the helper falls closed
   * (returns false → no implicit trigger) by design.
   */
  async getCommentParents(
    issueId: string
  ): Promise<Array<{ id: string; parentId: string | null; user: { name: string | null; displayName: string | null } | null }>> {
    const query = /* GraphQL */ `
      query CommentParents($id: String!) {
        issue(id: $id) {
          comments(first: 100) {
            nodes {
              id
              parent { id }
              user { name displayName }
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
    }>(query, { id: issueId })
    const nodes = data.issue?.comments.nodes ?? []
    return nodes.map((n) => ({
      id: n.id,
      parentId: n.parent?.id ?? null,
      user: n.user,
    }))
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
          team { id key }
          creator { name displayName }
          labels { nodes { name } }
          comments(first: 50) { nodes { id body } }
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
          labels(first: 250) { nodes { id name } }
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

  /** Create a new issue label scoped to a team. Returns the new label ID. */
  private async createLabel(teamId: string, name: string): Promise<string> {
    const mutation = /* GraphQL */ `
      mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id }
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
    }
  ): Promise<void> {
    const mutation = /* GraphQL */ `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
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

  /** Create a new comment on an issue. Returns the comment ID. */
  async createComment(issueId: string, body: string): Promise<string> {
    const mutation = /* GraphQL */ `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }
    `
    const data = await this.gql<{ commentCreate: { comment: { id: string } } }>(mutation, {
      input: { issueId, body },
    })
    return data.commentCreate.comment.id
  }

  /** Update an existing comment's body in place. */
  async updateComment(commentId: string, body: string): Promise<void> {
    const mutation = /* GraphQL */ `
      mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success }
      }
    `
    await this.gql(mutation, { id: commentId, input: { body } })
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_GRAPHQL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.authHeader,
      },
      body: JSON.stringify({ query, variables }),
    })
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
