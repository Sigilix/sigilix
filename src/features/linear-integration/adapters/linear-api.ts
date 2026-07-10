export interface LinearWorkspaceIdentity {
  organization: { id: string; name: string }
  viewer: { id: string; name: string; displayName: string | null; app: boolean }
  teams: Array<{ id: string; key: string; name: string }>
}

interface GraphQlResponse {
  data?: {
    organization?: { id?: unknown; name?: unknown }
    viewer?: { id?: unknown; name?: unknown; displayName?: unknown; app?: unknown }
    teams?: {
      nodes?: Array<{ id?: unknown; key?: unknown; name?: unknown }>
      pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }
    }
  }
  errors?: unknown
}

const ENDPOINT = "https://api.linear.app/graphql"
const MAX_TEAM_PAGES = 20

/**
 * Read the immutable organization, OAuth actor, and every team visible to the
 * freshly-issued actor token. Any malformed/truncated response fails closed;
 * callers must not persist an install or scope from a partial access snapshot.
 */
export async function fetchLinearWorkspaceIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearWorkspaceIdentity | null> {
  const teams: LinearWorkspaceIdentity["teams"] = []
  let after: string | null = null
  let organization: LinearWorkspaceIdentity["organization"] | null = null
  let viewer: LinearWorkspaceIdentity["viewer"] | null = null

  for (let page = 0; page < MAX_TEAM_PAGES; page++) {
    let response: Response
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          query: /* GraphQL */ `
            query SigilixLinearInstallContext($after: String) {
              organization {
                id
                name
              }
              viewer {
                id
                name
                displayName
                app
              }
              teams(first: 100, after: $after) {
                nodes {
                  id
                  key
                  name
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `,
          variables: { after },
        }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      return null
    }
    if (!response.ok) return null
    let body: GraphQlResponse
    try {
      body = (await response.json()) as GraphQlResponse
    } catch {
      return null
    }
    if (body.errors || !body.data) return null
    const org = body.data.organization
    const actor = body.data.viewer
    const connection = body.data.teams
    if (
      !org ||
      typeof org.id !== "string" ||
      !org.id ||
      typeof org.name !== "string" ||
      !actor ||
      typeof actor.id !== "string" ||
      !actor.id ||
      typeof actor.name !== "string" ||
      typeof actor.app !== "boolean" ||
      !connection ||
      !Array.isArray(connection.nodes)
    ) {
      return null
    }
    const thisOrg = { id: org.id, name: org.name }
    const thisViewer = {
      id: actor.id,
      name: actor.name,
      displayName: typeof actor.displayName === "string" ? actor.displayName : null,
      app: actor.app,
    }
    if (
      (organization && organization.id !== thisOrg.id) ||
      (viewer && (viewer.id !== thisViewer.id || viewer.app !== thisViewer.app))
    ) {
      return null
    }
    organization = thisOrg
    viewer = thisViewer
    for (const team of connection.nodes) {
      if (typeof team.id !== "string" || !team.id || typeof team.key !== "string" || typeof team.name !== "string") {
        return null
      }
      teams.push({ id: team.id, key: team.key, name: team.name })
    }
    const hasNext = connection.pageInfo?.hasNextPage === true
    if (!hasNext) {
      const deduped = new Map(teams.map((team) => [team.id, team]))
      return organization && viewer ? { organization, viewer, teams: [...deduped.values()] } : null
    }
    const cursor = connection.pageInfo?.endCursor
    if (typeof cursor !== "string" || !cursor) return null
    after = cursor
  }
  return null
}
