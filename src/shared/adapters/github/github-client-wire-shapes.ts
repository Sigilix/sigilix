// SIG-318 / SIG-387: the private wire-narrowing interfaces for the GitHub
// client, extracted from client.ts. These describe the raw REST/GraphQL
// response envelopes the client narrows from; they're implementation detail,
// not part of the public DTO surface (those live in `src/shared/types/github.ts`).
// client.ts type-imports them; nothing else should.

/**
 * SIG-98 — GraphQL response shape for `listPullRequestReviewThreads`.
 * Kept internal — callers consume the flat array returned by the
 * client method instead of the nested GraphQL envelope.
 */
export interface GraphQLReviewThreadsPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
        nodes?: Array<{
          id: string
          isResolved?: boolean
          comments?: {
            nodes?: Array<{ databaseId?: number | null; author?: { login?: string } | null }>
          }
        }>
      }
    }
  }
}

export interface RawListOpenPullsItem {
  number?: number
  title?: string
  user?: { login?: string } | null
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null
  updated_at?: string
}

export interface RawPrFile {
  filename?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
}

export interface RawCommit {
  sha: string
  commit?: { message?: string }
}

export interface ContentsResponse {
  type?: string
  encoding?: string
  content?: string
  size?: number
}

export interface RawWorkflowRun {
  id?: number
  head_sha?: string
  status?: string
  conclusion?: string | null
  created_at?: string
}

export interface RawWorkflowArtifact {
  id?: number
  name?: string
  size_in_bytes?: number
  expired?: boolean
}
