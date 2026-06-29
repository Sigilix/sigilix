/**
 * Opens a GitHub pull request via the REST API.
 *
 * TOKEN SAFETY: the token goes only into the Authorization header.
 * It is never written to any log or included in a thrown error message.
 */

export interface OpenPullRequestArgs {
  owner: string;
  repo: string;
  /** GitHub App installation token (short-lived, never logged). */
  token: string;
  /** Source branch (e.g. "sigilix/SIG-123"). */
  head: string;
  /** Target branch (e.g. "main"). */
  base: string;
  title: string;
  body: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
}

export async function openPullRequest(
  args: OpenPullRequestArgs,
): Promise<PullRequestResult> {
  const { owner, repo, token, head, base, title, body } = args;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "sigilix-agent-runner/1",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, head, base, body }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    // Redact the token from the response body just in case it appears there
    const safe = token ? text.split(token).join("***") : text;
    throw new Error(`GitHub API ${resp.status}: ${safe}`);
  }

  const data = (await resp.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}
