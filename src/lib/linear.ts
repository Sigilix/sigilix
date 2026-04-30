// Linear GraphQL client — only the operations the triage path needs.
// Replaces the GitHub Issues API + Project board GraphQL surface from
// the Node daemon. The cross-repo project-write vulnerability class
// disappears here because Linear's API token is workspace-scoped, and
// every call is an explicit issue or comment update rather than a
// project-level field write.

const LINEAR_GRAPHQL = "https://api.linear.app/graphql"

interface LinearIssue {
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

interface IssueLabel {
  id: string
  name: string
}

export class LinearClient {
  constructor(private readonly apiKey: string) {}

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

  /** Resolve label NAMES to IDs for the given team. Linear requires IDs on update. */
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
    const all = data.team?.labels.nodes ?? []
    const wanted = new Set(names.map((n) => n.toLowerCase()))
    return all.filter((l) => wanted.has(l.name.toLowerCase())).map((l) => l.id)
  }

  /** Update issue priority, estimate, and add labels. All fields optional. */
  async updateIssue(
    issueId: string,
    fields: {
      priority?: number
      estimate?: number
      labelIds?: string[]
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
        authorization: this.apiKey,
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
