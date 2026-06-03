# Automatic Codebase Indexing

Sigilix indexes your repository automatically. There is **no manual step** —
no script to run, no operator to email, no config to edit. Installing the
GitHub App is all that's required for codebase-aware reviews.

This page explains what happens, when, and what you'll see.

## What happens on install

When you install the Sigilix GitHub App (or add a new repository to an
existing installation), Sigilix automatically:

1. Enqueues a background indexing job for each added repository.
2. Walks your default branch, chunks the indexable source files, embeds them,
   and stores the vectors in an isolated per-repository namespace.
3. Marks the repository "ready" once indexing completes.

Indexing is **asynchronous** — for a large repository it can take a few
minutes. You don't have to wait for it or do anything to trigger it.

## Your first pull request (cold start)

If you open a pull request before the initial index has finished, Sigilix
still reviews it — it just won't have full codebase context yet. You'll see a
sticky comment:

> Sigilix is warming up its index for this repo. Your next push will get a
> full codebase-aware review.

That first review is **diff-only**: the specialists see your changes but not
the surrounding codebase. As soon as indexing completes, Sigilix
**automatically re-runs** the full multi-specialist review on any open PRs
opened during the warm-up window and updates the sticky comment to:

> Index ready — see the full review below.

You don't need to push again or re-request a review — the upgrade happens on
its own.

## Keeping the index fresh

Sigilix refreshes the index automatically:

- **Push to your default branch** triggers an incremental re-index — only the
  added, modified, and removed files are updated, so refreshes are fast.
- Long-lived integration branches (`dev`, `develop`, `development`,
  `staging`, `stage`) and active PR branches are kept current too.

Sigilix intentionally does **not** re-index on every commit to every branch —
that's needless churn. Default-branch pushes are the source of truth for the
shared index.

## Uninstalling — your data is deleted

Removing a repository from the installation, or uninstalling the app entirely,
**deletes that repository's index and all associated data** — the Vectorize
namespace and the internal bookkeeping keys are purged. This is automatic and
covers our GDPR / SOC 2 data-deletion commitments. Sigilix stores embeddings,
not your raw source code, and nothing is retained after uninstall.

## What gets indexed

Source files matching Sigilix's indexable-extension allowlist are indexed;
vendored directories, build output, and binary assets are skipped. Each
repository's vectors live in their own namespace in the shared index, isolated
from every other customer's data.

## Privacy summary

- **Embeddings only** — Sigilix does not retain your raw code on its servers
  after indexing.
- **Per-repository isolation** — your vectors are scoped to your repository's
  namespace.
- **Deletion on uninstall** — removing the app removes your data.

## Operators / self-hosting

The above is fully automatic for installed customers. Operators running their
own deployment can also trigger a one-off (re)index for a repo that predates
the Worker indexer via the authenticated admin route — see the indexing
section of the top-level `README.md`.
