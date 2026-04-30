#!/usr/bin/env node
// Local CLI to index a repository into the openclaw Vectorize index.
//
//   node scripts/index-repo.mjs <repo-dir> [--namespace=<name>] [--dry-run]
//
// Walks the repo, chunks files into overlapping line windows, embeds each
// chunk via Cloudflare Workers AI (@cf/baai/bge-base-en-v1.5, 768 dims) over
// the REST API, then upserts the vectors into the openclaw-code-index
// Vectorize binding via wrangler. The same model is used at query time
// inside the Worker (src/lib/embeddings.ts) — keep them aligned.
//
// Auth:
//   CLOUDFLARE_ACCOUNT_ID   — the account that owns the Vectorize index
//   CLOUDFLARE_API_TOKEN    — token with Workers AI Read + Vectorize Write
//
// Configurable knobs match the rema-portal indexer (chunk size 30 lines
// instead of 80, because BGE base has only 512 token context vs.
// nomic-embed-text's 8192).

import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { resolve, relative, join, basename } from "node:path"
import { createHash } from "node:crypto"

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "dist",
  "build",
  "coverage",
  "target",
  ".openclaw",
  ".claude",
  ".turbo",
  ".cache",
  "out",
])

const INDEXED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".jsx",
  ".rs",
  ".sql",
  ".md",
  ".py",
  ".go",
  ".toml",
])

const MAX_FILE_BYTES = 200 * 1024
// 30-line windows + 10-line overlap. BGE base v1.5 has a 512-token context
// (~2_000 chars at 4 chars/token), so chunks need to be smaller than the
// rema-portal indexer's 80-line windows. Anything larger and the embedder
// silently truncates the tail, producing degraded retrieval quality.
const CHUNK_LINES = 30
const CHUNK_OVERLAP = 10
const MAX_CHUNK_CHARS = 1_800
const EMBED_BATCH = 16
const UPSERT_BATCH = 100

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"
const INDEX_NAME = "openclaw-code-index"

function parseArgs(argv) {
  const args = { repoDir: null, namespace: null, dryRun: false }
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true
    else if (arg.startsWith("--namespace=")) args.namespace = arg.slice("--namespace=".length)
    else if (!arg.startsWith("--")) args.repoDir = arg
  }
  return args
}

async function* walkRepo(root) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith(".") && entry.name !== ".github") continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf(".")
      if (dot < 0) continue
      const ext = entry.name.slice(dot)
      if (!INDEXED_EXTENSIONS.has(ext)) continue
      try {
        const info = await stat(full)
        if (info.size > MAX_FILE_BYTES) continue
        yield {
          path: relative(root, full),
          ext,
          size: info.size,
        }
      } catch {
        // skip
      }
    }
  }
}

function chunkFile(path, content) {
  const lines = content.split("\n")
  if (lines.length === 0) return []
  const chunks = []
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length)
    const slice = lines.slice(start, end).join("\n")
    if (slice.trim().length === 0) {
      if (end === lines.length) break
      continue
    }
    if (slice.length > MAX_CHUNK_CHARS) {
      if (end === lines.length) break
      continue
    }
    chunks.push({
      path,
      lineStart: start + 1,
      lineEnd: end,
      content: slice,
    })
    if (end === lines.length) break
  }
  return chunks
}

async function embedBatch(batch, accountId, apiToken) {
  // Cloudflare Workers AI REST endpoint:
  // POST /accounts/{id}/ai/run/@cf/baai/bge-base-en-v1.5
  // body: { text: string[] } returns { result: { data: number[][] } }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ text: batch.map((c) => c.content) }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cloudflare AI HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = await res.json()
  const data = json?.result?.data
  if (!Array.isArray(data) || data.length !== batch.length) {
    throw new Error(`Unexpected AI response shape: ${JSON.stringify(json).slice(0, 500)}`)
  }
  return batch.map((chunk, i) => ({ ...chunk, vector: data[i] }))
}

function chunkId(namespace, chunk) {
  // Stable per-chunk ID. SHA-256 keeps it under Vectorize's 64-char id limit.
  const raw = `${namespace}\0${chunk.path}\0${chunk.lineStart}\0${chunk.lineEnd}\0${chunk.content}`
  return createHash("sha256").update(raw).digest("hex").slice(0, 48)
}

async function upsertBatch(records, namespace, dryRun) {
  if (records.length === 0) return
  // Vectorize expects NDJSON via wrangler upsert. Build an NDJSON string,
  // pipe to wrangler vectorize upsert. For dry-runs just print sizes.
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        id: chunkId(namespace, r),
        values: r.vector,
        namespace,
        metadata: {
          repo: namespace,
          path: r.path,
          lineStart: r.lineStart,
          lineEnd: r.lineEnd,
          content: r.content,
        },
      })
    )
    .join("\n")
  if (dryRun) {
    console.log(
      `  [dry-run] would upsert ${records.length} vectors to namespace=${namespace}, ndjson=${(ndjson.length / 1024).toFixed(1)}KB`
    )
    return
  }
  const tmp = `/tmp/openclaw-upsert-${Date.now()}-${process.pid}.ndjson`
  await writeFile(tmp, ndjson)
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync(
    "npx",
    ["wrangler", "vectorize", "upsert", INDEX_NAME, "--file", tmp, "--batch-size", "100"],
    { stdio: "inherit" }
  )
  if (result.status !== 0) {
    throw new Error(`wrangler vectorize upsert exited with ${result.status}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.repoDir) {
    console.error("Usage: node scripts/index-repo.mjs <repo-dir> [--namespace=<name>] [--dry-run]")
    process.exit(2)
  }

  const repoDir = resolve(args.repoDir)
  const namespace = (args.namespace ?? basename(repoDir)).toLowerCase()
  console.log(`Indexing ${repoDir} → namespace="${namespace}"${args.dryRun ? " (dry-run)" : ""}`)

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!args.dryRun && (!accountId || !apiToken)) {
    console.error("error: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars required")
    process.exit(2)
  }

  // Walk + chunk first so we get a total count for progress reporting.
  const allChunks = []
  for await (const file of walkRepo(repoDir)) {
    let content
    try {
      content = await readFile(join(repoDir, file.path), "utf8")
    } catch {
      continue
    }
    const chunks = chunkFile(file.path, content)
    allChunks.push(...chunks)
  }
  console.log(`Walked ${repoDir}: ${allChunks.length} chunks`)
  if (allChunks.length === 0) {
    console.log("Nothing to index.")
    return
  }

  // Embed in batches. Workers AI rate limits aren't documented for the
  // REST endpoint but small batches are reliable and easy to retry on
  // failure.
  const embedded = []
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH)
    if (args.dryRun) {
      console.log(`  [dry-run] embed batch ${i / EMBED_BATCH + 1} (${batch.length} chunks)`)
      embedded.push(...batch.map((c) => ({ ...c, vector: new Array(768).fill(0) })))
      continue
    }
    const result = await embedBatch(batch, accountId, apiToken)
    embedded.push(...result)
    if ((embedded.length / 100) | 0 !== (((embedded.length - batch.length) / 100) | 0)) {
      console.log(`  embedded ${embedded.length}/${allChunks.length}`)
    }
  }

  // Upsert in larger batches.
  for (let i = 0; i < embedded.length; i += UPSERT_BATCH) {
    const batch = embedded.slice(i, i + UPSERT_BATCH)
    await upsertBatch(batch, namespace, args.dryRun)
    console.log(`  upserted ${Math.min(i + batch.length, embedded.length)}/${embedded.length}`)
  }

  console.log(`Done. ${embedded.length} chunks indexed to namespace="${namespace}".`)
}

main().catch((error) => {
  console.error("indexer failed:", error)
  process.exit(1)
})
