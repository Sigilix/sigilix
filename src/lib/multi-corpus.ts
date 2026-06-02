// SIG-44 — multi-corpus retrieval: index prior merged PRs and Linear issues
// alongside code, then query all three corpora at review time.
//
// Today Sigilix retrieves only code chunks, so it can never say "this looks
// like the same regression we fixed in PR #234" or "this contradicts the
// decision in ARC-42". This module adds two sibling Vectorize namespaces to
// the existing per-repo code namespace:
//
//   <owner>/<repo>        code chunks            (existing — indexer.ts)
//   pr:<owner>/<repo>     merged-PR title/body + final synthesizer verdict
//   issue:<owner>/<repo>  Linear issue title/description (Linear-linked repos)
//
// At review time we query all three in parallel, merge the top-K, and render
// labeled snippet blocks the specialists can cite. The namespaces are plain
// prefixes on the code namespace (well under Vectorize's 64-byte cap) and
// reuse the same 768-dim bge-base embeddings, so a PR/issue vector is
// directly comparable to the query vector.

import { indexNamespace } from "./repo-index-manifest"
import { embedText } from "./embeddings"

// ---------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------

export const PR_NAMESPACE_PREFIX = "pr:"
export const ISSUE_NAMESPACE_PREFIX = "issue:"

/** Vectorize namespace for a repo's merged-PR corpus. */
export function prNamespace(owner: string, repo: string): string {
  return `${PR_NAMESPACE_PREFIX}${indexNamespace(owner, repo)}`
}

/** Vectorize namespace for a repo's Linear-issue corpus. */
export function issueNamespace(owner: string, repo: string): string {
  return `${ISSUE_NAMESPACE_PREFIX}${indexNamespace(owner, repo)}`
}

// ---------------------------------------------------------------------
// Minimal Vectorize / AI surface (mirrors retrieval.ts so this module is
// independently testable with a stub).
// ---------------------------------------------------------------------

interface VectorizeMatch {
  id: string
  score: number
  metadata?: Record<string, unknown>
}

interface VectorizeIndex {
  query(
    vector: number[],
    options: { topK?: number; namespace?: string; returnMetadata?: "all" | "indexed" },
  ): Promise<{ matches: VectorizeMatch[] }>
  upsert(records: ReadonlyArray<{
    id: string
    values: number[]
    namespace: string
    metadata: Record<string, string | number>
  }>): Promise<unknown>
}

interface AiBinding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][] }>
}

export interface MultiCorpusEnv {
  AI: AiBinding
  OPENCLAW_CODE_INDEX: VectorizeIndex
}

// ---------------------------------------------------------------------
// Corpus documents
// ---------------------------------------------------------------------

export interface PrCorpusDoc {
  owner: string
  repo: string
  number: number
  title: string
  /** PR body / description (may be empty). */
  body: string
  /** Final synthesizer verdict of the merged PR's review, if one ran. */
  verdict?: string
}

export interface IssueCorpusDoc {
  owner: string
  repo: string
  /** Human identifier, e.g. "ARC-42". */
  identifier: string
  title: string
  description: string
  /** Workflow state name, e.g. "Done". */
  status?: string
}

const MAX_EMBED_CHARS = 3_500

/**
 * Build the text we embed for a merged PR. Title leads (it's the densest
 * signal), then a bounded body excerpt, then the verdict so a query about a
 * risky change can surface "this is the kind of change that got
 * changes_required last time".
 */
export function buildPrCorpusText(doc: PrCorpusDoc): string {
  const parts = [`PR #${doc.number}: ${doc.title}`]
  if (doc.body.trim()) parts.push(doc.body.trim())
  if (doc.verdict?.trim()) parts.push(`Verdict: ${doc.verdict.trim()}`)
  return parts.join("\n").slice(0, MAX_EMBED_CHARS)
}

/** Build the text we embed for a Linear issue. */
export function buildIssueCorpusText(doc: IssueCorpusDoc): string {
  const parts = [`${doc.identifier}: ${doc.title}`]
  if (doc.description.trim()) parts.push(doc.description.trim())
  return parts.join("\n").slice(0, MAX_EMBED_CHARS)
}

/**
 * Stable, namespace-scoped vector id for a corpus doc. PRs key on the PR
 * number, issues on the Linear identifier — both immutable within a repo —
 * so re-embedding an updated PR/issue overwrites rather than duplicates.
 */
export function prDocId(doc: Pick<PrCorpusDoc, "number">): string {
  return `pr-${doc.number}`
}
export function issueDocId(doc: Pick<IssueCorpusDoc, "identifier">): string {
  return `issue-${doc.identifier.toLowerCase()}`
}

// ---------------------------------------------------------------------
// Write path (used by the merge/backfill/webhook refresh consumers)
// ---------------------------------------------------------------------

/**
 * Embed + upsert a single merged-PR doc into the `pr:` namespace. Returns
 * false (logs) on any failure — corpus refresh is a soft enhancement; a
 * failed PR embed must never fail the merge webhook or the code index.
 */
export async function upsertPrDoc(env: MultiCorpusEnv, doc: PrCorpusDoc): Promise<boolean> {
  try {
    const text = buildPrCorpusText(doc)
    const values = await embedText(env.AI, text)
    await env.OPENCLAW_CODE_INDEX.upsert([{
      id: prDocId(doc),
      values,
      namespace: prNamespace(doc.owner, doc.repo),
      metadata: {
        kind: "pr",
        ref: `#${doc.number}`,
        title: doc.title,
        verdict: doc.verdict ?? "",
        content: text,
      },
    }])
    return true
  } catch (error) {
    console.warn(JSON.stringify({
      event: "multicorpus-pr-upsert-failed",
      owner: doc.owner, repo: doc.repo, number: doc.number,
      err: error instanceof Error ? error.message : String(error),
    }))
    return false
  }
}

/** Embed + upsert a single Linear-issue doc into the `issue:` namespace. */
export async function upsertIssueDoc(env: MultiCorpusEnv, doc: IssueCorpusDoc): Promise<boolean> {
  try {
    const text = buildIssueCorpusText(doc)
    const values = await embedText(env.AI, text)
    await env.OPENCLAW_CODE_INDEX.upsert([{
      id: issueDocId(doc),
      values,
      namespace: issueNamespace(doc.owner, doc.repo),
      metadata: {
        kind: "issue",
        ref: doc.identifier,
        title: doc.title,
        status: doc.status ?? "",
        content: text,
      },
    }])
    return true
  } catch (error) {
    console.warn(JSON.stringify({
      event: "multicorpus-issue-upsert-failed",
      owner: doc.owner, repo: doc.repo, identifier: doc.identifier,
      err: error instanceof Error ? error.message : String(error),
    }))
    return false
  }
}

// ---------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------

export interface CorpusHit {
  kind: "pr" | "issue"
  /** "#234" for a PR, "ARC-42" for an issue. */
  ref: string
  /** Verdict (PR) or status (issue) for the labeled prompt block. */
  label: string
  content: string
  score: number
}

export interface MultiCorpusResult {
  pr: CorpusHit[]
  issue: CorpusHit[]
}

const CORPUS_TOP_K = 3

/**
 * Query the `pr:` and `issue:` namespaces in parallel for the review query.
 * Each leg soft-fails to [] so a missing/empty corpus (e.g. a repo with no
 * Linear link) never blocks the others or the code retrieval. Emits the
 * `pr-review-retrieval-multicorpus` telemetry with per-namespace hit counts.
 */
export async function retrieveMultiCorpus(
  env: MultiCorpusEnv,
  owner: string,
  repo: string,
  queryText: string,
  opts: { topK?: number; prNumber?: number; headSha?: string } = {},
): Promise<MultiCorpusResult> {
  const trimmed = queryText.trim()
  if (!trimmed) return { pr: [], issue: [] }
  const topK = opts.topK ?? CORPUS_TOP_K

  let queryVector: number[]
  try {
    queryVector = await embedText(env.AI, trimmed.slice(0, 4_000))
  } catch (error) {
    console.warn(JSON.stringify({
      event: "multicorpus-embed-failed",
      owner, repo, err: error instanceof Error ? error.message : String(error),
    }))
    return { pr: [], issue: [] }
  }

  const [pr, issue] = await Promise.all([
    queryCorpus(env, prNamespace(owner, repo), queryVector, topK, "pr"),
    queryCorpus(env, issueNamespace(owner, repo), queryVector, topK, "issue"),
  ])

  console.log(JSON.stringify({
    event: "pr-review-retrieval-multicorpus",
    owner, repo,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
    namespaces: {
      pr: { matches: pr.length, topScore: pr[0]?.score ?? null },
      issue: { matches: issue.length, topScore: issue[0]?.score ?? null },
    },
  }))

  return { pr, issue }
}

async function queryCorpus(
  env: MultiCorpusEnv,
  namespace: string,
  vector: number[],
  topK: number,
  kind: "pr" | "issue",
): Promise<CorpusHit[]> {
  let res: { matches: VectorizeMatch[] }
  try {
    res = await env.OPENCLAW_CODE_INDEX.query(vector, { topK, namespace, returnMetadata: "all" })
  } catch (error) {
    console.warn(JSON.stringify({
      event: "multicorpus-query-failed",
      namespace, err: error instanceof Error ? error.message : String(error),
    }))
    return []
  }
  const out: CorpusHit[] = []
  for (const m of res.matches ?? []) {
    const md = m.metadata
    if (!md || typeof md.content !== "string" || typeof md.ref !== "string") continue
    const label = kind === "pr"
      ? (typeof md.verdict === "string" ? md.verdict : "")
      : (typeof md.status === "string" ? md.status : "")
    out.push({ kind, ref: md.ref, label, content: md.content, score: m.score })
  }
  return out
}

// ---------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------

const MAX_BLOCK_CHARS = 1_500
const MAX_TOTAL_CHARS = 6_000

/**
 * Render PR/issue hits into labeled blocks the specialist prompts can cite,
 * e.g. `--- past PR #234 (verdict: changes_required) ---`. Returns null when
 * there's nothing to inject so callers skip the section cleanly. Bounded per
 * block and overall so the multi-corpus context can't crowd out code chunks.
 */
export function formatMultiCorpusForPrompt(result: MultiCorpusResult): string | null {
  const blocks: string[] = []
  let total = 0
  for (const h of [...result.pr, ...result.issue]) {
    const header = h.kind === "pr"
      ? `--- past PR ${h.ref}${h.label ? ` (verdict: ${h.label})` : ""} ---`
      : `--- Linear issue ${h.ref}${h.label ? ` (status: ${h.label})` : ""} ---`
    const body = h.content.length > MAX_BLOCK_CHARS ? h.content.slice(0, MAX_BLOCK_CHARS) : h.content
    const block = `${header}\n${body}`
    if (total + block.length > MAX_TOTAL_CHARS) break
    blocks.push(block)
    total += block.length
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null
}
