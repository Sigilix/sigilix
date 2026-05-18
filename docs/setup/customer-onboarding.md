# Customer Onboarding — Required GitHub Repo Settings

After installing the Sigilix GitHub App on your repo, configure one
required branch-protection setting so stale reviews are auto-dismissed
with clean GitHub-native UI attribution:

1. Repo Settings → Branches → Add a branch protection rule for your
   default branch (or edit the existing rule).
2. Check **"Dismiss stale pull request approvals when new commits are
   pushed"**.

Why: when a new commit lands on a PR, GitHub auto-dismisses prior
reviews and attributes the dismissal to the commit pusher (e.g.
`<user> dismissed sigilix[bot]'s stale review via <sha>`). Without
this setting, prior Sigilix reviews stay as "Changes Requested" until
you manually dismiss them.
