// SIG-363 (PR 11) — the retrieval adapter (adapters layer): implements
// `RetrievalPort` by forwarding to the `lib` retrieval helpers, closing over
// `env` so the port methods stay env-free.
//
// DOCUMENTED LATERALS: `../../retrieval` and `../../multi-corpus` are `lib`
// siblings, not adapters — they stay in `lib` because the mention-reply / CI
// triage paths share `retrieveChunks` (and the corpus retrieval). The port's
// mirror result types (`RetrievedChunk` / `MultiCorpusResult`) are declared
// field-for-field on the port and are mutually-assignable with the lib types, so
// the forwarded results satisfy the port with no cast. Dormant seam — PR 12 wires it.

import type { Env } from "@/shared/types/env"
import type { RetrievalPort } from "../ports/retrieval"
import { retrieveChunks } from "../../retrieval"
import { retrieveMultiCorpus } from "../../multi-corpus"

export function makeRetrievalAdapter(env: Env): RetrievalPort {
  return {
    retrieveChunks(args) {
      return retrieveChunks({ text: args.text, teamKey: args.teamKey, env })
    },
    retrieveMultiCorpus(owner, repo, queryText, opts) {
      return retrieveMultiCorpus(env, owner, repo, queryText, opts)
    },
  }
}
