// KV-backed marker storage. Replaces the file-on-disk poll-state.json the
// Node daemon used. Keyed by issue identifier so retriggered webhooks
// (Linear retries on 5xx) update the existing comment instead of duplicating.

interface MarkerRecord {
  commentId: string
  triagedAt: number
}

export async function getMarker(
  kv: KVNamespace,
  issueId: string
): Promise<MarkerRecord | null> {
  const raw = await kv.get(`triage:${issueId}`, "json")
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Partial<MarkerRecord>
  if (typeof obj.commentId !== "string" || typeof obj.triagedAt !== "number") return null
  return { commentId: obj.commentId, triagedAt: obj.triagedAt }
}

export async function setMarker(
  kv: KVNamespace,
  issueId: string,
  commentId: string
): Promise<void> {
  const record: MarkerRecord = { commentId, triagedAt: Date.now() }
  await kv.put(`triage:${issueId}`, JSON.stringify(record))
}
